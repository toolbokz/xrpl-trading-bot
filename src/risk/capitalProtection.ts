/**
 * Capital Protection Layer
 * 
 * Sits ABOVE all strategies to enforce account-level governance.
 * Prevents "death spirals" by pausing, throttling, or shutting down trading.
 * 
 * Deterministic, explainable, and safe by default.
 * Does not change strategy logic - only gates execution and adjusts sizing.
 */

import { feedbackEngine } from '../analytics/feedbackEngine';
import { RiskEngine } from './riskEngine';
import { logger } from '../analytics/logger';
import { FlowRegime } from '../market/flowMetrics';
import { computeProfitFactorCanonical } from '../analytics/metricUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Protection mode - determines execution policy
 */
export type ProtectionMode = 'ALLOW' | 'THROTTLE' | 'PAUSE' | 'SHUTDOWN';

/**
 * Rolling risk metrics computed from feedback engine
 */
export interface RollingRiskMetrics {
    /** Number of trades in lookback window */
    tradesCount: number;
    /** Profit factor (gross profit / gross loss) */
    profitFactor: number;
    /** Expectancy in basis points */
    expectancyBps: number;
    /** Maximum drawdown percentage (0-100) */
    drawdownPct: number;
    /** Whether drawdown is statistically meaningful for hard risk enforcement */
    drawdownConfidence?: boolean;
    /** Rolling equity peak used to compute drawdown */
    peakEquity?: number;
    /** Current rolling equity value */
    equityNow?: number;
    /** Average slippage in basis points */
    avgSlippageBps: number;
    /** Partial fill rate (0-1) */
    partialFillRate: number;
    /** Win rate (0-1) */
    winRate: number;
    /** Consecutive failures count */
    consecutiveFailures: number;
}

/**
 * Capital protection decision with all context for observability
 */
export interface CapitalProtectionDecision {
    /** Protection mode to apply */
    mode: ProtectionMode;
    /** Size multiplier to apply to all trades (0.0 - 1.0) */
    sizeMultiplier: number;
    /** Cooldown in milliseconds before next execution */
    cooldownMs: number;
    /** Strategies disabled by name (optional) */
    disabledStrategies?: string[];
    /** Regimes disabled (optional) */
    disabledRegimes?: FlowRegime[];
    /** Human-readable reasons for the decision */
    reasons: string[];
    /** Underlying metrics used for decision */
    metrics: RollingRiskMetrics;
    /** Timestamp of decision */
    timestamp: number;
}

/**
 * Capital protection configuration
 */
export interface CapitalProtectionConfig {
    /** Enable capital protection (default: true) */
    enabled: boolean;
    /** Number of trades to look back for metrics (default: 200) */
    lookbackTrades: number;
    /** Minimum trades required before enforcement (default: 50) */
    minTrades: number;
    /** Max rolling drawdown % before PAUSE/SHUTDOWN (default: 7) */
    maxRollingDrawdownPct: number;
    /** Minimum trades required before drawdown can hard-enforce PAUSE/SHUTDOWN (default: CP_MIN_TRADES). */
    minTradesForDrawdown?: number;
    /** Minimum rolling peak equity required before drawdown can hard-enforce PAUSE/SHUTDOWN (default: 1.0). */
    minPeakEquityForDrawdown?: number;
    /** Min profit factor before THROTTLE (default: 1.10) */
    minProfitFactor: number;
    /** Min expectancy in bps before THROTTLE (default: -2) */
    minExpectancyBps: number;
    /** Max avg slippage in bps before THROTTLE (default: 30) */
    maxAvgSlippageBps: number;
    /** Max partial fill rate before THROTTLE (default: 0.35) */
    maxPartialFillRate: number;
    /** Consecutive failures before SHUTDOWN (default: 8) */
    consecFailShutdown: number;
    /** Cooldown in ms for THROTTLE mode (default: 15000) */
    throttleCooldownMs: number;
    /** Cooldown in ms for PAUSE mode (default: 600000) */
    pauseCooldownMs: number;
    /** Size multiplier for THROTTLE mode (default: 0.5) */
    throttleSizeMultiplier: number;
    /** Size multiplier for PAUSE mode (default: 0.0) */
    pauseSizeMultiplier: number;
}

/**
 * Dependencies for CapitalProtectionEngine
 */
export interface CapitalProtectionDeps {
    feedbackEngine: typeof feedbackEngine;
    riskEngine: RiskEngine;
    config: CapitalProtectionConfig;
    /** Optional clock for testing */
    clock?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Computation Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute rolling drawdown from equity curve points.
 * 
 * @param equityCurve - Array of equity values (cumulative PnL)
 * @returns Max drawdown as percentage (0-100)
 */
export function computeRollingDrawdown(equityCurve: number[]): number {
    if (equityCurve.length < 2) return 0;

    let peak = equityCurve[0] ?? 0;
    let maxDrawdown = 0;

    for (const equity of equityCurve) {
        if (equity > peak) {
            peak = equity;
        }
        if (peak > 0) {
            const drawdown = ((peak - equity) / peak) * 100;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }
    }

    return maxDrawdown;
}

/**
 * Compute expectancy in basis points.
 * 
 * Expectancy = (WinRate * AvgWin) - (LossRate * AvgLoss)
 * Converted to bps relative to average trade size.
 * 
 * @param wins - Number of winning trades
 * @param losses - Number of losing trades
 * @param totalGain - Sum of all gains
 * @param totalLoss - Sum of all losses (positive value)
 * @param avgTradeSize - Average trade size for normalization
 * @returns Expectancy in basis points
 */
export function computeExpectancyBps(
    wins: number,
    losses: number,
    totalGain: number,
    totalLoss: number,
    avgTradeSize: number
): number {
    const total = wins + losses;
    if (total === 0 || avgTradeSize <= 0) return 0;

    const winRate = wins / total;
    const avgWin = wins > 0 ? totalGain / wins : 0;
    const avgLoss = losses > 0 ? totalLoss / losses : 0;

    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
    return (expectancy / avgTradeSize) * 10000;
}

/**
 * Compute profit factor.
 *
 * Delegates to the canonical implementation in metricUtils.
 * Kept as re-export for backward compatibility with existing callers.
 *
 * ProfitFactor = GrossProfit / GrossLoss
 *
 * Canonical semantics:
 *   - (0, 0)   → 1  (neutral / no information)
 *   - (>0, 0)  → Infinity
 *   - (0, >0)  → 0
 *   - (>0, >0) → gain / loss
 *
 * @param totalGain - Sum of all gains
 * @param totalLoss - Sum of all losses (positive value)
 * @returns Profit factor
 */
export function computeProfitFactor(totalGain: number, totalLoss: number): number {
    return computeProfitFactorCanonical(totalGain, totalLoss);
}

/**
 * Check if slippage indicates degradation.
 * 
 * @param avgSlippageBps - Average slippage in basis points
 * @param maxSlippageBps - Threshold for degradation
 * @returns true if slippage exceeds threshold
 */
export function isSlippageDegraded(avgSlippageBps: number, maxSlippageBps: number): boolean {
    return avgSlippageBps > maxSlippageBps;
}

/**
 * Check if partial fill rate indicates degradation.
 * 
 * @param partialFillRate - Rate of partial fills (0-1)
 * @param maxRate - Threshold for degradation
 * @returns true if partial fill rate exceeds threshold
 */
export function isPartialFillDegraded(partialFillRate: number, maxRate: number): boolean {
    return partialFillRate > maxRate;
}

/**
 * Determine protection mode based on metrics and config.
 * 
 * Priority order (highest to lowest):
 * 1. SHUTDOWN: consecutive failure breach OR extreme drawdown
 * 2. PAUSE: drawdown breach
 * 3. THROTTLE: PF/expectancy/slippage/partial fill issues
 * 4. ALLOW: all checks pass
 * 
 * @param metrics - Current rolling risk metrics
 * @param config - Protection configuration
 * @returns Protection mode and reasons
 */
export function determineProtectionMode(
    metrics: RollingRiskMetrics,
    config: CapitalProtectionConfig
): { mode: ProtectionMode; reasons: string[] } {
    const reasons: string[] = [];
    const toFinite = (value: number | undefined, fallback: number): number => (
        Number.isFinite(value) ? (value as number) : fallback
    );
    const drawdownPct = Math.max(0, toFinite(metrics.drawdownPct, 0));
    const tradesCount = Math.max(0, toFinite(metrics.tradesCount, 0));
    const minTradesForDrawdown = Math.max(
        0,
        toFinite(config.minTradesForDrawdown, config.minTrades),
    );
    const minPeakEquityForDrawdown = Math.max(
        0,
        toFinite(config.minPeakEquityForDrawdown, 1.0),
    );
    const peakEquity = Math.max(0, toFinite(metrics.peakEquity, 0));
    const drawdownConfidence = (metrics.drawdownConfidence ?? true)
        && tradesCount >= minTradesForDrawdown
        && peakEquity >= minPeakEquityForDrawdown;

    // Insufficient data - be cautious but allow with warning
    if (metrics.tradesCount < config.minTrades) {
        reasons.push(`Insufficient samples: ${metrics.tradesCount}/${config.minTrades} trades`);
        return { mode: 'ALLOW', reasons };
    }

    // SHUTDOWN checks (highest priority)
    if (metrics.consecutiveFailures >= config.consecFailShutdown) {
        reasons.push(`Consecutive failures: ${metrics.consecutiveFailures} >= ${config.consecFailShutdown}`);
        return { mode: 'SHUTDOWN', reasons };
    }

    // Extreme drawdown triggers shutdown
    const extremeDrawdownThreshold = config.maxRollingDrawdownPct * 1.5;
    if (drawdownPct >= extremeDrawdownThreshold && drawdownConfidence) {
        reasons.push(`Extreme drawdown: ${drawdownPct.toFixed(1)}% >= ${extremeDrawdownThreshold.toFixed(1)}%`);
        return { mode: 'SHUTDOWN', reasons };
    }

    // PAUSE checks
    if (drawdownPct >= config.maxRollingDrawdownPct && drawdownConfidence) {
        reasons.push(`Drawdown breach: ${drawdownPct.toFixed(1)}% >= ${config.maxRollingDrawdownPct}%`);
        return { mode: 'PAUSE', reasons };
    }

    // Drawdown can be informational even when confidence gate blocks hard enforcement.
    if (drawdownPct >= config.maxRollingDrawdownPct && !drawdownConfidence) {
        reasons.push(
            `Drawdown not confidence-qualified (${drawdownPct.toFixed(1)}%): `
            + `trades=${tradesCount}/${minTradesForDrawdown}, `
            + `peakEquity=${peakEquity.toFixed(6)}/${minPeakEquityForDrawdown}`,
        );
    }

    // THROTTLE checks - accumulate reasons
    const throttleReasons: string[] = [];

    if (metrics.profitFactor < config.minProfitFactor && metrics.profitFactor !== Infinity) {
        throttleReasons.push(`Low profit factor: ${metrics.profitFactor.toFixed(2)} < ${config.minProfitFactor}`);
    }

    if (metrics.expectancyBps < config.minExpectancyBps) {
        throttleReasons.push(`Low expectancy: ${metrics.expectancyBps.toFixed(1)} bps < ${config.minExpectancyBps} bps`);
    }

    if (isSlippageDegraded(metrics.avgSlippageBps, config.maxAvgSlippageBps)) {
        throttleReasons.push(`High slippage: ${metrics.avgSlippageBps.toFixed(1)} bps > ${config.maxAvgSlippageBps} bps`);
    }

    if (isPartialFillDegraded(metrics.partialFillRate, config.maxPartialFillRate)) {
        throttleReasons.push(`High partial fills: ${(metrics.partialFillRate * 100).toFixed(1)}% > ${(config.maxPartialFillRate * 100).toFixed(1)}%`);
    }

    if (throttleReasons.length > 0) {
        return { mode: 'THROTTLE', reasons: [...reasons, ...throttleReasons] };
    }

    // All checks pass
    if (reasons.length > 0) {
        return { mode: 'ALLOW', reasons };
    }
    return { mode: 'ALLOW', reasons: ['All metrics within acceptable ranges'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capital Protection Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capital Protection Engine
 * 
 * Evaluates account health and determines trading policy.
 * Should be called on every tick BEFORE strategies execute.
 */
export class CapitalProtectionEngine {
    private readonly feedback: typeof feedbackEngine;
    private readonly risk: RiskEngine;
    private readonly config: CapitalProtectionConfig;
    private readonly clock: () => number;

    /** Last computed decision (for observability) */
    private lastDecision: CapitalProtectionDecision | null = null;

    /** Last metrics computation timestamp */
    private lastMetricsTs = 0;

    /** Cached metrics (recomputed every few seconds) */
    private cachedMetrics: RollingRiskMetrics | null = null;

    /** Metrics cache TTL in ms */
    private readonly metricsCacheTtlMs = 5000;

    constructor(deps: CapitalProtectionDeps) {
        this.feedback = deps.feedbackEngine;
        this.risk = deps.riskEngine;
        this.config = deps.config;
        this.clock = deps.clock ?? (() => Date.now());
    }

    /**
     * Evaluate current account state and determine protection policy.
     * 
     * Should be called on every tick before strategies run.
     * 
     * @param pairKey - Current trading pair key
     * @returns Protection decision with mode, sizing, and reasons
     */
    evaluate(pairKey: string): CapitalProtectionDecision {
        const now = this.clock();

        // If protection is disabled, always allow
        if (!this.config.enabled) {
            const decision: CapitalProtectionDecision = {
                mode: 'ALLOW',
                sizeMultiplier: 1.0,
                cooldownMs: 0,
                reasons: ['Capital protection disabled'],
                metrics: this.getEmptyMetrics(),
                timestamp: now,
            };
            this.lastDecision = decision;
            return decision;
        }

        // Get current metrics (possibly cached)
        const metrics = this.getMetrics(pairKey);

        // Check if RiskEngine has triggered emergency shutdown
        if (this.risk.isShutdown()) {
            const decision: CapitalProtectionDecision = {
                mode: 'SHUTDOWN',
                sizeMultiplier: 0,
                cooldownMs: this.config.pauseCooldownMs,
                reasons: ['RiskEngine emergency shutdown active'],
                metrics,
                timestamp: now,
            };
            this.lastDecision = decision;
            logger.warn({ decision }, 'Capital protection: SHUTDOWN (RiskEngine)');
            return decision;
        }

        // Determine protection mode
        const { mode, reasons } = determineProtectionMode(metrics, this.config);

        // Build decision based on mode
        let sizeMultiplier: number;
        let cooldownMs: number;

        switch (mode) {
            case 'SHUTDOWN':
                sizeMultiplier = 0;
                cooldownMs = this.config.pauseCooldownMs;
                break;
            case 'PAUSE':
                sizeMultiplier = this.config.pauseSizeMultiplier;
                cooldownMs = this.config.pauseCooldownMs;
                break;
            case 'THROTTLE':
                sizeMultiplier = this.config.throttleSizeMultiplier;
                cooldownMs = this.config.throttleCooldownMs;
                break;
            case 'ALLOW':
            default:
                sizeMultiplier = 1.0;
                cooldownMs = 0;
                break;
        }

        const decision: CapitalProtectionDecision = {
            mode,
            sizeMultiplier,
            cooldownMs,
            reasons,
            metrics,
            timestamp: now,
        };

        this.lastDecision = decision;

        // Log non-ALLOW decisions
        if (mode !== 'ALLOW') {
            logger.info({ mode, reasons, metrics: this.sanitizeMetricsForLog(metrics) }, 'Capital protection decision');
        }

        return decision;
    }

    /**
     * Optional hook for trade events.
     * Can be used to track consecutive failures.
     * 
     * @param event - Trade event (success/failure)
     */
    onTradeEvent(event: { success: boolean; error?: string }): void {
        // RiskEngine already tracks consecutive failures,
        // but we can add additional tracking here if needed
        if (!event.success) {
            logger.debug({ error: event.error }, 'Capital protection: trade failure noted');
        }
    }

    /**
     * Get the last computed decision for observability.
     */
    getLastDecision(): CapitalProtectionDecision | null {
        return this.lastDecision;
    }

    /**
     * Get current metrics (with caching).
     */
    private getMetrics(pairKey: string): RollingRiskMetrics {
        const now = this.clock();

        // Return cached if fresh
        if (this.cachedMetrics && (now - this.lastMetricsTs) < this.metricsCacheTtlMs) {
            return this.cachedMetrics;
        }

        // Compute fresh metrics from feedback engine
        const metrics = this.computeMetrics(pairKey);
        this.cachedMetrics = metrics;
        this.lastMetricsTs = now;

        return metrics;
    }

    /**
     * Compute rolling risk metrics from feedback engine data.
     */
    private computeMetrics(pairKey: string): RollingRiskMetrics {
        // Get risk status from RiskEngine for consecutive failures
        const riskStatus = this.risk.getStatus();

        // Query rolling metrics from feedback engine
        const rollingMetrics = this.feedback.getRollingRiskMetrics({
            pairKey,
            lookbackTrades: this.config.lookbackTrades,
        });

        return {
            tradesCount: rollingMetrics.tradesCount,
            profitFactor: rollingMetrics.profitFactor,
            expectancyBps: rollingMetrics.expectancyBps,
            drawdownPct: rollingMetrics.drawdownPct,
            drawdownConfidence: rollingMetrics.drawdownConfidence ?? false,
            peakEquity: rollingMetrics.peakEquity ?? 0,
            equityNow: rollingMetrics.equityNow ?? 0,
            avgSlippageBps: rollingMetrics.avgSlippageBps,
            partialFillRate: rollingMetrics.partialFillRate,
            winRate: rollingMetrics.winRate,
            consecutiveFailures: riskStatus.consecutiveFailures,
        };
    }

    /**
     * Get empty metrics for disabled/error cases.
     */
    private getEmptyMetrics(): RollingRiskMetrics {
        return {
            tradesCount: 0,
            profitFactor: 1,
            expectancyBps: 0,
            drawdownPct: 0,
            drawdownConfidence: false,
            peakEquity: 0,
            equityNow: 0,
            avgSlippageBps: 0,
            partialFillRate: 0,
            winRate: 0,
            consecutiveFailures: 0,
        };
    }

    /**
     * Sanitize metrics for logging (remove potentially sensitive data).
     */
    private sanitizeMetricsForLog(metrics: RollingRiskMetrics): Record<string, number> {
        return {
            trades: metrics.tradesCount,
            pf: Math.round(metrics.profitFactor * 100) / 100,
            expectBps: Math.round(metrics.expectancyBps),
            ddPct: Math.round(metrics.drawdownPct * 10) / 10,
            slipBps: Math.round(metrics.avgSlippageBps),
            partialRate: Math.round(metrics.partialFillRate * 100),
            winRate: Math.round(metrics.winRate * 100),
            consecFail: metrics.consecutiveFailures,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load capital protection config from environment variables.
 */
export function loadCapitalProtectionConfig(): CapitalProtectionConfig {
    const toBool = (val: string | undefined, fallback: boolean): boolean => {
        if (val === undefined) return fallback;
        return val.toLowerCase() === 'true';
    };

    const toNumber = (val: string | undefined, fallback: number): number => {
        if (val === undefined) return fallback;
        const parsed = Number(val);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    return {
        enabled: toBool(process.env.CAPITAL_PROTECTION_ENABLED, true),
        lookbackTrades: toNumber(process.env.CP_LOOKBACK_TRADES, 200),
        minTrades: toNumber(process.env.CP_MIN_TRADES, 50),
        maxRollingDrawdownPct: toNumber(process.env.CP_MAX_ROLLING_DRAWDOWN_PCT, 7),
        minTradesForDrawdown: toNumber(process.env.CP_MIN_TRADES_FOR_DRAWDOWN, toNumber(process.env.CP_MIN_TRADES, 50)),
        minPeakEquityForDrawdown: toNumber(process.env.CP_MIN_PEAK_EQUITY_FOR_DRAWDOWN, 1.0),
        minProfitFactor: toNumber(process.env.CP_MIN_PROFIT_FACTOR, 1.10),
        minExpectancyBps: toNumber(process.env.CP_MIN_EXPECTANCY_BPS, -2),
        maxAvgSlippageBps: toNumber(process.env.CP_MAX_AVG_SLIPPAGE_BPS, 30),
        maxPartialFillRate: toNumber(process.env.CP_MAX_PARTIAL_FILL_RATE, 0.35),
        consecFailShutdown: toNumber(process.env.CP_CONSEC_FAIL_SHUTDOWN, 8),
        throttleCooldownMs: toNumber(process.env.CP_THROTTLE_COOLDOWN_MS, 15000),
        pauseCooldownMs: toNumber(process.env.CP_PAUSE_COOLDOWN_MS, 600000),
        throttleSizeMultiplier: toNumber(process.env.CP_SIZE_THROTTLE_MULT, 0.5),
        pauseSizeMultiplier: toNumber(process.env.CP_SIZE_PAUSE_MULT, 0.0),
    };
}
