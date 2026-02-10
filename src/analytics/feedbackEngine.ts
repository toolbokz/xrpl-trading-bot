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
    TradeAction,
    generateId,
    insertTradeEvent,
    insertMarketSnapshot,
    insertBatch,
    queryTradeEvents,
    getSnapshotNear,
    pruneOldData,
    closeFeedbackDb,
    QueryFilters,
    getFeedbackDb,
} from './feedbackDb';
import { FlowMetrics, FlowRegime, hasAdverseSelectionRisk } from '../market/flowMetrics';
import { OrderBookState } from '../utils/types';
import { logger } from './logger';

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
    spreadPaidBps?: number | null;
    edgeBpsVsMid?: number | null;
    netEdgeBpsVsMid?: number | null;
    txFeeXrp?: number | null;
    ammFeeBps?: number | null;
    fillRatio?: number | null;
    isPartial?: boolean | null;
    /** Execution source: AMM pool, DEX order book, mixed, or unknown. */
    executionSource?: 'amm' | 'orderbook' | 'mixed' | 'unknown' | null;
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
                pairKey: input.pairKey,
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
    recordTradeEvent(input: TradeEventInput): void {
        if (!this.ensureInitialized()) return;

        try {
            const event: TradeEventRecord = {
                id: generateId(),
                ts: Date.now(),
                pairKey: input.pairKey,
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
                spreadPaidBps: input.spreadPaidBps ?? null,
                edgeBpsVsMid: input.edgeBpsVsMid ?? null,
                netEdgeBpsVsMid: input.netEdgeBpsVsMid ?? null,
                txFeeXrp: input.txFeeXrp ?? null,
                ammFeeBps: input.ammFeeBps ?? null,
                fillRatio: input.fillRatio ?? null,
                isPartial: input.isPartial != null ? (input.isPartial ? 1 : 0) : null,
            };

            insertTradeEvent(event);
        } catch (err) {
            logger.warn({ err, action: input.action }, 'Failed to record trade event');
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
                pairKey: input.pairKey,
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
                spreadPaidBps: input.spreadPaidBps ?? null,
                edgeBpsVsMid: input.edgeBpsVsMid ?? null,
                netEdgeBpsVsMid: input.netEdgeBpsVsMid ?? null,
                txFeeXrp: input.txFeeXrp ?? null,
                ammFeeBps: input.ammFeeBps ?? null,
                fillRatio: input.fillRatio ?? null,
                isPartial: input.isPartial != null ? (input.isPartial ? 1 : 0) : null,
            }));

            let snapshotRecord: MarketSnapshotRecord | undefined;
            if (snapshot) {
                snapshotRecord = {
                    id: generateId(),
                    ts: Date.now(),
                    pairKey: snapshot.pairKey,
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

            // Enrich with regime from snapshots
            const enriched = fills.map(event => {
                const snapshot = getSnapshotNear(event.pairKey, event.ts, 10000);
                return { event, regime: snapshot?.flowRegime ?? null, spreadBps: snapshot?.spreadBps ?? null };
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

            // Enrich each fill with regime from nearest snapshot
            return fills.map(event => {
                const snapshot = getSnapshotNear(event.pairKey, event.ts, 10000);
                return {
                    event,
                    regime: snapshot?.flowRegime ?? null,
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
            if (snapshot && snapshot.flowRegime === regime) {
                result.push(event);
            }
        }

        return result;
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

    /**
     * Compute slippage in basis points
     * slippageBps = ((fillPrice - intentPrice) / intentPrice) * 10_000
     * Positive = worse execution (paid more / received less)
     */
    private computeSlippageBps(event: TradeEventRecord): number | null {
        if (!event.fillPrice || !event.intentPrice || event.intentPrice === 0) {
            return null;
        }

        const slippage = ((event.fillPrice - event.intentPrice) / event.intentPrice) * 10000;

        // For sells, negative slippage is bad (got less), for buys positive is bad (paid more)
        if (event.side === 'sell') {
            return -slippage; // Invert for sells so positive is always bad
        }

        return slippage;
    }

    /**
     * Compute edge in basis points relative to mid-price
     * edgeBps = (fillPrice - midAtDecision) / midAtDecision * 10_000
     * Sign-adjusted by side: positive = favorable execution
     */
    private computeEdgeBps(event: TradeEventRecord): number | null {
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
