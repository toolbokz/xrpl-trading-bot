/**
 * Hard Risk Guard — Capital Protection Mode
 *
 * Provides deterministic, fail-safe risk gating for execution.
 * Blocks execution when ANY capital, exposure, or system safety limit
 * is breached. Designed to sit INSIDE the executionAllowed decision
 * without rewriting the existing execution gate or risk engine.
 *
 * Block conditions (any TRUE → BLOCK):
 *   1. Exposure limit exceeded
 *   2. Inventory skew beyond threshold
 *   3. Max drawdown breached (only when drawdown confidence is high)
 *   4. Runtime FSM not READY
 *   5. Market data invalid
 *   6. Balances stale
 *   7. Feed degraded
 *
 * Events emitted (for observability):
 *   RISK_LIMIT_WARNING  — approaching threshold (>80%)
 *   RISK_LIMIT_BLOCK    — threshold breached
 *   RISK_LIMIT_RECOVERY — recovered after block
 *
 * Principle: prefer blocking execution over risking capital.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Possible risk states for the guard.
 */
export type HardRiskState = 'CLEAR' | 'WARNING' | 'BLOCKED';

/**
 * Canonical reasons execution can be blocked.
 */
export type HardRiskBlockReason =
    | 'exposure-limit-exceeded'
    | 'inventory-skew-exceeded'
    | 'drawdown-breached'
    | 'runtime-not-ready'
    | 'market-data-invalid'
    | 'balances-stale'
    | 'feed-degraded';

/**
 * Risk event types emitted for observability.
 */
export type HardRiskEventType =
    | 'RISK_LIMIT_WARNING'
    | 'RISK_LIMIT_BLOCK'
    | 'RISK_LIMIT_RECOVERY';

/**
 * Structured risk event for logging / observability.
 */
export interface HardRiskEvent {
    type: HardRiskEventType;
    pairKey: string;
    reasons: HardRiskBlockReason[];
    metrics: HardRiskMetrics;
    timestamp: number;
}

/**
 * Current risk metrics snapshot.
 */
export interface HardRiskMetrics {
    /** Current notional exposure in quote currency. */
    currentExposureNotional: number;
    /** Inventory skew percentage (−100 to +100). */
    inventorySkewPct: number;
    /** Current drawdown percentage (0–100). */
    drawdownPct: number;
    /** Whether drawdown is confidence-qualified for hard blocking. */
    drawdownConfidence: boolean;
    /** Trades backing the rolling drawdown estimate. */
    tradesCount: number;
    /** Rolling equity peak used to compute drawdown. */
    peakEquity: number;
    /** Current rolling equity value. */
    equityNow: number;
    /** Whether the runtime FSM is READY. */
    runtimeReady: boolean;
    /** Whether market data is valid. */
    marketDataValid: boolean;
    /** Whether balances are fresh. */
    balancesFresh: boolean;
    /** Whether feeds are healthy. */
    feedHealthy: boolean;
}

/**
 * Evaluation result from the hard risk guard.
 */
export interface HardRiskResult {
    /** Aggregate risk state. */
    riskState: HardRiskState;
    /** Block reasons (empty when CLEAR). */
    riskBlockReasons: HardRiskBlockReason[];
    /** Warning reasons (approaching thresholds). */
    warningReasons: HardRiskBlockReason[];
    /** Snapshot of all risk metrics at evaluation time. */
    metrics: HardRiskMetrics;
    /** Whether execution should be allowed. */
    executionAllowed: boolean;
    /** Evaluation timestamp (ms epoch). */
    evaluatedAt: number;
}

/**
 * Full payload for the risk API endpoint.
 */
export interface HardRiskPayload {
    /** Active pair key. */
    pairKey: string;
    /** Current evaluation result. */
    result: HardRiskResult;
    /** Config thresholds (for dashboard display). */
    thresholds: HardRiskConfig;
    /** Events since last reset (ring buffer). */
    recentEvents: HardRiskEvent[];
}

/**
 * Configuration for hard risk thresholds.
 * All have safe defaults.
 */
export interface HardRiskConfig {
    /** Max notional exposure before block (default: 5000). */
    maxExposureNotional: number;
    /** Max absolute inventory skew percentage before block (default: 80). */
    maxInventorySkewPct: number;
    /** Max drawdown percentage before block (default: 7). */
    maxDrawdownPct: number;
    /** Minimum trades required before drawdown can hard-block (default: 50). */
    minTradesForDrawdown: number;
    /** Minimum peak equity required before drawdown can hard-block (default: 1.0). */
    minPeakEquityForDrawdown: number;
    /** Max balance staleness before block (ms, default: 120 000). */
    maxBalanceStalenessMs: number;
    /** Minimum health score for feed health (default: 40). */
    minFeedHealthScore: number;
    /** Warning threshold ratio (0–1) — warn when metric exceeds this fraction of limit (default: 0.8). */
    warningThresholdRatio: number;
    /** Max events to keep in the ring buffer (default: 100). */
    maxEvents: number;
}

const DEFAULT_CONFIG: HardRiskConfig = {
    maxExposureNotional: 5_000,
    maxInventorySkewPct: 80,
    maxDrawdownPct: 7,
    minTradesForDrawdown: 50,
    minPeakEquityForDrawdown: 1.0,
    maxBalanceStalenessMs: 120_000,
    minFeedHealthScore: 40,
    warningThresholdRatio: 0.8,
    maxEvents: 100,
};

/**
 * Input snapshot for the guard — gathered from runtime state each tick.
 */
export interface HardRiskInput {
    /** Current notional exposure (sum of open position values). */
    currentExposureNotional: number;
    /** Inventory skew percentage (−100 to +100, 0 = balanced). */
    inventorySkewPct: number;
    /** Current rolling drawdown percentage (0–100). */
    drawdownPct: number;
    /** Number of trades backing rolling drawdown (optional; defaults to 0). */
    tradesCount?: number;
    /** Rolling peak equity used for drawdown (optional; defaults to 0). */
    peakEquity?: number;
    /** Current rolling equity (optional; defaults to 0). */
    equityNow?: number;
    /** Upstream confidence signal for drawdown validity (optional). */
    drawdownConfidence?: boolean;
    /** Whether the runtime FSM is in READY state. */
    runtimeReady: boolean;
    /** Whether the latest market data snapshot is structurally valid. */
    marketDataValid: boolean;
    /** Time since last balance snapshot (ms). */
    balanceStalenessMs: number;
    /** Current feed/market health score (0–100). */
    feedHealthScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard — pair-keyed risk evaluator with event emission
// ─────────────────────────────────────────────────────────────────────────────

export class HardRiskGuard {
    private readonly config: HardRiskConfig;
    private pairKey = '';
    private events: HardRiskEvent[] = [];
    private lastResult: HardRiskResult | null = null;
    private wasBlocked = false;

    constructor(config: Partial<HardRiskConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ─── Mutation ────────────────────────────────────────────────────────

    /** Set the active pair key. Called by TradingRuntime on pair switch. */
    setPairKey(pairKey: string): void {
        this.pairKey = pairKey;
    }

    /** Reset all state (on shutdown or test). */
    reset(): void {
        this.pairKey = '';
        this.events = [];
        this.lastResult = null;
        this.wasBlocked = false;
    }

    // ─── Evaluation ──────────────────────────────────────────────────────

    /**
     * Evaluate all hard risk conditions.
     *
     * Returns a deterministic result: CLEAR, WARNING, or BLOCKED.
     * When BLOCKED, executionAllowed = false.
     *
     * This is a pure function of the input + config — no side effects
     * except event recording for observability.
     */
    evaluate(input: HardRiskInput): HardRiskResult {
        const now = Date.now();
        const blockReasons: HardRiskBlockReason[] = [];
        const warningReasons: HardRiskBlockReason[] = [];
        const addWarning = (reason: HardRiskBlockReason): void => {
            if (!warningReasons.includes(reason)) {
                warningReasons.push(reason);
            }
        };

        const drawdownPct = Number.isFinite(input.drawdownPct) ? Math.max(0, input.drawdownPct) : 0;
        const tradesCount = Number.isFinite(input.tradesCount) ? Math.max(0, input.tradesCount ?? 0) : 0;
        const peakEquity = Number.isFinite(input.peakEquity) ? Math.max(0, input.peakEquity ?? 0) : 0;
        const equityNow = Number.isFinite(input.equityNow) ? (input.equityNow ?? 0) : 0;
        const drawdownConfidence = (input.drawdownConfidence ?? true)
            && tradesCount >= this.config.minTradesForDrawdown
            && peakEquity >= this.config.minPeakEquityForDrawdown;

        // ── 1. Exposure limit ────────────────────────────────────────────
        if (input.currentExposureNotional > this.config.maxExposureNotional) {
            blockReasons.push('exposure-limit-exceeded');
        } else if (input.currentExposureNotional > this.config.maxExposureNotional * this.config.warningThresholdRatio) {
            addWarning('exposure-limit-exceeded');
        }

        // ── 2. Inventory skew ────────────────────────────────────────────
        const absSkew = Math.abs(input.inventorySkewPct);
        if (absSkew > this.config.maxInventorySkewPct) {
            blockReasons.push('inventory-skew-exceeded');
        } else if (absSkew > this.config.maxInventorySkewPct * this.config.warningThresholdRatio) {
            addWarning('inventory-skew-exceeded');
        }

        // ── 3. Drawdown (confidence-gated) ──────────────────────────────
        if (drawdownPct > this.config.maxDrawdownPct) {
            if (drawdownConfidence) {
                blockReasons.push('drawdown-breached');
            } else {
                addWarning('drawdown-breached');
            }
        } else if (drawdownPct > this.config.maxDrawdownPct * this.config.warningThresholdRatio) {
            addWarning('drawdown-breached');
        }

        // ── 4. Runtime FSM not READY ────────────────────────────────────
        if (!input.runtimeReady) {
            blockReasons.push('runtime-not-ready');
        }

        // ── 5. Market data invalid ──────────────────────────────────────
        if (!input.marketDataValid) {
            blockReasons.push('market-data-invalid');
        }

        // ── 6. Balances stale ───────────────────────────────────────────
        if (input.balanceStalenessMs > this.config.maxBalanceStalenessMs) {
            blockReasons.push('balances-stale');
        } else if (input.balanceStalenessMs > this.config.maxBalanceStalenessMs * this.config.warningThresholdRatio) {
            addWarning('balances-stale');
        }

        // ── 7. Feed degraded ────────────────────────────────────────────
        if (input.feedHealthScore < this.config.minFeedHealthScore) {
            blockReasons.push('feed-degraded');
        } else if (input.feedHealthScore < this.config.minFeedHealthScore / this.config.warningThresholdRatio) {
            // Warning when score is between minFeedHealthScore and minFeedHealthScore / warningRatio
            addWarning('feed-degraded');
        }

        // ── Derive aggregate state ──────────────────────────────────────
        const isBlocked = blockReasons.length > 0;
        const hasWarnings = warningReasons.length > 0;
        const riskState: HardRiskState = isBlocked ? 'BLOCKED' : hasWarnings ? 'WARNING' : 'CLEAR';

        const metrics: HardRiskMetrics = {
            currentExposureNotional: input.currentExposureNotional,
            inventorySkewPct: input.inventorySkewPct,
            drawdownPct,
            drawdownConfidence,
            tradesCount,
            peakEquity,
            equityNow,
            runtimeReady: input.runtimeReady,
            marketDataValid: input.marketDataValid,
            balancesFresh: input.balanceStalenessMs <= this.config.maxBalanceStalenessMs,
            feedHealthy: input.feedHealthScore >= this.config.minFeedHealthScore,
        };

        const result: HardRiskResult = {
            riskState,
            riskBlockReasons: blockReasons,
            warningReasons,
            metrics,
            executionAllowed: !isBlocked,
            evaluatedAt: now,
        };

        // ── Event emission ──────────────────────────────────────────────
        this.emitEvents(result, metrics, now);

        this.lastResult = result;
        this.wasBlocked = isBlocked;

        return result;
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /** Get the last evaluation result. */
    getLastResult(): HardRiskResult | null {
        return this.lastResult;
    }

    /** Get the full payload for the API endpoint. */
    getPayload(): HardRiskPayload {
        return {
            pairKey: this.pairKey,
            result: this.lastResult ?? emptyResult(),
            thresholds: { ...this.config },
            recentEvents: [...this.events],
        };
    }

    /** Get recent events (newest first). */
    getRecentEvents(limit: number = 20): HardRiskEvent[] {
        return this.events.slice(-limit).reverse();
    }

    /** Get the current config (for testing / observability). */
    getConfig(): HardRiskConfig {
        return { ...this.config };
    }

    // ─── Internals ───────────────────────────────────────────────────────

    private emitEvents(
        result: HardRiskResult,
        metrics: HardRiskMetrics,
        now: number,
    ): void {
        // BLOCK event — on transition from non-blocked to blocked
        if (result.riskState === 'BLOCKED' && !this.wasBlocked) {
            this.pushEvent({
                type: 'RISK_LIMIT_BLOCK',
                pairKey: this.pairKey,
                reasons: result.riskBlockReasons,
                metrics,
                timestamp: now,
            });
        }

        // RECOVERY event — on transition from blocked to non-blocked
        if (result.riskState !== 'BLOCKED' && this.wasBlocked) {
            this.pushEvent({
                type: 'RISK_LIMIT_RECOVERY',
                pairKey: this.pairKey,
                reasons: [],
                metrics,
                timestamp: now,
            });
        }

        // WARNING event — on every WARNING evaluation (throttled by caller)
        if (result.riskState === 'WARNING') {
            this.pushEvent({
                type: 'RISK_LIMIT_WARNING',
                pairKey: this.pairKey,
                reasons: result.warningReasons,
                metrics,
                timestamp: now,
            });
        }
    }

    private pushEvent(event: HardRiskEvent): void {
        this.events.push(event);
        if (this.events.length > this.config.maxEvents) {
            this.events = this.events.slice(-this.config.maxEvents);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers
// ─────────────────────────────────────────────────────────────────────────────

function emptyResult(): HardRiskResult {
    return {
        riskState: 'CLEAR',
        riskBlockReasons: [],
        warningReasons: [],
        metrics: {
            currentExposureNotional: 0,
            inventorySkewPct: 0,
            drawdownPct: 0,
            drawdownConfidence: false,
            tradesCount: 0,
            peakEquity: 0,
            equityNow: 0,
            runtimeReady: false,
            marketDataValid: false,
            balancesFresh: false,
            feedHealthy: false,
        },
        executionAllowed: false,
        evaluatedAt: 0,
    };
}

/**
 * Load hard risk config from environment variables.
 */
export function loadHardRiskConfig(): Partial<HardRiskConfig> {
    const toNumber = (val: string | undefined): number | undefined => {
        if (val === undefined) return undefined;
        const parsed = Number(val);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const config: Partial<HardRiskConfig> = {};
    const maxExposure = toNumber(process.env.HARD_RISK_MAX_EXPOSURE);
    if (maxExposure !== undefined) config.maxExposureNotional = maxExposure;
    const maxSkew = toNumber(process.env.HARD_RISK_MAX_SKEW_PCT);
    if (maxSkew !== undefined) config.maxInventorySkewPct = maxSkew;
    const maxDD = toNumber(process.env.HARD_RISK_MAX_DRAWDOWN_PCT);
    if (maxDD !== undefined) config.maxDrawdownPct = maxDD;
    const minTradesForDrawdown = toNumber(process.env.HARD_RISK_MIN_TRADES_FOR_DRAWDOWN);
    if (minTradesForDrawdown !== undefined) config.minTradesForDrawdown = minTradesForDrawdown;
    const minPeakEquityForDrawdown = toNumber(process.env.HARD_RISK_MIN_PEAK_EQUITY);
    if (minPeakEquityForDrawdown !== undefined) config.minPeakEquityForDrawdown = minPeakEquityForDrawdown;
    const maxBalanceStale = toNumber(process.env.HARD_RISK_MAX_BALANCE_STALE_MS);
    if (maxBalanceStale !== undefined) config.maxBalanceStalenessMs = maxBalanceStale;
    const minFeedHealth = toNumber(process.env.HARD_RISK_MIN_FEED_HEALTH);
    if (minFeedHealth !== undefined) config.minFeedHealthScore = minFeedHealth;

    return config;
}
