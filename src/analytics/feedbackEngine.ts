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
import { FlowMetrics, FlowRegime } from '../market/flowMetrics';
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
 * Complete analytics response
 */
export interface AnalyticsResponse {
    summary: AnalyticsSummary;
    byRegime: RegimeStats[];
    byStrategy: StrategyStats[];
    drawdown: DrawdownPoint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Feedback Engine Class
// ─────────────────────────────────────────────────────────────────────────────

class FeedbackEngine {
    private initialized = false;
    private pruneIntervalId: NodeJS.Timeout | null = null;

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
     * Record a market snapshot
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
            };

            insertMarketSnapshot(snapshot);
        } catch (err) {
            logger.warn({ err, pairKey: input.pairKey }, 'Failed to record snapshot');
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
        return {
            summary: this.getSummary(filters),
            byRegime: this.getRegimeMatrix(filters),
            byStrategy: this.getStrategyStats(filters),
            drawdown: this.getRollingDrawdown(filters),
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
                } else {
                    losses++;
                    totalLoss += Math.abs(pnl);
                }

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
            const winRate = tradesCount > 0 ? wins / tradesCount : 0;
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
            } else {
                losses++;
                totalLoss += Math.abs(pnl);
            }

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────────────────────────────

export const feedbackEngine = new FeedbackEngine();

// Convenience re-exports
export type { TradeEventRecord, MarketSnapshotRecord, TradeAction, QueryFilters };
