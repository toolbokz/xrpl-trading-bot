/**
 * GET /api/pairs/[key]/candles
 * 
 * Returns OHLCV candlestick data aggregated from recent trades.
 * 
 * Query params:
 * - interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' (default: '1m')
 * - limit: number of candles (default: 120, max: 500)
 * - since: Unix timestamp to fetch candles after (for incremental updates)
 * 
 * Data source priority:
 * 1. TradeTape (real-time trades from XRPL stream)
 * 2. FeedbackDb (historical trade events from bot)
 * 3. XRPL Data API (historical exchange data from public API)
 * 4. Empty response with status if no data available
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { findPair, isValidPairKey } from '../../../../lib/tradingPairs';
import { loadConfig } from '../../../../../config';
import { logger } from '../../../../../analytics/logger';
import { getGlobalTradeTape, Trade } from '../../../../../market/tradeTape';
import { queryTradeEvents, TradeEventRecord } from '../../../../../analytics/feedbackDb';
import { setCandlesInfo } from '../../market/health';
import { fetchHistoricalTrades } from '../../../../lib/xrplHistoricalTrades';
import {
    isSingleProcessMode,
    getTapeFromRuntime,
    initRuntimeBridge,
} from '../../../../lib/runtimeBridge';

export const config = {
    api: { bodyParser: false },
};

// =============================================================================
// Types
// =============================================================================

interface Candle {
    time: number;     // Unix timestamp in seconds (start of period)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;   // Volume in base currency
}

interface CandlesResponse {
    pair: string;
    interval: string;
    candles: Candle[];
    lastUpdated: number;
    network: 'mainnet' | 'testnet';
    source: 'live' | 'historical' | 'empty';
}

interface ErrorResponse {
    error: string;
    code: string;
    requestId: string;
}

// =============================================================================
// Interval Configuration
// =============================================================================

const INTERVAL_MS: Record<string, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
};

const VALID_INTERVALS = Object.keys(INTERVAL_MS);

// =============================================================================
// Candle Aggregation
// =============================================================================

interface TradeData {
    ts: number;      // Timestamp in milliseconds
    price: number;
    sizeBase: number;
}

/**
 * Aggregate trades into OHLCV candles.
 */
function aggregateTradesToCandles(
    trades: TradeData[],
    intervalMs: number,
    limit: number,
    since?: number
): Candle[] {
    if (trades.length === 0) return [];

    // Sort trades by timestamp ascending
    const sorted = [...trades].sort((a, b) => a.ts - b.ts);

    // Build candle map
    const candleMap = new Map<number, Candle>();

    for (const trade of sorted) {
        // Calculate candle start time (floor to interval)
        const candleStartMs = Math.floor(trade.ts / intervalMs) * intervalMs;
        const candleStartSec = Math.floor(candleStartMs / 1000);

        // Skip if before 'since' filter
        if (since && candleStartSec < since) continue;

        const existing = candleMap.get(candleStartSec);

        if (existing) {
            // Update existing candle
            existing.high = Math.max(existing.high, trade.price);
            existing.low = Math.min(existing.low, trade.price);
            existing.close = trade.price;
            existing.volume += trade.sizeBase;
        } else {
            // Create new candle
            candleMap.set(candleStartSec, {
                time: candleStartSec,
                open: trade.price,
                high: trade.price,
                low: trade.price,
                close: trade.price,
                volume: trade.sizeBase,
            });
        }
    }

    // Convert to array, sort by time, and apply limit
    const candles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-limit);

    return candles;
}

/**
 * Get trades from TradeTape (live trades).
 * In single-process mode, uses runtimeBridge to get tape from TradingRuntime.
 * In dual-process mode, uses globalTradeTape directly.
 */
function getTradesFromTape(pairKey: string): TradeData[] {
    // In single-process mode, get tape from runtime via bridge
    if (isSingleProcessMode()) {
        const tapeData = getTapeFromRuntime();
        if (!tapeData || tapeData.trades.length === 0) {
            return [];
        }
        // Filter by pair key (trades already have pairKey)
        return tapeData.trades
            .filter((t: Trade) => t.pairKey === pairKey)
            .map((t: Trade) => ({
                ts: t.ts,
                price: t.price,
                sizeBase: t.sizeBase,
            }));
    }

    // Dual-process mode: use global tape
    const tape = getGlobalTradeTape();
    if (!tape) return [];

    const tapeKey = tape.getPairKey();
    if (tapeKey !== pairKey) return [];

    const trades = tape.getAll();
    return trades.map((t: Trade) => ({
        ts: t.ts,
        price: t.price,
        sizeBase: t.sizeBase,
    }));
}

/**
 * Get historical trades from FeedbackDb.
 */
async function getTradesFromDb(pairKey: string, limit: number): Promise<TradeData[]> {
    try {
        // Query recent fill events for this pair
        // Note: This queries trade_events table for 'fill' actions
        const windowMs = limit * 60 * 1000; // Approximate window based on 1-min candles
        const sinceMs = Date.now() - windowMs;

        const events = queryTradeEvents({
            pairKey,
            sinceMs,
        });

        return events
            .filter((e: TradeEventRecord) => e.action === 'fill' && e.fillPrice && e.fillSizeBase)
            .map((e: TradeEventRecord) => ({
                ts: e.ts,
                price: e.fillPrice!,
                sizeBase: e.fillSizeBase!,
            }))
            .slice(0, limit * 10); // Limit results
    } catch (err) {
        logger.debug({ err, pairKey }, '[API /candles] FeedbackDb not available');
        return [];
    }
}

// =============================================================================
// Handler
// =============================================================================

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<CandlesResponse | ErrorResponse>
) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Initialize runtime bridge in single-process mode
    if (isSingleProcessMode()) {
        try {
            await initRuntimeBridge();
        } catch (err) {
            logger.warn({ err }, '[API /candles] Runtime bridge init failed, continuing...');
        }
    }

    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({
            error: 'Method not allowed',
            code: 'METHOD_NOT_ALLOWED',
            requestId,
        });
    }

    // Extract parameters
    const { key, interval: intervalParam, limit: limitParam, since: sinceParam } = req.query;
    const pairKey = Array.isArray(key) ? key[0] : key;
    const interval = Array.isArray(intervalParam) ? intervalParam[0] : (intervalParam || '1m');
    const limit = Math.min(Math.max(parseInt(String(limitParam || '120'), 10) || 120, 1), 500);
    const since = sinceParam ? parseInt(String(sinceParam), 10) : undefined;

    // Validate pair
    if (!pairKey || !isValidPairKey(pairKey)) {
        return res.status(400).json({
            error: `Invalid trading pair: ${pairKey}`,
            code: 'INVALID_PAIR',
            requestId,
        });
    }

    const pair = findPair(pairKey);
    if (!pair) {
        return res.status(404).json({
            error: `Trading pair not found: ${pairKey}`,
            code: 'PAIR_NOT_FOUND',
            requestId,
        });
    }

    // Validate interval
    if (!VALID_INTERVALS.includes(interval!)) {
        return res.status(400).json({
            error: `Invalid interval: ${interval}. Valid: ${VALID_INTERVALS.join(', ')}`,
            code: 'INVALID_INTERVAL',
            requestId,
        });
    }

    const intervalMs = INTERVAL_MS[interval!]!;

    try {
        const cfg = loadConfig();
        const currentNetwork = cfg.xrpl.network as 'mainnet' | 'testnet';

        // Collect trades from all sources
        const tapeTrades = getTradesFromTape(pairKey);
        const dbTrades = await getTradesFromDb(pairKey, limit);

        // Merge and deduplicate (simple by timestamp + price combo)
        let allTrades = [...tapeTrades, ...dbTrades];
        const seen = new Set<string>();
        let uniqueTrades = allTrades.filter(t => {
            const key = `${t.ts}:${t.price}:${t.sizeBase}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Determine data source
        let source: 'live' | 'historical' | 'empty' = 'empty';
        if (tapeTrades.length > 0) {
            source = 'live';
        } else if (dbTrades.length > 0) {
            source = 'historical';
        }

        // If no local data, try fetching from XRPL Data API
        if (uniqueTrades.length === 0 && pair && pair.base?.currency && pair.quote?.currency) {
            logger.debug({ pairKey }, '[API /candles] No local trades, fetching from XRPL Data API');
            try {
                // Determine issuer - for XRP pairs, use the non-XRP side's issuer
                const issuer = pair.base.issuer || pair.quote.issuer;
                const historicalTrades = await fetchHistoricalTrades(
                    pair.base.currency,
                    pair.quote.currency,
                    issuer,
                    limit * 10 // Fetch more to cover the candle period
                );
                if (historicalTrades.length > 0) {
                    uniqueTrades = historicalTrades;
                    source = 'historical';
                    logger.info({ pairKey, count: historicalTrades.length }, '[API /candles] Got historical trades from XRPL Data API');
                }
            } catch (err) {
                logger.warn({ err, pairKey }, '[API /candles] Failed to fetch from XRPL Data API');
            }
        }

        // Aggregate to candles
        let candles = aggregateTradesToCandles(uniqueTrades, intervalMs, limit, since);

        // Note: Gap filling is now handled on the frontend using whitespace data
        // to avoid showing fake flat candles. Only fill if explicitly requested.
        // if (candles.length >= 2) {
        //     candles = fillCandleGaps(candles, intervalMs, limit);
        // }

        const response: CandlesResponse = {
            pair: pairKey,
            interval: interval!,
            candles,
            lastUpdated: Date.now(),
            network: currentNetwork,
            source,
        };

        // Report candles health status
        setCandlesInfo(response.lastUpdated, source, pairKey);

        // Short cache
        res.setHeader('Cache-Control', 'private, max-age=5');
        return res.status(200).json(response);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Internal server error';
        logger.error({ err, pairKey, interval }, '[API /pairs/[key]/candles] Error');

        return res.status(500).json({
            error: errorMessage,
            code: 'INTERNAL_ERROR',
            requestId,
        });
    }
}
