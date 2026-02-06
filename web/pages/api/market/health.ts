/**
 * GET /api/market/health
 * 
 * Returns market data health indicators:
 * - Order book freshness
 * - Trade tape freshness
 * - Candles data source
 * - Trade counts
 * - Staleness warnings
 * - Process mode (single/dual)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { loadConfig } from '../../../../src/config';
import { getGlobalTradeTape } from '../../../../src/market/tradeTape';
import { logger } from '../../../../src/analytics/logger';
import { getClientHealth } from '../../../lib/xrplClient';
import { getProcessModeInfo, getTapeFromRuntime, isSingleProcessMode, getState } from '../../../lib/runtimeBridge';

export const config = {
    api: { bodyParser: false },
};

// =============================================================================
// Types
// =============================================================================

interface MarketHealthResponse {
    timestamp: number;

    /** Process mode info */
    processMode: {
        mode: 'single' | 'dual';
        xrplConnectionsExpected: 1 | 2;
        runtimeStarted: boolean;
        runtimeReady: boolean;
        warmingUp: boolean;
    };

    // XRPL connection health
    xrpl: {
        connected: boolean;
        endpoint: string | null;
        lastError: string | null;
        reconnects: number;
        cooldowns: Record<string, number>;
        endpointPool: string[];
    };

    // Order book health
    orderBook: {
        available: boolean;
        lastUpdated: number | null;
        ageMs: number | null;
        stale: boolean;
    };

    // Trade tape health
    tradeTape: {
        available: boolean;
        lastUpdated: number | null;
        ageMs: number | null;
        stale: boolean;
        tradeCount1m: number;
        tradeCount5m: number;
    };

    // Candles health
    candles: {
        source: 'live' | 'historical' | 'empty' | 'unknown';
        lastUpdated: number | null;
        ageMs: number | null;
        stale: boolean;
    };

    // Overall health
    overall: {
        healthy: boolean;
        warnings: string[];
    };

    // Network info
    network: 'mainnet' | 'testnet';
}

interface ErrorResponse {
    error: string;
    code: string;
    requestId: string;
}

// =============================================================================
// Configuration
// =============================================================================

// Staleness thresholds (ms)
const STALE_THRESHOLD_ORDER_BOOK = 30_000; // 30 seconds
const STALE_THRESHOLD_TRADE_TAPE = 120_000; // 2 minutes (trades may be infrequent)
const STALE_THRESHOLD_CANDLES = 60_000; // 60 seconds

// In-memory cache for last known update times
// (These would ideally come from a shared state manager)
let lastOrderBookUpdate: number | null = null;
let lastOrderBookPairKey: string | null = null;
let lastCandlesUpdate: number | null = null;
let lastCandlesSource: 'live' | 'historical' | 'empty' | 'unknown' = 'unknown';
let lastCandlesPairKey: string | null = null;

/**
 * Update order book timestamp (called from useOrderBook hook via API)
 */
export function setOrderBookLastUpdate(ts: number, pairKey?: string): void {
    lastOrderBookUpdate = ts;
    if (pairKey) lastOrderBookPairKey = pairKey;
}

/**
 * Update candles info (called from candles API)
 */
export function setCandlesInfo(ts: number, source: 'live' | 'historical' | 'empty', pairKey?: string): void {
    lastCandlesUpdate = ts;
    lastCandlesSource = source;
    if (pairKey) lastCandlesPairKey = pairKey;
}

/**
 * Reset health tracking state (called on pair switch to prevent stale cross-pair data).
 */
export function resetHealthTracking(): void {
    lastOrderBookUpdate = null;
    lastOrderBookPairKey = null;
    lastCandlesUpdate = null;
    lastCandlesSource = 'unknown';
    lastCandlesPairKey = null;
}

// =============================================================================
// Handler
// =============================================================================

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<MarketHealthResponse | ErrorResponse>
) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({
            error: 'Method not allowed',
            code: 'METHOD_NOT_ALLOWED',
            requestId,
        });
    }

    try {
        const cfg = loadConfig();
        const now = Date.now();
        const warnings: string[] = [];

        // Get process mode info
        const processModeInfo = getProcessModeInfo();

        // Get XRPL connection health
        let xrplHealth = getClientHealth();

        // In single-process mode, use runtime connection state
        if (isSingleProcessMode()) {
            const state = getState();
            if (state.connection) {
                xrplHealth = {
                    connected: state.connected,
                    endpoint: state.endpoint,
                    lastError: state.connection.lastError,
                    reconnects: state.connection.reconnects,
                    cooldowns: state.connection.cooldowns,
                    endpointPool: state.connection.endpointPool,
                };
            }
        }

        // Add XRPL connection warnings
        // Only show critical warnings - cooldowns and past errors are expected behavior
        if (!xrplHealth.connected) {
            // Not connected is the critical issue
            if (xrplHealth.lastError) {
                warnings.push(`XRPL not connected: ${xrplHealth.lastError}`);
            } else {
                warnings.push('XRPL not connected');
            }

            // Cooldowns are informational when not connected
            const cooldownCount = Object.keys(xrplHealth.cooldowns).length;
            if (cooldownCount > 0) {
                const totalEndpoints = xrplHealth.endpointPool?.length || 3;
                if (cooldownCount >= totalEndpoints) {
                    warnings.push(`All ${cooldownCount} endpoints in cooldown (rate limited)`);
                }
            }
        }
        // If connected, don't show lastError or cooldown count - those are just history

        // Get trade tape info - prefer runtime in single-process mode
        let tape = getGlobalTradeTape();
        let tradeTapeLastUpdated: number | null = null;
        let tradeCount1m = 0;
        let tradeCount5m = 0;

        if (isSingleProcessMode()) {
            const runtimeTape = getTapeFromRuntime();
            if (runtimeTape && runtimeTape.tradeCount > 0) {
                tradeTapeLastUpdated = runtimeTape.lastTradeAt;
                // Compute trade counts from runtime
                const trades = runtimeTape.trades;
                const cutoff1m = now - 60_000;
                const cutoff5m = now - 300_000;
                tradeCount1m = trades.filter(t => t.ts >= cutoff1m).length;
                tradeCount5m = trades.filter(t => t.ts >= cutoff5m).length;
                tape = {} as any; // Mark as available
            }
        } else if (tape) {
            const allTrades = tape.getAll();
            if (allTrades.length > 0) {
                // Most recent trade timestamp
                tradeTapeLastUpdated = Math.max(...allTrades.map(t => t.ts));

                // Count trades in windows
                const cutoff1m = now - 60_000;
                const cutoff5m = now - 300_000;
                tradeCount1m = allTrades.filter(t => t.ts >= cutoff1m).length;
                tradeCount5m = allTrades.filter(t => t.ts >= cutoff5m).length;
            }
        }

        // Calculate staleness
        const orderBookAge = lastOrderBookUpdate !== null ? now - lastOrderBookUpdate : null;
        const tradeTapeAge = tradeTapeLastUpdated !== null ? now - tradeTapeLastUpdated : null;
        const candlesAge = lastCandlesUpdate !== null ? now - lastCandlesUpdate : null;

        const orderBookStale = orderBookAge !== null && orderBookAge > STALE_THRESHOLD_ORDER_BOOK;
        const tradeTapeStale = tradeTapeAge !== null && tradeTapeAge > STALE_THRESHOLD_TRADE_TAPE;
        const candlesStale = candlesAge !== null && candlesAge > STALE_THRESHOLD_CANDLES;

        // Build warnings
        if (orderBookStale) {
            warnings.push(`Order book stale (${Math.round(orderBookAge! / 1000)}s old)`);
        }
        if (tradeTapeStale) {
            warnings.push(`Trade tape stale (${Math.round(tradeTapeAge! / 1000)}s old)`);
        }
        if (candlesStale) {
            warnings.push(`Candles stale (${Math.round(candlesAge! / 1000)}s old)`);
        }
        if (lastCandlesSource === 'empty') {
            warnings.push('No candle data available');
        }
        if (!tape) {
            warnings.push('Trade tape not initialized');
        }
        if (tradeCount5m === 0 && tape) {
            warnings.push('No trades in last 5 minutes');
        }

        const response: MarketHealthResponse = {
            timestamp: now,

            processMode: processModeInfo,

            xrpl: {
                connected: xrplHealth.connected,
                endpoint: xrplHealth.endpoint,
                lastError: xrplHealth.lastError,
                reconnects: xrplHealth.reconnects,
                cooldowns: xrplHealth.cooldowns,
                endpointPool: xrplHealth.endpointPool,
            },

            orderBook: {
                available: lastOrderBookUpdate !== null,
                lastUpdated: lastOrderBookUpdate,
                ageMs: orderBookAge,
                stale: orderBookStale,
            },

            tradeTape: {
                available: tape !== null,
                lastUpdated: tradeTapeLastUpdated,
                ageMs: tradeTapeAge,
                stale: tradeTapeStale,
                tradeCount1m,
                tradeCount5m,
            },

            candles: {
                source: lastCandlesSource,
                lastUpdated: lastCandlesUpdate,
                ageMs: candlesAge,
                stale: candlesStale,
            },

            overall: {
                healthy: warnings.length === 0,
                warnings,
            },

            network: cfg.xrpl.network as 'mainnet' | 'testnet',
        };

        res.setHeader('Cache-Control', 'private, max-age=1');
        return res.status(200).json(response);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Internal server error';
        logger.error({ err }, '[API /market/health] Error');

        return res.status(500).json({
            error: errorMessage,
            code: 'INTERNAL_ERROR',
            requestId,
        });
    }
}
