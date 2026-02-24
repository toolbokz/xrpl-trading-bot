/**
 * GET /api/pairs/[key]/orderbook
 * 
 * Returns the order book for a trading pair:
 * - Top N bids and asks with normalized prices/sizes
 * - Network availability status
 * 
 * In SINGLE_PROCESS_MODE=true, returns data from TradingRuntime instead of XRPL.
 */

import type { NextApiResponse } from 'next';
import { findPair, isValidPairKey, TradingPair } from '../../../../lib/tradingPairs';
import { loadConfig } from '../../../../../config';
import { getSharedClient } from '../../../../lib/xrplClient';
import { logger } from '../../../../../analytics/logger';
import { setOrderBookLastUpdate } from '../../market/health';
import {
    isSingleProcessMode,
    getOrderBookFromRuntime,
    isRuntimeWarmingUp,
    initRuntimeBridge,
} from '../../../../lib/runtimeBridge';
import { withLocalApi } from '../../../../lib/localApi';
import { withApiRouteContext } from '../../../../lib/localApi/withApiRouteContext';
import type { LocalRequest } from '../../../../lib/localApi';

export const config = {
    api: { bodyParser: false },
};

const MAX_RUNTIME_ORDERBOOK_AGE_MS = 30_000;

// =============================================================================
// Types
// =============================================================================

interface OrderBookLevel {
    price: number;
    size: number;
    total: number; // Cumulative size
}

interface OrderBookResponse {
    pair: string;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    lastUpdated: number;
    network: 'mainnet' | 'testnet';
    availableOnNetwork: boolean;
    /** Single-process mode: runtime is still starting up */
    warmingUp?: boolean;
    /** Single-process mode: data sourced from runtime */
    fromRuntime?: boolean;
}

interface ErrorResponse {
    error: string;
    code: string;
    requestId: string;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Convert currency code to hex format for non-standard codes (>3 chars).
 */
function currencyToHex(currency: string): string {
    if (currency.length <= 3) {
        return currency;
    }
    const hex = Buffer.from(currency, 'utf8').toString('hex').toUpperCase();
    return hex.padEnd(40, '0');
}

/**
 * Build XRPL currency amount object.
 */
function buildCurrencyAmount(currency: string, issuer?: string) {
    const isXRP = currency.toUpperCase() === 'XRP';
    if (isXRP) {
        return { currency: 'XRP' };
    }
    return {
        currency: currencyToHex(currency),
        issuer,
    };
}

/**
 * Parse XRPL amount to number.
 */
function parseAmount(amount: any, isXRP: boolean): number {
    if (isXRP) {
        return Number(amount) / 1_000_000;
    }
    return Number(amount?.value || 0);
}

/**
 * Process raw offers into order book levels.
 */
function processOffers(
    offers: any[] | undefined,
    baseIsXRP: boolean,
    quoteIsXRP: boolean,
    isAsk: boolean,
    limit: number
): OrderBookLevel[] {
    if (!offers || offers.length === 0) {
        return [];
    }

    const levels: OrderBookLevel[] = [];
    let cumulative = 0;

    for (const offer of offers.slice(0, limit)) {
        let price: number;
        let size: number;

        if (isAsk) {
            // Ask: TakerGets = base (what maker sells), TakerPays = quote (what maker receives)
            const baseQty = parseAmount(offer.TakerGets, baseIsXRP);
            const quoteQty = parseAmount(offer.TakerPays, quoteIsXRP);
            price = baseQty > 0 ? quoteQty / baseQty : 0;
            size = baseQty;
        } else {
            // Bid: TakerGets = quote (what maker sells), TakerPays = base (what maker receives)
            const quoteQty = parseAmount(offer.TakerGets, quoteIsXRP);
            const baseQty = parseAmount(offer.TakerPays, baseIsXRP);
            price = baseQty > 0 ? quoteQty / baseQty : 0;
            size = baseQty;
        }

        if (price > 0 && size > 0) {
            cumulative += size;
            levels.push({
                price,
                size,
                total: cumulative,
            });
        }
    }

    return levels;
}

/**
 * Fetch order book from XRPL.
 */
async function fetchOrderBook(
    pair: TradingPair,
    endpoint: string,
    depth: number
): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] }> {
    const client = await getSharedClient(endpoint);

    const baseCurrency = pair.base.currency;
    const baseIssuer = pair.base.issuer;
    const quoteCurrency = pair.quote.currency;
    const quoteIssuer = pair.quote.issuer;

    const baseIsXRP = baseCurrency.toUpperCase() === 'XRP';
    const quoteIsXRP = quoteCurrency.toUpperCase() === 'XRP';

    const baseAmount = buildCurrencyAmount(baseCurrency, baseIssuer);
    const quoteAmount = buildCurrencyAmount(quoteCurrency, quoteIssuer);

    // Fetch asks (selling base for quote)
    const asksRes = await client.request({
        command: 'book_offers',
        taker_gets: baseAmount as any,
        taker_pays: quoteAmount as any,
        ledger_index: 'validated',
        limit: depth,
    });

    // Fetch bids (buying base with quote)
    const bidsRes = await client.request({
        command: 'book_offers',
        taker_gets: quoteAmount as any,
        taker_pays: baseAmount as any,
        ledger_index: 'validated',
        limit: depth,
    });

    const askOffers = (asksRes.result as any)?.offers;
    const bidOffers = (bidsRes.result as any)?.offers;

    return {
        bids: processOffers(bidOffers, baseIsXRP, quoteIsXRP, false, depth),
        asks: processOffers(askOffers, baseIsXRP, quoteIsXRP, true, depth),
    };
}

// =============================================================================
// Handler
// =============================================================================

async function handler(
    req: LocalRequest,
    res: NextApiResponse<OrderBookResponse | ErrorResponse>
) {
    const requestId = req.requestId;

    // Initialize runtime bridge in single-process mode
    if (isSingleProcessMode()) {
        try {
            await initRuntimeBridge();
        } catch (err) {
            logger.warn({ err }, '[OrderBook] Runtime bridge init failed, falling back to direct XRPL');
        }
    }

    // Extract pair key from dynamic route
    const { key, depth: depthParam } = req.query;
    const pairKey = Array.isArray(key) ? key[0] : key;
    const depth = Math.min(Math.max(parseInt(String(depthParam || '10'), 10) || 10, 1), 50);

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

    try {
        const cfg = loadConfig();
        const currentNetwork = cfg.xrpl.network as 'mainnet' | 'testnet';

        // =====================================================================
        // Single-process mode: use runtime state instead of XRPL calls
        // =====================================================================
        if (isSingleProcessMode()) {
            const orderBook = getOrderBookFromRuntime(pairKey);
            const warmingUp = isRuntimeWarmingUp();

            // Return warming up response while runtime starts
            if (warmingUp && !orderBook) {
                const response: OrderBookResponse = {
                    pair: pairKey,
                    bids: [],
                    asks: [],
                    lastUpdated: Date.now(),
                    network: currentNetwork,
                    availableOnNetwork: false,
                    warmingUp: true,
                    fromRuntime: true,
                };
                return res.status(200).json(response);
            }

            // Return runtime data if available
            if (orderBook) {
                const ageMs = Date.now() - orderBook.lastUpdated;
                if (ageMs > MAX_RUNTIME_ORDERBOOK_AGE_MS) {
                    logger.warn(
                        {
                            pairKey,
                            ageMs,
                            maxAgeMs: MAX_RUNTIME_ORDERBOOK_AGE_MS,
                        },
                        '[OrderBook] Runtime snapshot stale, returning unavailable response'
                    );

                    const staleResponse: OrderBookResponse = {
                        pair: pairKey,
                        bids: [],
                        asks: [],
                        lastUpdated: Date.now(),
                        network: currentNetwork,
                        availableOnNetwork: false,
                        warmingUp,
                        fromRuntime: true,
                    };

                    res.setHeader('Cache-Control', 'private, max-age=1');
                    return res.status(200).json(staleResponse);
                }

                const bids: OrderBookLevel[] = orderBook.bids.slice(0, depth).map((b, idx, arr) => {
                    const total = arr.slice(0, idx + 1).reduce((sum, x) => sum + x.quantity, 0);
                    return { price: b.price, size: b.quantity, total };
                });
                const asks: OrderBookLevel[] = orderBook.asks.slice(0, depth).map((a, idx, arr) => {
                    const total = arr.slice(0, idx + 1).reduce((sum, x) => sum + x.quantity, 0);
                    return { price: a.price, size: a.quantity, total };
                });

                const response: OrderBookResponse = {
                    pair: pairKey,
                    bids,
                    asks,
                    lastUpdated: orderBook.lastUpdated,
                    network: currentNetwork,
                    availableOnNetwork: bids.length > 0 || asks.length > 0,
                    fromRuntime: true,
                };

                setOrderBookLastUpdate(response.lastUpdated, pairKey);
                res.setHeader('Cache-Control', 'private, max-age=1');
                return res.status(200).json(response);
            }

            // Single-process safety: never fall back to direct XRPL calls from API routes
            logger.debug({ pairKey }, '[OrderBook] Pair not active in runtime, returning unavailable response in single-process mode');

            const response: OrderBookResponse = {
                pair: pairKey,
                bids: [],
                asks: [],
                lastUpdated: Date.now(),
                network: currentNetwork,
                availableOnNetwork: false,
                warmingUp: false,
                fromRuntime: true,
            };

            res.setHeader('Cache-Control', 'private, max-age=1');
            return res.status(200).json(response);
        }

        // =====================================================================
        // Dual-process mode (legacy): direct XRPL calls
        // =====================================================================

        const { bids, asks } = await fetchOrderBook(pair, cfg.xrpl.endpoint, depth);

        const availableOnNetwork = bids.length > 0 || asks.length > 0;

        const response: OrderBookResponse = {
            pair: pairKey,
            bids,
            asks,
            lastUpdated: Date.now(),
            network: currentNetwork,
            availableOnNetwork,
        };

        // Report order book health status
        setOrderBookLastUpdate(response.lastUpdated, pairKey);

        // Short cache for order book data
        res.setHeader('Cache-Control', 'private, max-age=1');
        return res.status(200).json(response);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Internal server error';
        logger.error({ err, pairKey }, '[API /pairs/[key]/orderbook] Error');

        // Check for rate limiting
        if (errorMessage.includes('Rate limited')) {
            return res.status(429).json({
                error: 'Rate limited - please try again shortly',
                code: 'RATE_LIMITED',
                requestId,
            });
        }

        return res.status(500).json({
            error: errorMessage,
            code: 'INTERNAL_ERROR',
            requestId,
        });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
