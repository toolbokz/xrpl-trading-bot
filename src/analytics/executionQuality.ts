/**
 * Execution Quality Analytics — Per-Fill Tracing & Aggregation
 *
 * Provides deterministic, auditable execution quality metrics:
 *   • Per-fill traces: decision → build → submit → ledgerAccepted → fill
 *   • Slippage, spread cost, impact proxy (all in basis points)
 *   • Aggregation: P50/P95 slippage, latency, maker fill ratio, replace ratio
 *
 * Data flow:
 *   OfferExecutor calls createFillTrace() on decision, then completeFillTrace()
 *   after fill. TradingRuntime exposes the collector for API consumption.
 *
 * All traces are pair-keyed. Cross-pair contamination is prevented by
 * discarding any trace whose pairKey doesn't match the active pair.
 */

import {
    ExecutionTrace,
    makeCorrelationId,
    startExecutionTrace,
    markTraceStage,
    finalizeSlippage,
} from '../execution/executionTrace';

// ─────────────────────────────────────────────────────────────────────────────
// Per-fill trace — extends the existing ExecutionTrace with fill-time data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Completed fill record written to the ring buffer.
 * Every field is non-optional once finalized.
 */
export interface ExecutionFill {
    /** Correlation ID linking decision → fill. */
    correlationId: string;
    /** Pair key this fill belongs to. */
    pairKey: string;
    /** Strategy that produced the signal. */
    strategy: string;
    /** Side: buy or sell. */
    side: 'buy' | 'sell';

    // ── Timestamps (ms epoch) ────────────────────────────────────────────
    /** When the strategy made the trading decision. */
    decisionTimeMs: number;
    /** When the offer was submitted to XRPL. */
    submitTimeMs: number;
    /** When the ledger accepted the transaction. */
    ledgerAcceptedTimeMs: number;
    /** When fill parsing completed. */
    fillTimeMs: number;

    // ── Prices ───────────────────────────────────────────────────────────
    /** Mid-price at decision time. */
    arrivalMid: number;
    /** Price the strategy intended to trade at. */
    expectedPrice: number;
    /** Actual execution price. */
    fillPrice: number;
    /** Mid-price after fill (for impact measurement). */
    postFillMid: number;

    // ── Derived metrics (bps) ────────────────────────────────────────────
    /** (fillPrice − expectedPrice) / expectedPrice × 10 000 */
    slippageBps: number;
    /** (fillPrice − arrivalMid) / arrivalMid × 10 000 */
    spreadCostBps: number;
    /** (postFillMid − arrivalMid) / arrivalMid × 10 000 */
    impactProxyBps: number;

    // ── Fill metadata ────────────────────────────────────────────────────
    /** Portion of the order filled (0–1). */
    fillRatio: number;
    /** Whether this was a maker (passive) fill. */
    isMaker: boolean;
    /** Whether the offer was replaced before filling. */
    wasReplaced: boolean;
    /** Transaction hash. */
    txHash: string | null;
    /** Ledger index at fill. */
    ledgerIndex: number;
    /** Execution source: AMM pool, DEX order book, mixed, or unknown. */
    executionSource: 'amm' | 'orderbook' | 'mixed' | 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated metrics — computed from the ring buffer on demand
// ─────────────────────────────────────────────────────────────────────────────

export interface AggregatedExecutionQuality {
    /** Window in ms over which these metrics are computed. */
    windowMs: number;
    /** Number of fills in the window. */
    fillCount: number;
    /** Median slippage in basis points. */
    slippageBpsP50: number;
    /** 95th percentile slippage in basis points. */
    slippageBpsP95: number;
    /** Median fill latency (submit → fill) in ms. */
    fillLatencyP50: number;
    /** 95th percentile fill latency in ms. */
    fillLatencyP95: number;
    /** Ratio of maker fills to total fills (0–1). */
    makerFillRatio: number;
    /** Ratio of replaced-then-filled to total fills (0–1). */
    replaceToFillRatio: number;
    /** Median spread cost in basis points. */
    spreadCostBpsP50: number;
    /** Median impact proxy in basis points. */
    impactProxyBpsP50: number;
    /** Mean fill ratio (partial fill completeness). */
    meanFillRatio: number;
    /** Computed at (ms epoch). */
    computedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full analytics payload for the API
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutionQualityPayload {
    /** Active pair key. */
    pairKey: string;
    /** Aggregated metrics over the requested window. */
    aggregated: AggregatedExecutionQuality;
    /** Recent fills (newest first, limited to recentLimit). */
    recentFills: ExecutionFill[];
    /** Total fills stored in the collector. */
    totalFillsTracked: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-flight trace — mutable builder held by the executor during submission
// ─────────────────────────────────────────────────────────────────────────────

export interface InFlightTrace {
    /** The growing execution trace. */
    trace: ExecutionTrace;
    /** Trade side. */
    side: 'buy' | 'sell';
    /** Whether the offer was passive (maker). */
    isMaker: boolean;
    /** Whether this offer replaced a previous one. */
    wasReplaced: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let nonceCounter = 0;

/**
 * Monotonic nonce for correlation ID uniqueness within a process.
 */
function nextNonce(): number {
    return nonceCounter++;
}

/**
 * Compute a percentile from a sorted array.
 * Uses the nearest-rank method.
 */
function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)]!;
}

/**
 * Basis-point helper: (a − b) / b × 10 000, clamped to finite.
 */
function bps(a: number, b: number): number {
    if (!Number.isFinite(b) || b <= 0) return 0;
    const raw = ((a - b) / b) * 10_000;
    return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collector — pair-keyed ring buffer with on-demand aggregation
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutionQualityCollectorConfig {
    /** Maximum number of fills to keep in the ring buffer (default 500). */
    maxFills: number;
    /** Default aggregation window in ms (default 1 hour). */
    defaultWindowMs: number;
}

const DEFAULT_COLLECTOR_CONFIG: ExecutionQualityCollectorConfig = {
    maxFills: 500,
    defaultWindowMs: 3_600_000, // 1 hour
};

export class ExecutionQualityCollector {
    private readonly config: ExecutionQualityCollectorConfig;
    private fills: ExecutionFill[] = [];
    private pairKey = '';

    constructor(config: Partial<ExecutionQualityCollectorConfig> = {}) {
        this.config = { ...DEFAULT_COLLECTOR_CONFIG, ...config };
    }

    // ─── Mutation ────────────────────────────────────────────────────────

    /**
     * Set the active pair. Fills for other pairs are rejected.
     * Called by TradingRuntime on pair switch.
     */
    setPairKey(pairKey: string): void {
        this.pairKey = pairKey;
    }

    /**
     * Create an in-flight trace for a new execution decision.
     *
     * This is the START of the trace lifecycle. The executor calls this
     * when it decides to place an offer, passing the current mid-price
     * and intended execution price.
     */
    createTrace(ctx: {
        pairKey: string;
        strategy: string;
        side: 'buy' | 'sell';
        arrivalMid: number;
        expectedPrice: number;
        isMaker?: boolean;
        wasReplaced?: boolean;
    }): InFlightTrace {
        const now = Date.now();
        const correlationId = makeCorrelationId({
            pairKey: ctx.pairKey,
            strategy: ctx.strategy,
            ts: now,
            nonce: nextNonce(),
        });

        const trace = startExecutionTrace({
            correlationId,
            pairKey: ctx.pairKey,
            strategy: ctx.strategy,
            arrivalMid: ctx.arrivalMid,
            expectedPrice: ctx.expectedPrice,
            decisionTimeMs: now,
        });

        return {
            trace,
            side: ctx.side,
            isMaker: ctx.isMaker ?? false,
            wasReplaced: ctx.wasReplaced ?? false,
        };
    }

    /**
     * Record a completed fill. This is the END of the trace lifecycle.
     *
     * Called by the executor after XRPL confirms the transaction.
     * The in-flight trace is finalized with fill-time data and pushed
     * into the ring buffer.
     *
     * Returns the finalized ExecutionFill, or null if the trace was
     * rejected (e.g. wrong pair, invalid data).
     */
    recordFill(
        inflight: InFlightTrace,
        fill: {
            submitTimeMs: number;
            ledgerAcceptedTimeMs: number;
            fillPrice: number;
            postFillMid: number;
            fillRatio: number;
            txHash: string | null;
            ledgerIndex: number;
            executionSource?: 'amm' | 'orderbook' | 'mixed' | 'unknown';
        },
    ): ExecutionFill | null {
        // Cross-pair guard
        if (inflight.trace.pairKey !== this.pairKey) {
            return null;
        }

        const now = Date.now();

        // Build the trace through all stages
        let trace = markTraceStage(inflight.trace, 'submit', fill.submitTimeMs);
        trace = markTraceStage(trace, 'ledgerAccepted', fill.ledgerAcceptedTimeMs);
        trace = markTraceStage(trace, 'fill', now);
        trace = finalizeSlippage(trace, fill.fillPrice, fill.postFillMid);

        const entry: ExecutionFill = {
            correlationId: trace.correlationId,
            pairKey: trace.pairKey,
            strategy: trace.strategy,
            side: inflight.side,

            decisionTimeMs: trace.decisionTimeMs,
            submitTimeMs: fill.submitTimeMs,
            ledgerAcceptedTimeMs: fill.ledgerAcceptedTimeMs,
            fillTimeMs: now,

            arrivalMid: trace.arrivalMid,
            expectedPrice: trace.expectedPrice,
            fillPrice: fill.fillPrice,
            postFillMid: fill.postFillMid,

            slippageBps: trace.slippageBps ?? bps(fill.fillPrice, trace.expectedPrice),
            spreadCostBps: trace.spreadCostBps ?? bps(fill.fillPrice, trace.arrivalMid),
            impactProxyBps: trace.impactProxyBps ?? bps(fill.postFillMid, trace.arrivalMid),

            fillRatio: fill.fillRatio,
            isMaker: inflight.isMaker,
            wasReplaced: inflight.wasReplaced,
            txHash: fill.txHash,
            ledgerIndex: fill.ledgerIndex,
            executionSource: fill.executionSource ?? 'unknown',
        };

        this.fills.push(entry);

        // Ring buffer eviction
        if (this.fills.length > this.config.maxFills) {
            this.fills = this.fills.slice(-this.config.maxFills);
        }

        return entry;
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /**
     * Compute aggregated execution quality metrics over a time window.
     *
     * @param windowMs — Duration to aggregate over (default: config default).
     * @param pairKey  — Pair key to filter by (default: current active pair).
     */
    aggregate(windowMs?: number, pairKey?: string): AggregatedExecutionQuality {
        const window = windowMs ?? this.config.defaultWindowMs;
        const pair = pairKey ?? this.pairKey;
        const cutoff = Date.now() - window;

        const inWindow = this.fills.filter(
            (f) => f.pairKey === pair && f.fillTimeMs >= cutoff,
        );

        if (inWindow.length === 0) {
            return emptyAggregate(window);
        }

        // Sorted arrays for percentile computation
        const slippages = inWindow.map((f) => f.slippageBps).sort((a, b) => a - b);
        const latencies = inWindow
            .map((f) => f.fillTimeMs - f.submitTimeMs)
            .sort((a, b) => a - b);
        const spreadCosts = inWindow.map((f) => f.spreadCostBps).sort((a, b) => a - b);
        const impacts = inWindow.map((f) => f.impactProxyBps).sort((a, b) => a - b);

        const makerCount = inWindow.filter((f) => f.isMaker).length;
        const replacedCount = inWindow.filter((f) => f.wasReplaced).length;
        const fillRatioSum = inWindow.reduce((acc, f) => acc + f.fillRatio, 0);

        return {
            windowMs: window,
            fillCount: inWindow.length,
            slippageBpsP50: percentile(slippages, 50),
            slippageBpsP95: percentile(slippages, 95),
            fillLatencyP50: percentile(latencies, 50),
            fillLatencyP95: percentile(latencies, 95),
            makerFillRatio: makerCount / inWindow.length,
            replaceToFillRatio: replacedCount / inWindow.length,
            spreadCostBpsP50: percentile(spreadCosts, 50),
            impactProxyBpsP50: percentile(impacts, 50),
            meanFillRatio: fillRatioSum / inWindow.length,
            computedAt: Date.now(),
        };
    }

    /**
     * Get recent fills, newest first.
     */
    getRecentFills(limit: number = 20, pairKey?: string): ExecutionFill[] {
        const pair = pairKey ?? this.pairKey;
        return this.fills
            .filter((f) => f.pairKey === pair)
            .slice(-limit)
            .reverse();
    }

    /**
     * Get the full analytics payload for the API.
     */
    getPayload(windowMs?: number, recentLimit: number = 20): ExecutionQualityPayload {
        return {
            pairKey: this.pairKey,
            aggregated: this.aggregate(windowMs),
            recentFills: this.getRecentFills(recentLimit),
            totalFillsTracked: this.fills.filter((f) => f.pairKey === this.pairKey).length,
        };
    }

    /**
     * Get total fills count for the active pair.
     */
    getFillCount(pairKey?: string): number {
        const pair = pairKey ?? this.pairKey;
        return this.fills.filter((f) => f.pairKey === pair).length;
    }

    /**
     * Reset all data. Called on runtime shutdown or pair switch.
     */
    reset(): void {
        this.fills = [];
        this.pairKey = '';
    }

    /**
     * Get raw fills array (for testing).
     */
    getAllFills(): ExecutionFill[] {
        return [...this.fills];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

function emptyAggregate(windowMs: number): AggregatedExecutionQuality {
    return {
        windowMs,
        fillCount: 0,
        slippageBpsP50: 0,
        slippageBpsP95: 0,
        fillLatencyP50: 0,
        fillLatencyP95: 0,
        makerFillRatio: 0,
        replaceToFillRatio: 0,
        spreadCostBpsP50: 0,
        impactProxyBpsP50: 0,
        meanFillRatio: 0,
        computedAt: Date.now(),
    };
}
