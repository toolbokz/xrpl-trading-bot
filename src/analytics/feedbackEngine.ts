/**
 * Feedback Engine
 * 
 * Service for recording trade events and market snapshots, and computing
 * analytics to validate profitability. All operations are best-effort -
 * failures are logged but never crash the trading system.
 * 
 * Features:
 * - Record market snapshots with flow metrics
 * - Record trade events (offers, fills, rejects, errors)
 * - Compute analytics: expectancy, win rate, profit factor
 * - Slippage analysis vs mid/VWAP
 * - Regime performance matrix
 * - Per-strategy statistics
 * - Rolling drawdown tracking
 */

import {
    TradeEventRecord,
    MarketSnapshotRecord,
    ExecutionQualityEventRecord,
    EdgeAttributionEventRecord,
    TradeAction,
    generateId,
    insertTradeEvent,
    insertExecutionQualityEvent,
    insertEdgeAttributionEvent,
    insertMarketSnapshot,
    insertBatch,
    updateExecutionQualityHorizons as updateExecutionQualityHorizonsDb,
    updateEdgeAttributionHorizons as updateEdgeAttributionHorizonsDb,
    queryExecutionQualityEvents,
    queryEdgeAttributionEvents,
    updateTradeEventPostFill1s,
    updateTradeEventPostFill3s,
    queryTradeEvents,
    getSnapshotNear,
    pruneOldData,
    closeFeedbackDb,
    QueryFilters,
    ExecutionQualityQueryFilters,
    EdgeAttributionQueryFilters,
    getFeedbackDb,
} from './feedbackDb';
import { FlowMetrics, FlowRegime, hasAdverseSelectionRisk } from '../market/flowMetrics';
import { OrderBookState } from '../utils/types';
import { logger } from './logger';
import { canonicalizePairKey, getPairKeyAliases } from '../xrpl/currency';
import {
    buildExecutionQualityMetrics,
    computeImpactBps,
    computeRealizedSpreadBps,
} from './executionQualityMetrics';
import { computeCanonicalSlippageBps, warnInvalidSlippageInputs } from './slippageMath';
import {
    buildEdgeAttributionMetrics,
    validatePnlIdentity,
} from './edgeAttributionMetrics';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for recording a market snapshot
 */
export interface MarketSnapshotInput {
    pairKey: string;
    ledgerIndex: number;
    orderBook: OrderBookState;
    flow: FlowMetrics | null;
}

/**
 * Input for recording a trade event
 */
export interface TradeEventInput {
    pairKey: string;
    strategy: string;
    action: TradeAction;
    side?: 'buy' | 'sell';
    intentPrice?: number;
    intentSizeBase?: number;
    intentSizeQuote?: number;
    fillPrice?: number;
    fillSizeBase?: number;
    fillSizeQuote?: number;
    txHash?: string;
    ledgerIndex?: number;
    resultCode?: string | undefined;
    error?: string | undefined;
    isBotTrade?: boolean;
    midPriceAtDecision?: number | undefined;
    // Cost realism fields
    slippageBpsVsIntent?: number | null;
    slippageBpsVsMid?: number | null;
    slippageBpsVsBbo?: number | null;
    expectedPriceSource?: 'intent' | 'mid' | 'bbo' | 'fallback_intent' | null;
    decisionMidPrice?: number | null;
    decisionBestBid?: number | null;
    decisionBestAsk?: number | null;
    spreadPaidBps?: number | null;
    edgeBpsVsMid?: number | null;
    netEdgeBpsVsMid?: number | null;
    txFeeXrp?: number | null;
    ammFeeBps?: number | null;
    fillRatio?: number | null;
    isPartial?: boolean | null;
    // Entry snapshot (captured at decision time)
    entrySpreadBps?: number | null;
    entryFlowCombined?: number | null;
    entryFlowStrength?: number | null;
    entryFlowRegime?: FlowRegime | null;
    // Post-fill snapshots (captured after fill)
    postMid1s?: number | null;
    postSpread1s?: number | null;
    postFlowCombined1s?: number | null;
    postFlowStrength1s?: number | null;
    postFlowRegime1s?: FlowRegime | null;
    postMid3s?: number | null;
    postSpread3s?: number | null;
    postFlowCombined3s?: number | null;
    postFlowStrength3s?: number | null;
    postFlowRegime3s?: FlowRegime | null;
    entryMid?: number | null;
    entrySignalStrength?: number | null;
    entryLocalExtreme?: number | null;
    postSignal1s?: number | null;
    postSignal3s?: number | null;
    /** Execution source: AMM pool, DEX order book, mixed, or unknown. */
    executionSource?: 'amm' | 'orderbook' | 'mixed' | 'unknown' | null;
}

export interface ExecutionQualityEventInput {
    eventId?: string | null;
    txHash?: string | null;
    ts?: number;
    pairKey: string;
    side: 'buy' | 'sell';
    strategy?: string | null;
    regime?: FlowRegime | null;
    source?: 'bot' | 'manual' | 'unknown';
    intentPrice?: number | null;
    expectedPrice?: number | null;
    expectedPriceSource?: 'intent' | 'mid' | 'bbo' | 'fallback_intent' | null;
    decisionMid?: number | null;
    decisionBid?: number | null;
    decisionAsk?: number | null;
    fillPrice?: number | null;
    amountBase?: number | null;
    filledBase?: number | null;
    filledQuote?: number | null;
    slippageBpsVsIntent?: number | null;
    slippageBpsVsMid?: number | null;
    slippageBpsVsBbo?: number | null;
    effSpreadBps?: number | null;
    realizedSpreadBps1m?: number | null;
    realizedSpreadBps5m?: number | null;
    impactBps1m?: number | null;
    impactBps5m?: number | null;
    implShortfallQuote?: number | null;
    fillRatio?: number | null;
    status?: 'FILLED' | 'PARTIAL' | 'REJECTED';
    rejectReason?: string | null;
    flags?: string[] | null;
    guardQuarantined?: boolean | null;
    decisionTs?: number | null;
    submitTs?: number | null;
    validatedTs?: number | null;
    decisionToSubmitMs?: number | null;
    submitToValidatedMs?: number | null;
    decisionToValidatedMs?: number | null;
}

export interface ExecutionQualityFilters {
    pairKey?: string;
    sinceMs?: number;
    strategy?: string;
    side?: 'buy' | 'sell';
    source?: 'bot' | 'manual' | 'unknown';
    bucketMs?: number;
}

export interface ExecutionQualitySummary {
    events: number;
    fills: number;
    rejects: number;
    partials: number;
    coverage1m: number;
    coverage5m: number;
    avgSlippageBpsVsIntent: number | null;
    avgSlippageBpsVsMid: number | null;
    avgSlippageBpsVsBbo: number | null;
    avgEffSpreadBps: number | null;
    avgRealizedSpreadBps1m: number | null;
    avgRealizedSpreadBps5m: number | null;
    avgImpactBps1m: number | null;
    avgImpactBps5m: number | null;
    avgFillRatio: number | null;
    avgDecisionToSubmitMs: number | null;
    avgSubmitToValidatedMs: number | null;
    avgDecisionToValidatedMs: number | null;
}

export interface ExecutionQualityBucket {
    ts: number;
    count: number;
    avgSlippageBpsVsIntent: number | null;
    avgEffSpreadBps: number | null;
    avgRealizedSpreadBps1m: number | null;
    avgRealizedSpreadBps5m: number | null;
    avgImpactBps1m: number | null;
    avgImpactBps5m: number | null;
    avgFillRatio: number | null;
    avgDecisionToValidatedMs: number | null;
}

export interface ExecutionQualityHistogramBin {
    min: number;
    max: number;
    count: number;
}

export interface ExecutionQualityBreakdownRow {
    key: string;
    count: number;
    avgSlippageBpsVsIntent: number | null;
    avgEffSpreadBps: number | null;
    avgFillRatio: number | null;
}

export interface ExecutionQualityAnomalies {
    suspiciousSlippageSpikes: number;
    partialFillAnomalies: number;
    quoteBaseIntegrityViolations: number;
}

export interface ExecutionQualityAnalytics {
    summary: ExecutionQualitySummary;
    series: ExecutionQualityBucket[];
    histograms: {
        slippageBps: ExecutionQualityHistogramBin[];
        spreadBps: ExecutionQualityHistogramBin[];
        postTradeDriftBps: ExecutionQualityHistogramBin[];
    };
    breakdowns: {
        byPair: ExecutionQualityBreakdownRow[];
        byStrategy: ExecutionQualityBreakdownRow[];
        bySide: ExecutionQualityBreakdownRow[];
        byRegime: ExecutionQualityBreakdownRow[];
    };
    anomalies: ExecutionQualityAnomalies;
}

export interface EdgeAttributionEventInput {
    eventId?: string | null;
    txHash?: string | null;
    ts?: number;
    pairKey: string;
    side: 'buy' | 'sell';
    strategy?: string | null;
    regime?: FlowRegime | null;
    source?: 'bot' | 'manual' | 'unknown';
    midDecision?: number | null;
    bidDecision?: number | null;
    askDecision?: number | null;
    fillPrice?: number | null;
    midFill?: number | null;
    baseFilled?: number | null;
    filledQuote?: number | null;
    strategyFair?: number | null;
    decisionTs?: number | null;
    fillTs?: number | null;
}

export interface EdgeAttributionFilters {
    pairKey?: string;
    sinceMs?: number;
    strategy?: string;
    side?: 'buy' | 'sell';
    source?: 'bot' | 'manual' | 'unknown';
    bucketMs?: number;
}

export interface EdgeAttributionSummary {
    events: number;
    coverageDecision: number;
    coverage1m: number;
    coverage5m: number;
    avgSignalEdgeBpsExAnte: number | null;
    avgSignalEdgeBpsExPost1m: number | null;
    avgSignalEdgeBpsExPost5m: number | null;
    avgExecutionEdgeBpsVsMid: number | null;
    avgExecutionEdgeBpsVsBbo: number | null;
    avgDriftBps1m: number | null;
    avgDriftBps5m: number | null;
    avgPnlExecQuote: number | null;
    avgPnlTotalQuote1m: number | null;
    avgPnlTotalQuote5m: number | null;
}

export interface EdgeAttributionBucket {
    ts: number;
    count: number;
    avgExecutionEdgeBpsVsMid: number | null;
    avgDriftBps1m: number | null;
    avgSignalEdgeBpsExPost1m: number | null;
    avgPnlTotalQuote1m: number | null;
}

export interface EdgeAttributionHistogramBin {
    min: number;
    max: number;
    count: number;
}

export interface EdgeAttributionBreakdownRow {
    key: string;
    count: number;
    avgExecutionEdgeBpsVsMid: number | null;
    avgDriftBps1m: number | null;
    avgPnlTotalQuote1m: number | null;
}

export interface EdgeAttributionTopTrade {
    txHash: string | null;
    ts: number;
    pairKey: string;
    strategy: string | null;
    side: 'buy' | 'sell' | null;
    executionEdgeBpsVsMid: number | null;
    driftBps1m: number | null;
    pnlTotalQuote1m: number | null;
    fillPrice: number | null;
    midDecision: number | null;
    baseFilled: number | null;
}

export interface EdgeAttributionAnalytics {
    summary: EdgeAttributionSummary;
    series: EdgeAttributionBucket[];
    histograms: {
        executionEdgeBps: EdgeAttributionHistogramBin[];
        driftBps: EdgeAttributionHistogramBin[];
    };
    breakdowns: {
        byPair: EdgeAttributionBreakdownRow[];
        byStrategy: EdgeAttributionBreakdownRow[];
        bySide: EdgeAttributionBreakdownRow[];
        byRegime: EdgeAttributionBreakdownRow[];
    };
    topTrades: {
        worstExecution: EdgeAttributionTopTrade[];
        adverseSelection: EdgeAttributionTopTrade[];
    };
}

/**
 * Summary statistics
 */
export interface AnalyticsSummary {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
    expectancy: number;
    avgSlippageBps: number;
    totalPnlApprox: number;
    maxDrawdown: number;
    avgEdgeBps: number;
}

/**
 * Statistics per regime
 */
export interface RegimeStats {
    regime: FlowRegime;
    trades: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
    avgSlippageBps: number;
    /** Total PnL (approximate) for this regime */
    totalPnl: number;
    /** Average PnL per trade (totalPnl / trades, 0 if no trades) */
    pnlPerTrade: number;
}

/**
 * Statistics per strategy
 */
export interface StrategyStats {
    strategy: string;
    trades: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
}

/**
 * Cost realism summary statistics
 */
export interface CostSummary {
    fills: number;
    avgSlippageBpsVsIntent: number | null;
    avgSlippageBpsVsMid: number | null;
    avgSpreadPaidBps: number | null;
    avgEdgeBpsVsMid: number | null;
    avgNetEdgeBpsVsMid: number | null;
    avgTxFeeXrp: number | null;
    totalTxFeeXrp: number | null;
    partialFillRatio: number;
    avgFillRatio: number | null;
}

/**
 * Drawdown data point
 */
export interface DrawdownPoint {
    ts: number;
    equity: number;
    drawdown: number;
}

/**
 * Regime heatmap cell stats
 */
export interface RegimeHeatmapCell {
    regime: FlowRegime;
    trades: number;
    winRate: number;
    profitFactor: number;
    expectancyBps: number;
    avgEdgeBps: number;
    avgSlippageBps: number;
    avgSpreadBps: number;
    partialFillRate: number;
    /** Composite score: expectancyBps - 0.5*avgSlippageBps - 0.25*avgSpreadBps - 20*partialFillRate */
    score: number;
}

/**
 * Regime heatmap options
 */
export interface RegimeHeatmapOptions {
    /** Lookback window in hours (default: 24) */
    lookbackHours?: number;
    /** Minimum trades required for valid stats (default: 5) */
    minTrades?: number;
    /** Include per-strategy breakdown */
    byStrategy?: boolean;
}

/**
 * Regime heatmap response
 */
export interface RegimeHeatmapResponse {
    /** Global regime stats (across all strategies) */
    global: Record<FlowRegime, RegimeHeatmapCell>;
    /** Per-strategy regime stats */
    perStrategy: Record<string, Record<FlowRegime, RegimeHeatmapCell>>;
    /** Query metadata */
    meta: {
        lookbackHours: number;
        minTrades: number;
        totalTrades: number;
        computedAt: number;
    };
}

/**
 * Rolling profit factor data point
 */
export interface ProfitFactorPoint {
    ts: number;
    profitFactor: number;
}

/**
 * Complete analytics response
 */
export interface AnalyticsResponse {
    summary: AnalyticsSummary;
    byRegime: RegimeStats[];
    byStrategy: StrategyStats[];
    drawdown: DrawdownPoint[];
    /** Max rate of drawdown increase across consecutive buckets (per hour) */
    drawdownVelocity: number;
    /** Rolling cumulative profit factor series aligned with drawdown buckets */
    profitFactorSeries: ProfitFactorPoint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Feedback Engine Class
// ─────────────────────────────────────────────────────────────────────────────

/** Number of ticks between batched snapshot writes (configurable via env, default 5). */
const SNAPSHOT_FLUSH_INTERVAL_TICKS = Math.max(
    1,
    parseInt(process.env.SNAPSHOT_FLUSH_INTERVAL ?? '5', 10) || 5,
);

class FeedbackEngine {
    private initialized = false;
    private pruneIntervalId: NodeJS.Timeout | null = null;
    /** Buffered snapshots awaiting batch write. */
    private snapshotBuffer: MarketSnapshotRecord[] = [];
    /** Tick counter for snapshot flush scheduling. */
    private snapshotTickCounter = 0;

    /**
     * Initialize the feedback engine (lazy, called on first use)
     */
    private ensureInitialized(): boolean {
        if (this.initialized) return true;

        try {
            getFeedbackDb(); // This initializes the DB
            this.initialized = true;

            // Schedule periodic pruning (every 6 hours)
            this.pruneIntervalId = setInterval(() => {
                this.prune();
            }, 6 * 60 * 60 * 1000);

            // Initial prune on startup
            setTimeout(() => this.prune(), 30000);

            return true;
        } catch (err) {
            logger.warn({ err }, 'Feedback engine initialization failed - analytics disabled');
            return false;
        }
    }

    /**
     * Record a market snapshot.
     * Snapshots are buffered and flushed to SQLite every SNAPSHOT_FLUSH_INTERVAL_TICKS
     * ticks to reduce synchronous IO pressure on the event loop.
     */
    recordSnapshot(input: MarketSnapshotInput): void {
        if (!this.ensureInitialized()) return;

        try {
            const snapshot: MarketSnapshotRecord = {
                id: generateId(),
                ts: Date.now(),
                pairKey: canonicalizePairKey(input.pairKey),
                ledgerIndex: input.ledgerIndex,
                midPrice: this.computeMidPrice(input.orderBook),
                spreadBps: input.orderBook.spread ?? null,
                bestBid: input.orderBook.bids[0]?.price ?? null,
                bestAsk: input.orderBook.asks[0]?.price ?? null,
                bidDepthBase: input.orderBook.bids.reduce((sum, b) => sum + b.quantity, 0),
                askDepthBase: input.orderBook.asks.reduce((sum, a) => sum + a.quantity, 0),
                flowRegime: input.flow?.regime ?? null,
                flowImbalance: input.flow?.imbalance ?? null,
                flowDepthImbalance: input.flow?.depthImbalance ?? null,
                flowCombined: input.flow?.combinedSignal ?? null,
                flowStrength: input.flow?.signalStrength ?? null,
                vwap: input.flow?.vwap ?? null,
                vwapDeviationBps: input.flow?.vwapDeviationBps ?? null,
                tradeCount: input.flow?.tradeCount ?? null,
                volumeVelocity: input.flow?.volumeVelocity ?? null,
                adverseSelectionRisk: input.flow
                    ? (hasAdverseSelectionRisk(input.flow) ? 1 : 0)
                    : null,
            };

            this.snapshotBuffer.push(snapshot);
            this.snapshotTickCounter++;

            if (this.snapshotTickCounter >= SNAPSHOT_FLUSH_INTERVAL_TICKS) {
                this.flushSnapshots();
            }
        } catch (err) {
            logger.warn({ err, pairKey: input.pairKey }, 'Failed to record snapshot');
        }
    }

    /**
     * Flush buffered snapshots to SQLite.
     * Writing N snapshots as N individual inserts is still faster than
     * 1 insert per tick because the event-loop cost is amortized over
     * SNAPSHOT_FLUSH_INTERVAL_TICKS ticks instead of paid every tick.
     * Called periodically and on shutdown.
     */
    flushSnapshots(): void {
        if (this.snapshotBuffer.length === 0) {
            this.snapshotTickCounter = 0;
            return;
        }

        try {
            for (const snapshot of this.snapshotBuffer) {
                insertMarketSnapshot(snapshot);
            }
        } catch (err) {
            logger.warn({ err, count: this.snapshotBuffer.length }, 'Failed to flush snapshot batch');
        } finally {
            this.snapshotBuffer = [];
            this.snapshotTickCounter = 0;
        }
    }

    /**
     * Record a trade event
     */
    recordTradeEvent(input: TradeEventInput): string | null {
        if (!this.ensureInitialized()) return null;

        try {
            const event: TradeEventRecord = {
                id: generateId(),
                ts: Date.now(),
                pairKey: canonicalizePairKey(input.pairKey),
                strategy: input.strategy,
                action: input.action,
                side: input.side ?? null,
                intentPrice: input.intentPrice ?? null,
                intentSizeBase: input.intentSizeBase ?? null,
                intentSizeQuote: input.intentSizeQuote ?? null,
                fillPrice: input.fillPrice ?? null,
                fillSizeBase: input.fillSizeBase ?? null,
                fillSizeQuote: input.fillSizeQuote ?? null,
                txHash: input.txHash ?? null,
                ledgerIndex: input.ledgerIndex ?? null,
                resultCode: input.resultCode ?? null,
                error: this.sanitizeError(input.error),
                isBotTrade: input.isBotTrade !== undefined ? (input.isBotTrade ? 1 : 0) : null,
                midPriceAtDecision: input.midPriceAtDecision ?? null,
                // Cost realism fields
                slippageBpsVsIntent: input.slippageBpsVsIntent ?? null,
                slippageBpsVsMid: input.slippageBpsVsMid ?? null,
                slippageBpsVsBbo: input.slippageBpsVsBbo ?? null,
                expectedPriceSource: input.expectedPriceSource ?? null,
                decisionMidPrice: input.decisionMidPrice ?? null,
                decisionBestBid: input.decisionBestBid ?? null,
                decisionBestAsk: input.decisionBestAsk ?? null,
                spreadPaidBps: input.spreadPaidBps ?? null,
                edgeBpsVsMid: input.edgeBpsVsMid ?? null,
                netEdgeBpsVsMid: input.netEdgeBpsVsMid ?? null,
                txFeeXrp: input.txFeeXrp ?? null,
                ammFeeBps: input.ammFeeBps ?? null,
                fillRatio: input.fillRatio ?? null,
                isPartial: input.isPartial != null ? (input.isPartial ? 1 : 0) : null,
                entrySpreadBps: input.entrySpreadBps ?? null,
                entryFlowCombined: input.entryFlowCombined ?? null,
                entryFlowStrength: input.entryFlowStrength ?? null,
                entryFlowRegime: input.entryFlowRegime ?? null,
                postMid1s: input.postMid1s ?? null,
                postSpread1s: input.postSpread1s ?? null,
                postFlowCombined1s: input.postFlowCombined1s ?? null,
                postFlowStrength1s: input.postFlowStrength1s ?? null,
                postFlowRegime1s: input.postFlowRegime1s ?? null,
                postMid3s: input.postMid3s ?? null,
                postSpread3s: input.postSpread3s ?? null,
                postFlowCombined3s: input.postFlowCombined3s ?? null,
                postFlowStrength3s: input.postFlowStrength3s ?? null,
                postFlowRegime3s: input.postFlowRegime3s ?? null,
                entryMid: input.entryMid ?? null,
                entrySignalStrength: input.entrySignalStrength ?? null,
                entryLocalExtreme: input.entryLocalExtreme ?? null,
                postSignal1s: input.postSignal1s ?? null,
                postSignal3s: input.postSignal3s ?? null,
            };

            const insertedId = insertTradeEvent(event);
            return insertedId;
        } catch (err) {
            logger.warn({ err, action: input.action }, 'Failed to record trade event');
        }
        return null;
    }

    /**
     * Update post-fill snapshot fields for a trade event.
     */
    recordPostFillSnapshot1s(input: {
        id: string;
        postMid1s: number | null;
        postSpread1s: number | null;
        postFlowCombined1s: number | null;
        postFlowStrength1s: number | null;
        postFlowRegime1s: FlowRegime | null;
        postSignal1s: number | null;
    }): void {
        if (!this.ensureInitialized()) return;
        try {
            const changes = updateTradeEventPostFill1s(input);
            if (changes === 1) {
                logger.info({ eventId: input.id }, 'Recorded post-fill 1s snapshot');
            } else {
                logger.warn({ eventId: input.id, changes }, 'Post-fill 1s snapshot update affected no rows');
            }
        } catch (err) {
            logger.warn({ err, eventId: input.id }, 'Failed to record post-fill 1s snapshot');
        }
    }

    recordPostFillSnapshot3s(input: {
        id: string;
        postMid3s: number | null;
        postSpread3s: number | null;
        postFlowCombined3s: number | null;
        postFlowStrength3s: number | null;
        postFlowRegime3s: FlowRegime | null;
        postSignal3s: number | null;
    }): void {
        if (!this.ensureInitialized()) return;
        try {
            const changes = updateTradeEventPostFill3s(input);
            if (changes === 1) {
                logger.info({ eventId: input.id }, 'Recorded post-fill 3s snapshot');
            } else {
                logger.warn({ eventId: input.id, changes }, 'Post-fill 3s snapshot update affected no rows');
            }
        } catch (err) {
            logger.warn({ err, eventId: input.id }, 'Failed to record post-fill 3s snapshot');
        }
    }

    /**
     * Record multiple events and optionally a snapshot in a single transaction
     */
    recordBatch(events: TradeEventInput[], snapshot?: MarketSnapshotInput): void {
        if (!this.ensureInitialized()) return;

        try {
            const eventRecords: TradeEventRecord[] = events.map(input => ({
                id: generateId(),
                ts: Date.now(),
                pairKey: canonicalizePairKey(input.pairKey),
                strategy: input.strategy,
                action: input.action,
                side: input.side ?? null,
                intentPrice: input.intentPrice ?? null,
                intentSizeBase: input.intentSizeBase ?? null,
                intentSizeQuote: input.intentSizeQuote ?? null,
                fillPrice: input.fillPrice ?? null,
                fillSizeBase: input.fillSizeBase ?? null,
                fillSizeQuote: input.fillSizeQuote ?? null,
                txHash: input.txHash ?? null,
                ledgerIndex: input.ledgerIndex ?? null,
                resultCode: input.resultCode ?? null,
                error: this.sanitizeError(input.error),
                isBotTrade: input.isBotTrade !== undefined ? (input.isBotTrade ? 1 : 0) : null,
                midPriceAtDecision: input.midPriceAtDecision ?? null,
                // Cost realism fields
                slippageBpsVsIntent: input.slippageBpsVsIntent ?? null,
                slippageBpsVsMid: input.slippageBpsVsMid ?? null,
                slippageBpsVsBbo: input.slippageBpsVsBbo ?? null,
                expectedPriceSource: input.expectedPriceSource ?? null,
                decisionMidPrice: input.decisionMidPrice ?? null,
                decisionBestBid: input.decisionBestBid ?? null,
                decisionBestAsk: input.decisionBestAsk ?? null,
                spreadPaidBps: input.spreadPaidBps ?? null,
                edgeBpsVsMid: input.edgeBpsVsMid ?? null,
                netEdgeBpsVsMid: input.netEdgeBpsVsMid ?? null,
                txFeeXrp: input.txFeeXrp ?? null,
                ammFeeBps: input.ammFeeBps ?? null,
                fillRatio: input.fillRatio ?? null,
                isPartial: input.isPartial != null ? (input.isPartial ? 1 : 0) : null,
                entrySpreadBps: input.entrySpreadBps ?? null,
                entryFlowCombined: input.entryFlowCombined ?? null,
                entryFlowStrength: input.entryFlowStrength ?? null,
                entryFlowRegime: input.entryFlowRegime ?? null,
                postMid1s: input.postMid1s ?? null,
                postSpread1s: input.postSpread1s ?? null,
                postFlowCombined1s: input.postFlowCombined1s ?? null,
                postFlowStrength1s: input.postFlowStrength1s ?? null,
                postFlowRegime1s: input.postFlowRegime1s ?? null,
                postMid3s: input.postMid3s ?? null,
                postSpread3s: input.postSpread3s ?? null,
                postFlowCombined3s: input.postFlowCombined3s ?? null,
                postFlowStrength3s: input.postFlowStrength3s ?? null,
                postFlowRegime3s: input.postFlowRegime3s ?? null,
                entryMid: input.entryMid ?? null,
                entrySignalStrength: input.entrySignalStrength ?? null,
                entryLocalExtreme: input.entryLocalExtreme ?? null,
                postSignal1s: input.postSignal1s ?? null,
                postSignal3s: input.postSignal3s ?? null,
            }));

            let snapshotRecord: MarketSnapshotRecord | undefined;
            if (snapshot) {
                snapshotRecord = {
                    id: generateId(),
                    ts: Date.now(),
                    pairKey: canonicalizePairKey(snapshot.pairKey),
                    ledgerIndex: snapshot.ledgerIndex,
                    midPrice: this.computeMidPrice(snapshot.orderBook),
                    spreadBps: snapshot.orderBook.spread ?? null,
                    bestBid: snapshot.orderBook.bids[0]?.price ?? null,
                    bestAsk: snapshot.orderBook.asks[0]?.price ?? null,
                    bidDepthBase: snapshot.orderBook.bids.reduce((sum, b) => sum + b.quantity, 0),
                    askDepthBase: snapshot.orderBook.asks.reduce((sum, a) => sum + a.quantity, 0),
                    flowRegime: snapshot.flow?.regime ?? null,
                    flowImbalance: snapshot.flow?.imbalance ?? null,
                    flowDepthImbalance: snapshot.flow?.depthImbalance ?? null,
                    flowCombined: snapshot.flow?.combinedSignal ?? null,
                    flowStrength: snapshot.flow?.signalStrength ?? null,
                    vwap: snapshot.flow?.vwap ?? null,
                    vwapDeviationBps: snapshot.flow?.vwapDeviationBps ?? null,
                    tradeCount: snapshot.flow?.tradeCount ?? null,
                    volumeVelocity: snapshot.flow?.volumeVelocity ?? null,
                    adverseSelectionRisk: snapshot.flow
                        ? (hasAdverseSelectionRisk(snapshot.flow) ? 1 : 0)
                        : null,
                };
            }

            insertBatch(eventRecords, snapshotRecord);
        } catch (err) {
            logger.warn({ err, eventCount: events.length }, 'Failed to record batch');
        }
    }

    recordExecutionQualityEvent(input: ExecutionQualityEventInput): string | null {
        if (!this.ensureInitialized()) return null;

        try {
            const canonicalPair = canonicalizePairKey(input.pairKey);
            const aliases = getPairKeyAliases(canonicalPair);
            const metrics = buildExecutionQualityMetrics({
                side: input.side,
                intentPrice: input.intentPrice ?? null,
                midAtDecision: input.decisionMid ?? null,
                bboAtDecision: input.side === 'buy' ? (input.decisionAsk ?? null) : (input.decisionBid ?? null),
                decisionPrice: input.expectedPrice ?? input.intentPrice ?? null,
                fillPrice: input.fillPrice ?? null,
                amountBase: input.amountBase ?? null,
                filledBase: input.filledBase ?? null,
                midAfter1m: null,
                midAfter5m: null,
            });

            const event: ExecutionQualityEventRecord = {
                id: generateId(),
                ts: input.ts ?? Date.now(),
                eventId: input.eventId ?? null,
                txHash: input.txHash ?? null,
                pairKeyCanonical: canonicalPair,
                pairAliases: JSON.stringify(aliases),
                side: input.side,
                strategy: input.strategy ?? null,
                regime: input.regime ?? null,
                source: input.source ?? 'unknown',
                intentPrice: input.intentPrice ?? null,
                expectedPrice: input.expectedPrice ?? null,
                expectedPriceSource: input.expectedPriceSource ?? null,
                decisionMid: input.decisionMid ?? null,
                decisionBid: input.decisionBid ?? null,
                decisionAsk: input.decisionAsk ?? null,
                fillPrice: input.fillPrice ?? null,
                amountBase: input.amountBase ?? null,
                filledBase: input.filledBase ?? null,
                filledQuote: input.filledQuote ?? null,
                slippageBpsVsIntent: input.slippageBpsVsIntent ?? metrics.slippageBpsVsIntent,
                slippageBpsVsMid: input.slippageBpsVsMid ?? metrics.slippageBpsVsMid,
                slippageBpsVsBbo: input.slippageBpsVsBbo ?? metrics.slippageBpsVsBbo,
                effSpreadBps: input.effSpreadBps ?? metrics.effSpreadBps,
                realizedSpreadBps1m: input.realizedSpreadBps1m ?? null,
                realizedSpreadBps5m: input.realizedSpreadBps5m ?? null,
                impactBps1m: input.impactBps1m ?? null,
                impactBps5m: input.impactBps5m ?? null,
                implShortfallQuote: input.implShortfallQuote ?? metrics.implShortfallQuote,
                fillRatio: input.fillRatio ?? metrics.fillRatio,
                status: input.status ?? null,
                rejectReason: input.rejectReason ?? null,
                flags: input.flags ? JSON.stringify(input.flags) : null,
                guardQuarantined: input.guardQuarantined == null ? null : (input.guardQuarantined ? 1 : 0),
                decisionTs: input.decisionTs ?? null,
                submitTs: input.submitTs ?? null,
                validatedTs: input.validatedTs ?? null,
                decisionToSubmitMs: input.decisionToSubmitMs ?? null,
                submitToValidatedMs: input.submitToValidatedMs ?? null,
                decisionToValidatedMs: input.decisionToValidatedMs ?? null,
            };

            return insertExecutionQualityEvent(event);
        } catch (err) {
            logger.warn({ err, pairKey: input.pairKey, txHash: input.txHash }, 'Failed to record execution quality event');
            return null;
        }
    }

    updateExecutionQualityHorizons(input: {
        id: string;
        pairKey: string;
        side: 'buy' | 'sell';
        fillPrice: number;
        decisionMid: number;
        fillTs: number;
    }): void {
        if (!this.ensureInitialized()) return;
        try {
            const pair = canonicalizePairKey(input.pairKey);
            const snapshot1m = getSnapshotNear(pair, input.fillTs + 60_000, 120_000);
            const snapshot5m = getSnapshotNear(pair, input.fillTs + 300_000, 180_000);
            const midAfter1m = snapshot1m?.midPrice ?? null;
            const midAfter5m = snapshot5m?.midPrice ?? null;

            const realizedSpreadBps1m = computeRealizedSpreadBps(input.side, input.fillPrice, input.decisionMid, midAfter1m);
            const realizedSpreadBps5m = computeRealizedSpreadBps(input.side, input.fillPrice, input.decisionMid, midAfter5m);
            const impactBps1m = computeImpactBps(input.side, input.decisionMid, midAfter1m);
            const impactBps5m = computeImpactBps(input.side, input.decisionMid, midAfter5m);

            updateExecutionQualityHorizonsDb({
                id: input.id,
                realizedSpreadBps1m,
                realizedSpreadBps5m,
                impactBps1m,
                impactBps5m,
            });
        } catch (err) {
            logger.warn({ err, id: input.id }, 'Failed to update execution quality horizons');
        }
    }

    recordEdgeAttributionEvent(input: EdgeAttributionEventInput): string | null {
        if (!this.ensureInitialized()) return null;

        try {
            const canonicalPair = canonicalizePairKey(input.pairKey);
            const aliases = getPairKeyAliases(canonicalPair);
            const metrics = buildEdgeAttributionMetrics({
                side: input.side,
                midDecision: input.midDecision ?? null,
                bidDecision: input.bidDecision ?? null,
                askDecision: input.askDecision ?? null,
                fillPrice: input.fillPrice ?? null,
                baseFilled: input.baseFilled ?? null,
                strategyFair: input.strategyFair ?? null,
                midDecision1m: null,
                midDecision5m: null,
                midFill1m: null,
                midFill5m: null,
            });

            const event: EdgeAttributionEventRecord = {
                id: generateId(),
                ts: input.ts ?? Date.now(),
                eventId: input.eventId ?? null,
                txHash: input.txHash ?? null,
                pairKeyCanonical: canonicalPair,
                pairAliases: JSON.stringify(aliases),
                side: input.side,
                strategy: input.strategy ?? null,
                regime: input.regime ?? null,
                source: input.source ?? 'unknown',
                midDecision: input.midDecision ?? null,
                bidDecision: input.bidDecision ?? null,
                askDecision: input.askDecision ?? null,
                fillPrice: input.fillPrice ?? null,
                midFill: input.midFill ?? null,
                mid1m: null,
                mid5m: null,
                baseFilled: input.baseFilled ?? null,
                filledQuote: input.filledQuote ?? null,
                signalEdgeBpsExAnte: metrics.signalEdgeBpsExAnte,
                signalEdgeBpsExPost1m: null,
                signalEdgeBpsExPost5m: null,
                executionEdgeBpsVsMid: metrics.executionEdgeBpsVsMid,
                executionEdgeBpsVsBbo: metrics.executionEdgeBpsVsBbo,
                driftBps1m: null,
                driftBps5m: null,
                pnlExecQuote: metrics.pnlExecQuote,
                pnlDriftQuote1m: null,
                pnlTotalQuote1m: null,
                pnlDriftQuote5m: null,
                pnlTotalQuote5m: null,
                hasDecisionSnapshot: metrics.hasDecisionSnapshot ? 1 : 0,
                hasHorizon1m: 0,
                hasHorizon5m: 0,
            };

            return insertEdgeAttributionEvent(event);
        } catch (err) {
            logger.warn({ err, pairKey: input.pairKey, txHash: input.txHash }, 'Failed to record edge attribution event');
            return null;
        }
    }

    updateEdgeAttributionHorizons(input: {
        id: string;
        pairKey: string;
        side: 'buy' | 'sell';
        midDecision: number;
        fillPrice: number;
        baseFilled: number;
        decisionTs: number;
        fillTs: number;
        strategyFair?: number | null;
    }): void {
        if (!this.ensureInitialized()) return;

        try {
            const pair = canonicalizePairKey(input.pairKey);
            const decision1m = getSnapshotNear(pair, input.decisionTs + 60_000, 120_000);
            const decision5m = getSnapshotNear(pair, input.decisionTs + 300_000, 180_000);
            const fill1m = getSnapshotNear(pair, input.fillTs + 60_000, 120_000);
            const fill5m = getSnapshotNear(pair, input.fillTs + 300_000, 180_000);

            const metrics = buildEdgeAttributionMetrics({
                side: input.side,
                midDecision: input.midDecision,
                fillPrice: input.fillPrice,
                baseFilled: input.baseFilled,
                strategyFair: input.strategyFair ?? null,
                midDecision1m: decision1m?.midPrice ?? null,
                midDecision5m: decision5m?.midPrice ?? null,
                midFill1m: fill1m?.midPrice ?? null,
                midFill5m: fill5m?.midPrice ?? null,
            });

            if (!validatePnlIdentity(metrics.pnlExecQuote, metrics.pnlDriftQuote1m, metrics.pnlTotalQuote1m)) {
                logger.warn({ id: input.id }, 'Edge attribution pnl identity mismatch at 1m horizon');
            }
            if (!validatePnlIdentity(metrics.pnlExecQuote, metrics.pnlDriftQuote5m, metrics.pnlTotalQuote5m)) {
                logger.warn({ id: input.id }, 'Edge attribution pnl identity mismatch at 5m horizon');
            }

            updateEdgeAttributionHorizonsDb({
                id: input.id,
                mid1m: fill1m?.midPrice ?? null,
                mid5m: fill5m?.midPrice ?? null,
                signalEdgeBpsExPost1m: metrics.signalEdgeBpsExPost1m,
                signalEdgeBpsExPost5m: metrics.signalEdgeBpsExPost5m,
                driftBps1m: metrics.driftBps1m,
                driftBps5m: metrics.driftBps5m,
                pnlDriftQuote1m: metrics.pnlDriftQuote1m,
                pnlTotalQuote1m: metrics.pnlTotalQuote1m,
                pnlDriftQuote5m: metrics.pnlDriftQuote5m,
                pnlTotalQuote5m: metrics.pnlTotalQuote5m,
                hasHorizon1m: metrics.hasHorizon1m ? 1 : 0,
                hasHorizon5m: metrics.hasHorizon5m ? 1 : 0,
            });
        } catch (err) {
            logger.warn({ err, id: input.id }, 'Failed to update edge attribution horizons');
        }
    }

    /**
     * Get analytics summary
     */
    getSummary(filters: QueryFilters = {}): AnalyticsSummary {
        if (!this.ensureInitialized()) {
            return this.emptySummary();
        }

        try {
            const events = queryTradeEvents(filters);
            return this.computeSummary(events);
        } catch (err) {
            logger.warn({ err }, 'Failed to get summary');
            return this.emptySummary();
        }
    }

    /**
     * Get regime performance matrix
     */
    getRegimeMatrix(filters: QueryFilters = {}): RegimeStats[] {
        if (!this.ensureInitialized()) {
            return [];
        }

        try {
            const events = queryTradeEvents(filters);
            const regimes: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];
            const result: RegimeStats[] = [];

            for (const regime of regimes) {
                // Get events that occurred during this regime
                const regimeEvents = this.getEventsForRegime(events, regime, filters);
                if (regimeEvents.length === 0) {
                    result.push({
                        regime,
                        trades: 0,
                        winRate: 0,
                        expectancy: 0,
                        profitFactor: 0,
                        avgSlippageBps: 0,
                        totalPnl: 0,
                        pnlPerTrade: 0,
                    });
                    continue;
                }

                const summary = this.computeSummary(regimeEvents);
                result.push({
                    regime,
                    trades: summary.trades,
                    winRate: summary.winRate,
                    expectancy: summary.expectancy,
                    profitFactor: summary.profitFactor,
                    avgSlippageBps: summary.avgSlippageBps,
                    totalPnl: summary.totalPnlApprox,
                    pnlPerTrade: summary.trades > 0 ? summary.totalPnlApprox / summary.trades : 0,
                });
            }

            return result;
        } catch (err) {
            logger.warn({ err }, 'Failed to get regime matrix');
            return [];
        }
    }

    /**
     * Get per-strategy statistics
     */
    getStrategyStats(filters: QueryFilters = {}): StrategyStats[] {
        if (!this.ensureInitialized()) {
            return [];
        }

        try {
            const events = queryTradeEvents(filters);
            const strategies = new Set(events.map(e => e.strategy));
            const result: StrategyStats[] = [];

            for (const strategy of strategies) {
                const strategyEvents = events.filter(e => e.strategy === strategy);
                const summary = this.computeSummary(strategyEvents);
                result.push({
                    strategy,
                    trades: summary.trades,
                    winRate: summary.winRate,
                    expectancy: summary.expectancy,
                    profitFactor: summary.profitFactor,
                });
            }

            return result.sort((a, b) => b.trades - a.trades);
        } catch (err) {
            logger.warn({ err }, 'Failed to get strategy stats');
            return [];
        }
    }

    /**
     * Get rolling drawdown series
     */
    getRollingDrawdown(filters: QueryFilters = {}, bucketMs: number = 3600000): DrawdownPoint[] {
        if (!this.ensureInitialized()) {
            return [];
        }

        try {
            const events = queryTradeEvents(filters);
            if (events.length === 0) return [];

            // Sort by timestamp ascending
            const sorted = [...events].sort((a, b) => a.ts - b.ts);
            const firstEvent = sorted[0];
            if (!firstEvent) return [];

            // Calculate cumulative equity curve
            let equity = 0;
            let maxEquity = 0;
            const points: DrawdownPoint[] = [];
            let currentBucket = Math.floor(firstEvent.ts / bucketMs) * bucketMs;
            let bucketPnl = 0;

            for (const event of sorted) {
                const pnl = this.computeEventPnl(event);
                const eventBucket = Math.floor(event.ts / bucketMs) * bucketMs;

                if (eventBucket > currentBucket) {
                    // Emit point for completed bucket
                    equity += bucketPnl;
                    maxEquity = Math.max(maxEquity, equity);
                    const drawdown = maxEquity > 0 ? (maxEquity - equity) / maxEquity : 0;
                    points.push({ ts: currentBucket, equity, drawdown });

                    // Start new bucket
                    currentBucket = eventBucket;
                    bucketPnl = pnl;
                } else {
                    bucketPnl += pnl;
                }
            }

            // Emit final bucket
            equity += bucketPnl;
            maxEquity = Math.max(maxEquity, equity);
            const drawdown = maxEquity > 0 ? (maxEquity - equity) / maxEquity : 0;
            points.push({ ts: currentBucket, equity, drawdown });

            return points;
        } catch (err) {
            logger.warn({ err }, 'Failed to get rolling drawdown');
            return [];
        }
    }

    /**
     * Get complete analytics response
     */
    getAnalytics(filters: QueryFilters = {}): AnalyticsResponse {
        const drawdown = this.getRollingDrawdown(filters);
        return {
            summary: this.getSummary(filters),
            byRegime: this.getRegimeMatrix(filters),
            byStrategy: this.getStrategyStats(filters),
            drawdown,
            drawdownVelocity: this.computeDrawdownVelocity(drawdown),
            profitFactorSeries: this.computeProfitFactorSeries(filters),
        };
    }

    /**
     * Get regime heatmap with detailed stats for policy computation.
     * Returns both global (across all strategies) and per-strategy breakdowns.
     */
    getRegimeHeatmap(options: RegimeHeatmapOptions = {}): RegimeHeatmapResponse {
        const lookbackHours = options.lookbackHours ?? 24;
        const minTrades = options.minTrades ?? 5;
        const byStrategy = options.byStrategy ?? true;

        const ALL_REGIMES: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];

        if (!this.ensureInitialized()) {
            return this.emptyRegimeHeatmap(lookbackHours, minTrades, ALL_REGIMES);
        }

        try {
            const sinceMs = Date.now() - lookbackHours * 60 * 60 * 1000;
            const events = queryTradeEvents({ sinceMs });

            // Filter to bot fills only
            const fills = events.filter(e =>
                (e.action === 'fill' || (e.action === 'offer_create' && e.fillPrice)) &&
                e.isBotTrade === 1
            );

            // Enrich with regime context. Prefer nearest snapshot; fall back to
            // entry/post-fill regime fields captured on the trade event itself.
            const enriched = fills.map(event => {
                const snapshot = getSnapshotNear(event.pairKey, event.ts, 10000);
                return {
                    event,
                    regime: this.resolveEventRegime(event, snapshot?.flowRegime ?? null),
                    spreadBps: this.resolveEventSpreadBps(event, snapshot?.spreadBps ?? null),
                };
            }).filter(e => e.regime !== null) as Array<{
                event: TradeEventRecord;
                regime: FlowRegime;
                spreadBps: number | null;
            }>;

            // Global aggregation by regime
            const globalCells = this.computeRegimeHeatmapCells(enriched, ALL_REGIMES, minTrades);

            // Per-strategy aggregation
            const perStrategy: Record<string, Record<FlowRegime, RegimeHeatmapCell>> = {};

            if (byStrategy) {
                const strategies = new Set(enriched.map(e => e.event.strategy));
                for (const strategy of strategies) {
                    const strategyEnriched = enriched.filter(e => e.event.strategy === strategy);
                    perStrategy[strategy] = this.computeRegimeHeatmapCells(strategyEnriched, ALL_REGIMES, minTrades);
                }
            }

            return {
                global: globalCells,
                perStrategy,
                meta: {
                    lookbackHours,
                    minTrades,
                    totalTrades: enriched.length,
                    computedAt: Date.now(),
                },
            };
        } catch (err) {
            logger.warn({ err }, 'Failed to compute regime heatmap');
            return this.emptyRegimeHeatmap(lookbackHours, minTrades, ALL_REGIMES);
        }
    }

    /**
     * Compute heatmap cells for a set of enriched events
     */
    private computeRegimeHeatmapCells(
        enriched: Array<{ event: TradeEventRecord; regime: FlowRegime; spreadBps: number | null }>,
        regimes: FlowRegime[],
        minTrades: number
    ): Record<FlowRegime, RegimeHeatmapCell> {
        const result: Record<FlowRegime, RegimeHeatmapCell> = {} as Record<FlowRegime, RegimeHeatmapCell>;

        for (const regime of regimes) {
            const regimeEvents = enriched.filter(e => e.regime === regime);
            const trades = regimeEvents.length;

            if (trades < minTrades) {
                // Insufficient data - return null/zero cell
                result[regime] = this.emptyHeatmapCell(regime);
                continue;
            }

            let wins = 0;
            let losses = 0;
            let totalGain = 0;
            let totalLoss = 0;
            let sumEdgeBps = 0;
            let edgeCount = 0;
            let sumSlippageBps = 0;
            let slippageCount = 0;
            let sumSpreadBps = 0;
            let spreadCount = 0;
            let partialCount = 0;
            let totalTradeSize = 0;

            for (const { event, spreadBps } of regimeEvents) {
                const pnl = this.computeEventPnl(event);
                const edge = this.computeEdgeBps(event);
                const slippage = event.slippageBpsVsIntent ?? this.computeSlippageBps(event);

                if (pnl > 0) {
                    wins++;
                    totalGain += pnl;
                } else if (pnl < 0) {
                    losses++;
                    totalLoss += Math.abs(pnl);
                }
                // pnl === 0: skip — neither win nor loss

                if (edge !== null) {
                    sumEdgeBps += edge;
                    edgeCount++;
                }

                if (slippage !== null) {
                    sumSlippageBps += Math.abs(slippage);
                    slippageCount++;
                }

                if (spreadBps !== null) {
                    sumSpreadBps += spreadBps;
                    spreadCount++;
                }

                if (event.isPartial === 1) {
                    partialCount++;
                }

                if (event.fillSizeBase) {
                    totalTradeSize += event.fillSizeBase;
                }
            }

            const classifiable = wins + losses;
            const winRate = classifiable > 0 ? wins / classifiable : 0;
            const avgTradeSize = trades > 0 ? totalTradeSize / trades : 1;
            const profitFactor = totalLoss > 0 ? totalGain / totalLoss : (totalGain > 0 ? 10 : 1);

            // Expectancy in bps
            const avgWin = wins > 0 ? totalGain / wins : 0;
            const avgLoss = losses > 0 ? totalLoss / losses : 0;
            const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
            const expectancyBps = avgTradeSize > 0 ? (expectancy / avgTradeSize) * 10000 : 0;

            const avgEdgeBps = edgeCount > 0 ? sumEdgeBps / edgeCount : 0;
            const avgSlippageBps = slippageCount > 0 ? sumSlippageBps / slippageCount : 0;
            const avgSpreadBps = spreadCount > 0 ? sumSpreadBps / spreadCount : 0;
            const partialFillRate = trades > 0 ? partialCount / trades : 0;

            // Composite score: expectancyBps - 0.5*avgSlippageBps - 0.25*avgSpreadBps - 20*partialFillRate
            // This penalizes high slippage/spread and partial fills
            let score = expectancyBps - (0.5 * avgSlippageBps) - (0.25 * avgSpreadBps) - (20 * partialFillRate);

            // Clamp score to [-100, 100] to avoid outliers
            score = Math.max(-100, Math.min(100, score));

            result[regime] = {
                regime,
                trades,
                winRate,
                profitFactor: Number.isFinite(profitFactor) ? profitFactor : 10,
                expectancyBps: Number.isFinite(expectancyBps) ? expectancyBps : 0,
                avgEdgeBps,
                avgSlippageBps,
                avgSpreadBps,
                partialFillRate,
                score,
            };
        }

        return result;
    }

    /**
     * Return empty heatmap cell for insufficient data
     */
    private emptyHeatmapCell(regime: FlowRegime): RegimeHeatmapCell {
        return {
            regime,
            trades: 0,
            winRate: 0,
            profitFactor: 1,
            expectancyBps: 0,
            avgEdgeBps: 0,
            avgSlippageBps: 0,
            avgSpreadBps: 0,
            partialFillRate: 0,
            score: 0,
        };
    }

    /**
     * Return empty regime heatmap for error cases
     */
    private emptyRegimeHeatmap(
        lookbackHours: number,
        minTrades: number,
        regimes: FlowRegime[]
    ): RegimeHeatmapResponse {
        const global: Record<FlowRegime, RegimeHeatmapCell> = {} as Record<FlowRegime, RegimeHeatmapCell>;
        for (const regime of regimes) {
            global[regime] = this.emptyHeatmapCell(regime);
        }
        return {
            global,
            perStrategy: {},
            meta: {
                lookbackHours,
                minTrades,
                totalTrades: 0,
                computedAt: Date.now(),
            },
        };
    }

    /**
     * Get cost realism summary
     * Aggregates slippage, edge, spread, and fee metrics across fills
     */
    getCostSummary(filters: QueryFilters = {}): CostSummary {
        if (!this.ensureInitialized()) {
            return this.emptyCostSummary();
        }

        try {
            const events = queryTradeEvents(filters);
            // Only include fills with cost data
            const fills = events.filter(e =>
                (e.action === 'fill' || (e.action === 'offer_create' && e.fillPrice)) &&
                e.slippageBpsVsIntent != null
            );

            if (fills.length === 0) {
                return this.emptyCostSummary();
            }

            let sumSlippageVsIntent = 0;
            let countSlippageVsIntent = 0;
            let sumSlippageVsMid = 0;
            let countSlippageVsMid = 0;
            let sumSpreadPaid = 0;
            let countSpreadPaid = 0;
            let sumEdgeVsMid = 0;
            let countEdgeVsMid = 0;
            let sumNetEdgeVsMid = 0;
            let countNetEdgeVsMid = 0;
            let sumTxFee = 0;
            let countTxFee = 0;
            let sumFillRatio = 0;
            let countFillRatio = 0;
            let partialCount = 0;

            for (const e of fills) {
                if (e.slippageBpsVsIntent != null) {
                    sumSlippageVsIntent += e.slippageBpsVsIntent;
                    countSlippageVsIntent++;
                }
                if (e.slippageBpsVsMid != null) {
                    sumSlippageVsMid += e.slippageBpsVsMid;
                    countSlippageVsMid++;
                }
                if (e.spreadPaidBps != null) {
                    sumSpreadPaid += e.spreadPaidBps;
                    countSpreadPaid++;
                }
                if (e.edgeBpsVsMid != null) {
                    sumEdgeVsMid += e.edgeBpsVsMid;
                    countEdgeVsMid++;
                }
                if (e.netEdgeBpsVsMid != null) {
                    sumNetEdgeVsMid += e.netEdgeBpsVsMid;
                    countNetEdgeVsMid++;
                }
                if (e.txFeeXrp != null) {
                    sumTxFee += e.txFeeXrp;
                    countTxFee++;
                }
                if (e.fillRatio != null) {
                    sumFillRatio += e.fillRatio;
                    countFillRatio++;
                }
                if (e.isPartial === 1) {
                    partialCount++;
                }
            }

            return {
                fills: fills.length,
                avgSlippageBpsVsIntent: countSlippageVsIntent > 0 ? sumSlippageVsIntent / countSlippageVsIntent : null,
                avgSlippageBpsVsMid: countSlippageVsMid > 0 ? sumSlippageVsMid / countSlippageVsMid : null,
                avgSpreadPaidBps: countSpreadPaid > 0 ? sumSpreadPaid / countSpreadPaid : null,
                avgEdgeBpsVsMid: countEdgeVsMid > 0 ? sumEdgeVsMid / countEdgeVsMid : null,
                avgNetEdgeBpsVsMid: countNetEdgeVsMid > 0 ? sumNetEdgeVsMid / countNetEdgeVsMid : null,
                avgTxFeeXrp: countTxFee > 0 ? sumTxFee / countTxFee : null,
                totalTxFeeXrp: countTxFee > 0 ? sumTxFee : null,
                partialFillRatio: fills.length > 0 ? partialCount / fills.length : 0,
                avgFillRatio: countFillRatio > 0 ? sumFillRatio / countFillRatio : null,
            };
        } catch (err) {
            logger.warn({ err }, 'Failed to get cost summary');
            return this.emptyCostSummary();
        }
    }

    getExecutionQualityAnalytics(filters: ExecutionQualityFilters = {}): ExecutionQualityAnalytics {
        if (!this.ensureInitialized()) {
            return this.emptyExecutionQualityAnalytics(filters.bucketMs ?? 60_000);
        }

        try {
            const bucketMs = Math.max(1_000, Math.min(86_400_000, filters.bucketMs ?? 60_000));
            const queryFilters: ExecutionQualityQueryFilters = {};
            if (filters.pairKey) queryFilters.pairKey = filters.pairKey;
            if (filters.sinceMs != null) queryFilters.sinceMs = filters.sinceMs;
            if (filters.strategy) queryFilters.strategy = filters.strategy;
            if (filters.side) queryFilters.side = filters.side;
            if (filters.source) queryFilters.source = filters.source;

            const events = queryExecutionQualityEvents(queryFilters);

            const fills = events.filter((e) => e.status === 'FILLED' || e.status === 'PARTIAL');
            const rejects = events.filter((e) => e.status === 'REJECTED');
            const partials = events.filter((e) => e.status === 'PARTIAL');

            const summary: ExecutionQualitySummary = {
                events: events.length,
                fills: fills.length,
                rejects: rejects.length,
                partials: partials.length,
                coverage1m: fills.length > 0 ? fills.filter((e) => e.realizedSpreadBps1m != null).length / fills.length : 0,
                coverage5m: fills.length > 0 ? fills.filter((e) => e.realizedSpreadBps5m != null).length / fills.length : 0,
                avgSlippageBpsVsIntent: this.avg(fills.map((e) => e.slippageBpsVsIntent)),
                avgSlippageBpsVsMid: this.avg(fills.map((e) => e.slippageBpsVsMid)),
                avgSlippageBpsVsBbo: this.avg(fills.map((e) => e.slippageBpsVsBbo)),
                avgEffSpreadBps: this.avg(fills.map((e) => e.effSpreadBps)),
                avgRealizedSpreadBps1m: this.avg(fills.map((e) => e.realizedSpreadBps1m)),
                avgRealizedSpreadBps5m: this.avg(fills.map((e) => e.realizedSpreadBps5m)),
                avgImpactBps1m: this.avg(fills.map((e) => e.impactBps1m)),
                avgImpactBps5m: this.avg(fills.map((e) => e.impactBps5m)),
                avgFillRatio: this.avg(fills.map((e) => e.fillRatio)),
                avgDecisionToSubmitMs: this.avg(events.map((e) => e.decisionToSubmitMs)),
                avgSubmitToValidatedMs: this.avg(events.map((e) => e.submitToValidatedMs)),
                avgDecisionToValidatedMs: this.avg(events.map((e) => e.decisionToValidatedMs)),
            };

            const series = this.buildExecutionQualitySeries(events, bucketMs);
            const slippageValues = fills
                .map((e) => e.slippageBpsVsIntent)
                .filter((v): v is number => v != null && Number.isFinite(v));
            const spreadValues = fills
                .map((e) => e.effSpreadBps)
                .filter((v): v is number => v != null && Number.isFinite(v));
            const driftValues = fills
                .map((e) => e.impactBps1m ?? e.impactBps5m)
                .filter((v): v is number => v != null && Number.isFinite(v));

            const histograms = {
                slippageBps: this.buildHistogram(slippageValues),
                spreadBps: this.buildHistogram(spreadValues),
                postTradeDriftBps: this.buildHistogram(driftValues),
            };

            const breakdowns = {
                byPair: this.buildExecutionQualityBreakdown(events, (e) => e.pairKeyCanonical),
                byStrategy: this.buildExecutionQualityBreakdown(events, (e) => e.strategy ?? 'unknown'),
                bySide: this.buildExecutionQualityBreakdown(events, (e) => e.side ?? 'unknown'),
                byRegime: this.buildExecutionQualityBreakdown(events, (e) => e.regime ?? 'unknown'),
            };

            const anomalies: ExecutionQualityAnomalies = {
                suspiciousSlippageSpikes: fills.filter((e) => {
                    const s = e.slippageBpsVsIntent;
                    return s != null && Number.isFinite(s) && (s < -100 || s > 500);
                }).length,
                partialFillAnomalies: partials.filter((e) => (e.fillRatio ?? 0) < 0.999).length,
                quoteBaseIntegrityViolations: fills.filter((e) => {
                    if (!Number.isFinite(e.fillPrice ?? null) || (e.fillPrice ?? 0) <= 0) return true;
                    if (!Number.isFinite(e.filledBase ?? null) || (e.filledBase ?? -1) < 0) return true;
                    if ((e.amountBase ?? 0) > 0 && (e.filledBase ?? 0) > (e.amountBase ?? 0) + 1e-9) return true;
                    return false;
                }).length,
            };

            return {
                summary,
                series,
                histograms,
                breakdowns,
                anomalies,
            };
        } catch (err) {
            logger.warn({ err, filters }, 'Failed to compute execution quality analytics');
            return this.emptyExecutionQualityAnalytics(filters.bucketMs ?? 60_000);
        }
    }

    getEdgeAttributionAnalytics(filters: EdgeAttributionFilters = {}): EdgeAttributionAnalytics {
        if (!this.ensureInitialized()) {
            return this.emptyEdgeAttributionAnalytics(filters.bucketMs ?? 60_000);
        }

        try {
            const bucketMs = Math.max(1_000, Math.min(86_400_000, filters.bucketMs ?? 60_000));
            const queryFilters: EdgeAttributionQueryFilters = {};
            if (filters.pairKey) queryFilters.pairKey = filters.pairKey;
            if (filters.sinceMs != null) queryFilters.sinceMs = filters.sinceMs;
            if (filters.strategy) queryFilters.strategy = filters.strategy;
            if (filters.side) queryFilters.side = filters.side;
            if (filters.source) queryFilters.source = filters.source;

            const events = queryEdgeAttributionEvents(queryFilters);

            const summary: EdgeAttributionSummary = {
                events: events.length,
                coverageDecision: events.length > 0 ? events.filter((e) => e.hasDecisionSnapshot === 1).length / events.length : 0,
                coverage1m: events.length > 0 ? events.filter((e) => e.hasHorizon1m === 1).length / events.length : 0,
                coverage5m: events.length > 0 ? events.filter((e) => e.hasHorizon5m === 1).length / events.length : 0,
                avgSignalEdgeBpsExAnte: this.avg(events.map((e) => e.signalEdgeBpsExAnte)),
                avgSignalEdgeBpsExPost1m: this.avg(events.map((e) => e.signalEdgeBpsExPost1m)),
                avgSignalEdgeBpsExPost5m: this.avg(events.map((e) => e.signalEdgeBpsExPost5m)),
                avgExecutionEdgeBpsVsMid: this.avg(events.map((e) => e.executionEdgeBpsVsMid)),
                avgExecutionEdgeBpsVsBbo: this.avg(events.map((e) => e.executionEdgeBpsVsBbo)),
                avgDriftBps1m: this.avg(events.map((e) => e.driftBps1m)),
                avgDriftBps5m: this.avg(events.map((e) => e.driftBps5m)),
                avgPnlExecQuote: this.avg(events.map((e) => e.pnlExecQuote)),
                avgPnlTotalQuote1m: this.avg(events.map((e) => e.pnlTotalQuote1m)),
                avgPnlTotalQuote5m: this.avg(events.map((e) => e.pnlTotalQuote5m)),
            };

            const executionEdgeValues = events
                .map((e) => e.executionEdgeBpsVsMid)
                .filter((v): v is number => v != null && Number.isFinite(v));
            const driftValues = events
                .map((e) => e.driftBps1m)
                .filter((v): v is number => v != null && Number.isFinite(v));

            return {
                summary,
                series: this.buildEdgeAttributionSeries(events, bucketMs),
                histograms: {
                    executionEdgeBps: this.buildHistogram(executionEdgeValues),
                    driftBps: this.buildHistogram(driftValues),
                },
                breakdowns: {
                    byPair: this.buildEdgeAttributionBreakdown(events, (e) => e.pairKeyCanonical),
                    byStrategy: this.buildEdgeAttributionBreakdown(events, (e) => e.strategy ?? 'unknown'),
                    bySide: this.buildEdgeAttributionBreakdown(events, (e) => e.side ?? 'unknown'),
                    byRegime: this.buildEdgeAttributionBreakdown(events, (e) => e.regime ?? 'unknown'),
                },
                topTrades: {
                    worstExecution: events
                        .filter((e) => e.executionEdgeBpsVsMid != null && Number.isFinite(e.executionEdgeBpsVsMid))
                        .sort((a, b) => (a.executionEdgeBpsVsMid ?? 0) - (b.executionEdgeBpsVsMid ?? 0))
                        .slice(0, 10)
                        .map((e) => this.toEdgeTopTrade(e)),
                    adverseSelection: events
                        .filter((e) => e.driftBps1m != null && Number.isFinite(e.driftBps1m))
                        .sort((a, b) => (a.driftBps1m ?? 0) - (b.driftBps1m ?? 0))
                        .slice(0, 10)
                        .map((e) => this.toEdgeTopTrade(e)),
                },
            };
        } catch (err) {
            logger.warn({ err, filters }, 'Failed to compute edge attribution analytics');
            return this.emptyEdgeAttributionAnalytics(filters.bucketMs ?? 60_000);
        }
    }

    private emptyExecutionQualityAnalytics(bucketMs: number): ExecutionQualityAnalytics {
        return {
            summary: {
                events: 0,
                fills: 0,
                rejects: 0,
                partials: 0,
                coverage1m: 0,
                coverage5m: 0,
                avgSlippageBpsVsIntent: null,
                avgSlippageBpsVsMid: null,
                avgSlippageBpsVsBbo: null,
                avgEffSpreadBps: null,
                avgRealizedSpreadBps1m: null,
                avgRealizedSpreadBps5m: null,
                avgImpactBps1m: null,
                avgImpactBps5m: null,
                avgFillRatio: null,
                avgDecisionToSubmitMs: null,
                avgSubmitToValidatedMs: null,
                avgDecisionToValidatedMs: null,
            },
            series: this.buildExecutionQualitySeries([], bucketMs),
            histograms: {
                slippageBps: this.buildHistogram([]),
                spreadBps: this.buildHistogram([]),
                postTradeDriftBps: this.buildHistogram([]),
            },
            breakdowns: {
                byPair: [],
                byStrategy: [],
                bySide: [],
                byRegime: [],
            },
            anomalies: {
                suspiciousSlippageSpikes: 0,
                partialFillAnomalies: 0,
                quoteBaseIntegrityViolations: 0,
            },
        };
    }

    private emptyEdgeAttributionAnalytics(bucketMs: number): EdgeAttributionAnalytics {
        return {
            summary: {
                events: 0,
                coverageDecision: 0,
                coverage1m: 0,
                coverage5m: 0,
                avgSignalEdgeBpsExAnte: null,
                avgSignalEdgeBpsExPost1m: null,
                avgSignalEdgeBpsExPost5m: null,
                avgExecutionEdgeBpsVsMid: null,
                avgExecutionEdgeBpsVsBbo: null,
                avgDriftBps1m: null,
                avgDriftBps5m: null,
                avgPnlExecQuote: null,
                avgPnlTotalQuote1m: null,
                avgPnlTotalQuote5m: null,
            },
            series: this.buildEdgeAttributionSeries([], bucketMs),
            histograms: {
                executionEdgeBps: this.buildHistogram([]),
                driftBps: this.buildHistogram([]),
            },
            breakdowns: {
                byPair: [],
                byStrategy: [],
                bySide: [],
                byRegime: [],
            },
            topTrades: {
                worstExecution: [],
                adverseSelection: [],
            },
        };
    }

    private avg(values: Array<number | null | undefined>): number | null {
        let sum = 0;
        let count = 0;
        for (const value of values) {
            if (value != null && Number.isFinite(value)) {
                sum += value;
                count++;
            }
        }
        return count > 0 ? sum / count : null;
    }

    private buildExecutionQualitySeries(events: ExecutionQualityEventRecord[], bucketMs: number): ExecutionQualityBucket[] {
        const buckets = new Map<number, {
            count: number;
            slippage: Array<number | null>;
            effSpread: Array<number | null>;
            realized1m: Array<number | null>;
            realized5m: Array<number | null>;
            impact1m: Array<number | null>;
            impact5m: Array<number | null>;
            fillRatio: Array<number | null>;
            decisionToValidated: Array<number | null>;
        }>();

        for (const event of events) {
            const bucketTs = Math.floor(event.ts / bucketMs) * bucketMs;
            const bucket = buckets.get(bucketTs) ?? {
                count: 0,
                slippage: [],
                effSpread: [],
                realized1m: [],
                realized5m: [],
                impact1m: [],
                impact5m: [],
                fillRatio: [],
                decisionToValidated: [],
            };

            bucket.count += 1;
            bucket.slippage.push(event.slippageBpsVsIntent);
            bucket.effSpread.push(event.effSpreadBps);
            bucket.realized1m.push(event.realizedSpreadBps1m);
            bucket.realized5m.push(event.realizedSpreadBps5m);
            bucket.impact1m.push(event.impactBps1m);
            bucket.impact5m.push(event.impactBps5m);
            bucket.fillRatio.push(event.fillRatio);
            bucket.decisionToValidated.push(event.decisionToValidatedMs);
            buckets.set(bucketTs, bucket);
        }

        return Array.from(buckets.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([ts, bucket]) => ({
                ts,
                count: bucket.count,
                avgSlippageBpsVsIntent: this.avg(bucket.slippage),
                avgEffSpreadBps: this.avg(bucket.effSpread),
                avgRealizedSpreadBps1m: this.avg(bucket.realized1m),
                avgRealizedSpreadBps5m: this.avg(bucket.realized5m),
                avgImpactBps1m: this.avg(bucket.impact1m),
                avgImpactBps5m: this.avg(bucket.impact5m),
                avgFillRatio: this.avg(bucket.fillRatio),
                avgDecisionToValidatedMs: this.avg(bucket.decisionToValidated),
            }));
    }

    private buildEdgeAttributionSeries(events: EdgeAttributionEventRecord[], bucketMs: number): EdgeAttributionBucket[] {
        const buckets = new Map<number, {
            count: number;
            executionEdge: Array<number | null>;
            drift1m: Array<number | null>;
            signal1m: Array<number | null>;
            pnlTotal1m: Array<number | null>;
        }>();

        for (const event of events) {
            const bucketTs = Math.floor(event.ts / bucketMs) * bucketMs;
            const bucket = buckets.get(bucketTs) ?? {
                count: 0,
                executionEdge: [],
                drift1m: [],
                signal1m: [],
                pnlTotal1m: [],
            };

            bucket.count += 1;
            bucket.executionEdge.push(event.executionEdgeBpsVsMid);
            bucket.drift1m.push(event.driftBps1m);
            bucket.signal1m.push(event.signalEdgeBpsExPost1m);
            bucket.pnlTotal1m.push(event.pnlTotalQuote1m);
            buckets.set(bucketTs, bucket);
        }

        return Array.from(buckets.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([ts, bucket]) => ({
                ts,
                count: bucket.count,
                avgExecutionEdgeBpsVsMid: this.avg(bucket.executionEdge),
                avgDriftBps1m: this.avg(bucket.drift1m),
                avgSignalEdgeBpsExPost1m: this.avg(bucket.signal1m),
                avgPnlTotalQuote1m: this.avg(bucket.pnlTotal1m),
            }));
    }

    private buildHistogram(values: number[]): ExecutionQualityHistogramBin[] {
        const edges = [-1000, -500, -200, -100, -50, -20, -10, 0, 10, 20, 50, 100, 200, 500, 1000, 2000];
        const bins: ExecutionQualityHistogramBin[] = [];
        for (let i = 0; i < edges.length - 1; i++) {
            bins.push({ min: edges[i]!, max: edges[i + 1]!, count: 0 });
        }

        for (const value of values) {
            for (const bin of bins) {
                if (value >= bin.min && value < bin.max) {
                    bin.count += 1;
                    break;
                }
            }
        }
        return bins;
    }

    private buildExecutionQualityBreakdown(
        events: ExecutionQualityEventRecord[],
        keySelector: (event: ExecutionQualityEventRecord) => string
    ): ExecutionQualityBreakdownRow[] {
        const groups = new Map<string, ExecutionQualityEventRecord[]>();
        for (const event of events) {
            const key = keySelector(event) || 'unknown';
            const list = groups.get(key) ?? [];
            list.push(event);
            groups.set(key, list);
        }

        return Array.from(groups.entries())
            .map(([key, group]) => ({
                key,
                count: group.length,
                avgSlippageBpsVsIntent: this.avg(group.map((e) => e.slippageBpsVsIntent)),
                avgEffSpreadBps: this.avg(group.map((e) => e.effSpreadBps)),
                avgFillRatio: this.avg(group.map((e) => e.fillRatio)),
            }))
            .sort((a, b) => b.count - a.count);
    }

    private buildEdgeAttributionBreakdown(
        events: EdgeAttributionEventRecord[],
        keySelector: (event: EdgeAttributionEventRecord) => string
    ): EdgeAttributionBreakdownRow[] {
        const groups = new Map<string, EdgeAttributionEventRecord[]>();
        for (const event of events) {
            const key = keySelector(event) || 'unknown';
            const list = groups.get(key) ?? [];
            list.push(event);
            groups.set(key, list);
        }

        return Array.from(groups.entries())
            .map(([key, group]) => ({
                key,
                count: group.length,
                avgExecutionEdgeBpsVsMid: this.avg(group.map((e) => e.executionEdgeBpsVsMid)),
                avgDriftBps1m: this.avg(group.map((e) => e.driftBps1m)),
                avgPnlTotalQuote1m: this.avg(group.map((e) => e.pnlTotalQuote1m)),
            }))
            .sort((a, b) => b.count - a.count);
    }

    private toEdgeTopTrade(event: EdgeAttributionEventRecord): EdgeAttributionTopTrade {
        return {
            txHash: event.txHash ?? null,
            ts: event.ts,
            pairKey: event.pairKeyCanonical,
            strategy: event.strategy ?? null,
            side: event.side ?? null,
            executionEdgeBpsVsMid: event.executionEdgeBpsVsMid,
            driftBps1m: event.driftBps1m,
            pnlTotalQuote1m: event.pnlTotalQuote1m,
            fillPrice: event.fillPrice,
            midDecision: event.midDecision,
            baseFilled: event.baseFilled,
        };
    }

    /**
     * Rolling risk metrics for capital protection layer
     */
    getRollingRiskMetrics(params: {
        pairKey?: string;
        lookbackTrades: number;
    }): {
        tradesCount: number;
        profitFactor: number;
        expectancyBps: number;
        drawdownPct: number;
        avgSlippageBps: number;
        partialFillRate: number;
        winRate: number;
    } {
        if (!this.ensureInitialized()) {
            return this.emptyRollingRiskMetrics();
        }

        try {
            // Query most recent trades, optionally filtered by pair
            const filters: QueryFilters = {};
            if (params.pairKey) {
                filters.pairKey = params.pairKey;
            }

            const events = queryTradeEvents(filters);

            // Filter to bot fills only
            const fills = events.filter(e =>
                (e.action === 'fill' || (e.action === 'offer_create' && e.fillPrice)) &&
                e.isBotTrade === 1
            );

            // Sort by timestamp descending and take lookback
            const sorted = [...fills].sort((a, b) => b.ts - a.ts);
            const lookback = sorted.slice(0, params.lookbackTrades);

            if (lookback.length === 0) {
                return this.emptyRollingRiskMetrics();
            }

            // Compute win/loss stats
            let wins = 0;
            let losses = 0;
            let totalGain = 0;
            let totalLoss = 0;
            let totalSlippageBps = 0;
            let slippageCount = 0;
            let partialCount = 0;
            let totalTradeSize = 0;

            for (const event of lookback) {
                const pnl = this.computeEventPnl(event);
                const slippage = event.slippageBpsVsIntent ?? this.computeSlippageBps(event);

                if (pnl > 0) {
                    wins++;
                    totalGain += pnl;
                } else if (pnl < 0) {
                    losses++;
                    totalLoss += Math.abs(pnl);
                }
                // pnl === 0: skip — neither win nor loss (no price data to classify)

                if (slippage !== null) {
                    totalSlippageBps += Math.abs(slippage);
                    slippageCount++;
                }

                if (event.isPartial === 1) {
                    partialCount++;
                }

                if (event.fillSizeBase) {
                    totalTradeSize += event.fillSizeBase;
                }
            }

            const tradesCount = lookback.length;
            const classifiable = wins + losses;
            const winRate = classifiable > 0 ? wins / classifiable : 0;
            const avgTradeSize = tradesCount > 0 ? totalTradeSize / tradesCount : 1;

            // Profit factor
            const profitFactor = totalLoss > 0 ? totalGain / totalLoss : (totalGain > 0 ? Infinity : 1);

            // Expectancy in bps
            const avgWin = wins > 0 ? totalGain / wins : 0;
            const avgLoss = losses > 0 ? totalLoss / losses : 0;
            const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
            const expectancyBps = avgTradeSize > 0 ? (expectancy / avgTradeSize) * 10000 : 0;

            // Average slippage
            const avgSlippageBps = slippageCount > 0 ? totalSlippageBps / slippageCount : 0;

            // Partial fill rate
            const partialFillRate = tradesCount > 0 ? partialCount / tradesCount : 0;

            // Compute drawdown from equity curve
            let equity = 0;
            let peak = 0;
            let maxDrawdown = 0;

            // Process chronologically (reverse the sorted array)
            for (let i = lookback.length - 1; i >= 0; i--) {
                const event = lookback[i];
                if (!event) continue;
                const pnl = this.computeEventPnl(event);
                equity += pnl;
                if (equity > peak) {
                    peak = equity;
                }
                if (peak > 0) {
                    const dd = ((peak - equity) / peak) * 100;
                    if (dd > maxDrawdown) {
                        maxDrawdown = dd;
                    }
                }
            }

            return {
                tradesCount,
                profitFactor: Number.isFinite(profitFactor) ? profitFactor : 100,
                expectancyBps: Number.isFinite(expectancyBps) ? expectancyBps : 0,
                drawdownPct: maxDrawdown,
                avgSlippageBps,
                partialFillRate,
                winRate,
            };
        } catch (err) {
            logger.warn({ err }, 'Failed to get rolling risk metrics');
            return this.emptyRollingRiskMetrics();
        }
    }

    /**
     * Return empty rolling risk metrics for error cases
     */
    private emptyRollingRiskMetrics(): {
        tradesCount: number;
        profitFactor: number;
        expectancyBps: number;
        drawdownPct: number;
        avgSlippageBps: number;
        partialFillRate: number;
        winRate: number;
    } {
        return {
            tradesCount: 0,
            profitFactor: 1,
            expectancyBps: 0,
            drawdownPct: 0,
            avgSlippageBps: 0,
            partialFillRate: 0,
            winRate: 0,
        };
    }

    /**
     * Prune old data
     */
    prune(): void {
        try {
            pruneOldData();
        } catch (err) {
            logger.warn({ err }, 'Failed to prune feedback data');
        }
    }

    /**
     * Get learning dataset for adaptive learning.
     * Returns fill events with their corresponding regime context.
     */
    getLearningDataset(filters: QueryFilters = {}): Array<{ event: TradeEventRecord; regime: FlowRegime | null }> {
        if (!this.ensureInitialized()) {
            return [];
        }

        try {
            const events = queryTradeEvents(filters);

            // Filter to bot fills only
            const fills = events.filter(e =>
                e.action === 'fill' &&
                e.isBotTrade === 1
            );

            // Enrich each fill with regime context. Prefer nearest snapshot;
            // fall back to regime fields captured at decision/post-fill.
            return fills.map(event => {
                const snapshot = getSnapshotNear(event.pairKey, event.ts, 10000);
                return {
                    event,
                    regime: this.resolveEventRegime(event, snapshot?.flowRegime ?? null),
                };
            });
        } catch (err) {
            logger.warn({ err }, 'Failed to get learning dataset');
            return [];
        }
    }

    /**
     * Shutdown the engine
     */
    shutdown(): void {
        // Flush any remaining buffered snapshots before closing
        try {
            this.flushSnapshots();
        } catch {
            // Best-effort on shutdown
        }
        if (this.pruneIntervalId) {
            clearInterval(this.pruneIntervalId);
            this.pruneIntervalId = null;
        }
        closeFeedbackDb();
        this.initialized = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Sanitize error messages to remove any potential secrets
     */
    private sanitizeError(error: string | undefined): string | null {
        if (!error) return null;

        // Remove anything that looks like a seed, secret, or key
        let sanitized = error
            .replace(/s[A-Za-z0-9]{28,}/g, '[REDACTED]')  // XRPL seeds
            .replace(/r[A-Za-z0-9]{24,34}/g, '[ADDRESS]') // XRPL addresses (keep for debugging but mark)
            .replace(/[A-Fa-f0-9]{64}/g, '[HASH]')        // Hex hashes/keys
            .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
            .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');

        // Truncate long errors
        if (sanitized.length > 500) {
            sanitized = sanitized.substring(0, 500) + '...';
        }

        return sanitized;
    }

    /**
     * Compute mid price from order book
     */
    private computeMidPrice(orderBook: OrderBookState): number | null {
        const bestBid = orderBook.bids[0]?.price;
        const bestAsk = orderBook.asks[0]?.price;
        if (bestBid && bestAsk) {
            return (bestBid + bestAsk) / 2;
        }
        return null;
    }

    /**
     * Get events that occurred during a specific regime by correlating with snapshots
     */
    private getEventsForRegime(events: TradeEventRecord[], regime: FlowRegime, _filters: QueryFilters): TradeEventRecord[] {
        const result: TradeEventRecord[] = [];

        for (const event of events) {
            // Get snapshot closest to event time
            const snapshot = getSnapshotNear(event.pairKey, event.ts, 10000);
            const eventRegime = this.resolveEventRegime(event, snapshot?.flowRegime ?? null);
            if (eventRegime === regime) {
                result.push(event);
            }
        }

        return result;
    }

    /**
     * Resolve regime for an event with robust fallbacks.
     * Snapshot is preferred when available; event-captured fields are used
     * when pair-key or timing mismatches prevent snapshot correlation.
     */
    private resolveEventRegime(event: TradeEventRecord, snapshotRegime: FlowRegime | null): FlowRegime | null {
        return (
            snapshotRegime
            ?? event.entryFlowRegime
            ?? event.postFlowRegime1s
            ?? event.postFlowRegime3s
            ?? null
        );
    }

    /**
     * Resolve spread bps for an event with robust fallbacks.
     */
    private resolveEventSpreadBps(event: TradeEventRecord, snapshotSpreadBps: number | null): number | null {
        return snapshotSpreadBps
            ?? event.entrySpreadBps
            ?? event.postSpread1s
            ?? event.postSpread3s
            ?? null;
    }

    /**
     * Compute summary statistics from events
     */
    private computeSummary(events: TradeEventRecord[]): AnalyticsSummary {
        // Filter to fills and executed orders only
        const fills = events.filter(e => e.action === 'fill' || (e.action === 'offer_create' && e.fillPrice));

        if (fills.length === 0) {
            return this.emptySummary();
        }

        let wins = 0;
        let losses = 0;
        let totalGain = 0;
        let totalLoss = 0;
        let totalSlippageBps = 0;
        let slippageCount = 0;
        let totalEdgeBps = 0;
        let edgeCount = 0;

        for (const event of fills) {
            const pnl = this.computeEventPnl(event);
            const slippage = this.computeSlippageBps(event);
            const edge = this.computeEdgeBps(event);

            if (pnl > 0) {
                wins++;
                totalGain += pnl;
            } else if (pnl < 0) {
                losses++;
                totalLoss += Math.abs(pnl);
            }
            // pnl === 0: skip — neither win nor loss

            if (slippage !== null) {
                totalSlippageBps += slippage;
                slippageCount++;
            }

            if (edge !== null) {
                totalEdgeBps += edge;
                edgeCount++;
            }
        }

        const trades = wins + losses;
        const winRate = trades > 0 ? wins / trades : 0;
        const avgWin = wins > 0 ? totalGain / wins : 0;
        const avgLoss = losses > 0 ? totalLoss / losses : 0;
        const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
        const profitFactor = totalLoss > 0 ? totalGain / totalLoss : (totalGain > 0 ? Infinity : 0);
        const avgSlippageBps = slippageCount > 0 ? totalSlippageBps / slippageCount : 0;
        const avgEdgeBps = edgeCount > 0 ? totalEdgeBps / edgeCount : 0;

        // Calculate max drawdown
        const firstEventTs = events[0]?.ts;
        const drawdownPoints = firstEventTs !== undefined
            ? this.getRollingDrawdown({ sinceMs: firstEventTs })
            : [];
        const maxDrawdown = drawdownPoints.length > 0
            ? Math.max(...drawdownPoints.map(p => p.drawdown))
            : 0;

        return {
            trades,
            wins,
            losses,
            winRate,
            profitFactor,
            expectancy,
            avgSlippageBps,
            totalPnlApprox: totalGain - totalLoss,
            maxDrawdown,
            avgEdgeBps,
        };
    }

    /**
     * Compute approximate PnL for an event
     * Uses edge relative to mid-price as a proxy when actual PnL unavailable
     */
    private computeEventPnl(event: TradeEventRecord): number {
        // If we have fill info, compute edge-based PnL approximation
        if (event.fillPrice && event.fillSizeBase && event.midPriceAtDecision) {
            const edgeBps = this.computeEdgeBps(event);
            if (edgeBps !== null) {
                // Convert edge bps to quote currency PnL
                // Positive edge = profit, negative = loss
                return (edgeBps / 10000) * event.fillPrice * event.fillSizeBase;
            }
        }

        // Fallback: use slippage as negative PnL proxy
        const slippage = this.computeSlippageBps(event);
        if (slippage !== null && event.fillPrice && event.fillSizeBase) {
            return -(slippage / 10000) * event.fillPrice * event.fillSizeBase;
        }

        return 0;
    }

    private resolveExpectedPriceForEvent(event: TradeEventRecord): number | null {
        const baselineSource = event.expectedPriceSource ?? 'intent';
        if (baselineSource === 'mid' && Number.isFinite(event.decisionMidPrice) && (event.decisionMidPrice ?? 0) > 0) {
            return event.decisionMidPrice ?? null;
        }
        if (baselineSource === 'bbo') {
            if (event.side === 'buy' && Number.isFinite(event.decisionBestAsk) && (event.decisionBestAsk ?? 0) > 0) {
                return event.decisionBestAsk ?? null;
            }
            if (event.side === 'sell' && Number.isFinite(event.decisionBestBid) && (event.decisionBestBid ?? 0) > 0) {
                return event.decisionBestBid ?? null;
            }
        }
        return event.intentPrice ?? null;
    }

    /**
     * Compute canonical slippage in basis points.
     * Positive = worse execution cost, negative = price improvement.
     */
    private computeSlippageBps(event: TradeEventRecord): number | null {
        if (event.slippageBpsVsIntent != null) {
            return event.slippageBpsVsIntent;
        }
        if (event.side !== 'buy' && event.side !== 'sell') {
            return null;
        }
        if (!event.fillPrice || event.fillPrice <= 0) {
            warnInvalidSlippageInputs({
                source: 'feedback-engine.computeSlippageBps',
                side: event.side ?? null,
                expectedPrice: null,
                fillPrice: event.fillPrice,
                baseline: event.expectedPriceSource ?? 'unknown',
                pairKey: event.pairKey,
                txHash: event.txHash,
            });
            return null;
        }

        const expectedPrice = this.resolveExpectedPriceForEvent(event);
        if (!expectedPrice || expectedPrice <= 0) {
            warnInvalidSlippageInputs({
                source: 'feedback-engine.computeSlippageBps',
                side: event.side,
                expectedPrice,
                fillPrice: event.fillPrice,
                baseline: event.expectedPriceSource ?? 'unknown',
                pairKey: event.pairKey,
                txHash: event.txHash,
            });
            return null;
        }

        const slippage = computeCanonicalSlippageBps(event.side, expectedPrice, event.fillPrice);
        if (slippage == null) {
            warnInvalidSlippageInputs({
                source: 'feedback-engine.computeSlippageBps',
                side: event.side,
                expectedPrice,
                fillPrice: event.fillPrice,
                baseline: event.expectedPriceSource ?? 'unknown',
                pairKey: event.pairKey,
                txHash: event.txHash,
            });
        }
        return slippage;
    }

    /**
     * Compute edge in basis points relative to mid-price
     * edgeBps = (fillPrice - midAtDecision) / midAtDecision * 10_000
     * Sign-adjusted by side: positive = favorable execution
     */
    private computeEdgeBps(event: TradeEventRecord): number | null {
        if (event.edgeBpsVsMid != null) {
            return event.edgeBpsVsMid;
        }
        if (!event.fillPrice || !event.midPriceAtDecision || event.midPriceAtDecision === 0) {
            return null;
        }

        const rawEdge = ((event.fillPrice - event.midPriceAtDecision) / event.midPriceAtDecision) * 10000;

        // For buys: buying below mid is good (negative raw edge = positive)
        // For sells: selling above mid is good (positive raw edge = positive)
        if (event.side === 'buy') {
            return -rawEdge;
        }

        return rawEdge;
    }

    /**
     * Return empty summary for error cases
     */
    private emptySummary(): AnalyticsSummary {
        return {
            trades: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            profitFactor: 0,
            expectancy: 0,
            avgSlippageBps: 0,
            totalPnlApprox: 0,
            maxDrawdown: 0,
            avgEdgeBps: 0,
        };
    }

    /**
     * Return empty cost summary for error cases
     */
    private emptyCostSummary(): CostSummary {
        return {
            fills: 0,
            avgSlippageBpsVsIntent: null,
            avgSlippageBpsVsMid: null,
            avgSpreadPaidBps: null,
            avgEdgeBpsVsMid: null,
            avgNetEdgeBpsVsMid: null,
            avgTxFeeXrp: null,
            totalTxFeeXrp: null,
            partialFillRatio: 0,
            avgFillRatio: null,
        };
    }

    /**
     * Compute drawdown velocity: maximum rate of drawdown increase across
     * consecutive drawdown buckets, expressed per hour.
     * Returns 0 when fewer than 2 drawdown points exist.
     */
    private computeDrawdownVelocity(drawdown: DrawdownPoint[]): number {
        if (drawdown.length < 2) return 0;

        let maxVelocity = 0;

        for (let i = 1; i < drawdown.length; i++) {
            const prev = drawdown[i - 1]!;
            const curr = drawdown[i]!;
            const dtMs = curr.ts - prev.ts;
            if (dtMs <= 0) continue;

            const ddDelta = curr.drawdown - prev.drawdown;
            if (ddDelta <= 0) continue; // Only care about increasing drawdown

            const dtHours = dtMs / (60 * 60 * 1000);
            const velocity = ddDelta / dtHours;
            if (velocity > maxVelocity) {
                maxVelocity = velocity;
            }
        }

        return maxVelocity;
    }

    /**
     * Compute rolling cumulative profit factor series aligned with
     * drawdown time buckets.
     */
    private computeProfitFactorSeries(
        filters: QueryFilters = {},
        bucketMs: number = 3600000,
    ): ProfitFactorPoint[] {
        if (!this.ensureInitialized()) return [];

        try {
            const events = queryTradeEvents(filters);
            if (events.length === 0) return [];

            const sorted = [...events].sort((a, b) => a.ts - b.ts);
            const firstEvent = sorted[0];
            if (!firstEvent) return [];

            let cumulativeGain = 0;
            let cumulativeLoss = 0;
            const points: ProfitFactorPoint[] = [];

            let currentBucket = Math.floor(firstEvent.ts / bucketMs) * bucketMs;
            let bucketGain = 0;
            let bucketLoss = 0;

            for (const event of sorted) {
                const pnl = this.computeEventPnl(event);
                const eventBucket = Math.floor(event.ts / bucketMs) * bucketMs;

                if (eventBucket > currentBucket) {
                    // Emit point for completed bucket
                    cumulativeGain += bucketGain;
                    cumulativeLoss += bucketLoss;
                    const pf = cumulativeLoss > 0
                        ? cumulativeGain / cumulativeLoss
                        : (cumulativeGain > 0 ? 10 : 1);
                    points.push({ ts: currentBucket, profitFactor: pf });

                    // Start new bucket
                    currentBucket = eventBucket;
                    bucketGain = pnl > 0 ? pnl : 0;
                    bucketLoss = pnl <= 0 ? Math.abs(pnl) : 0;
                } else {
                    if (pnl > 0) {
                        bucketGain += pnl;
                    } else {
                        bucketLoss += Math.abs(pnl);
                    }
                }
            }

            // Emit final bucket
            cumulativeGain += bucketGain;
            cumulativeLoss += bucketLoss;
            const pf = cumulativeLoss > 0
                ? cumulativeGain / cumulativeLoss
                : (cumulativeGain > 0 ? 10 : 1);
            points.push({ ts: currentBucket, profitFactor: pf });

            return points;
        } catch (err) {
            logger.warn({ err }, 'Failed to compute profit factor series');
            return [];
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────────────────────────────

export const feedbackEngine = new FeedbackEngine();

// ─────────────────────────────────────────────────────────────────────────────
// Adverse Selection Rate Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute rolling adverse selection rate from market snapshots.
 * Ignores snapshots where adverseSelectionRisk is null (unknown).
 */
export function computeAdverseSelectionRate(
    snapshots: MarketSnapshotRecord[],
): { sampleCount: number; adverseCount: number; adverseRate: number } {
    let sampleCount = 0;
    let adverseCount = 0;

    for (const snap of snapshots) {
        if (snap.adverseSelectionRisk === null || snap.adverseSelectionRisk === undefined) {
            continue; // Ignore unknown values
        }
        sampleCount++;
        if (snap.adverseSelectionRisk === 1) {
            adverseCount++;
        }
    }

    return {
        sampleCount,
        adverseCount,
        adverseRate: sampleCount > 0 ? adverseCount / sampleCount : 0,
    };
}

// Convenience re-exports
export type {
    TradeEventRecord,
    MarketSnapshotRecord,
    TradeAction,
    QueryFilters,
};
