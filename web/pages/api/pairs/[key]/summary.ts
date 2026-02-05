/**
 * GET /api/pairs/[key]/summary
 * 
 * Returns price summary for a trading pair:
 * - midPrice, bid, ask, spreadBps
 * - Network availability status
 * - Warnings for low liquidity or missing markets
 * 
 * In SINGLE_PROCESS_MODE=true, returns data from TradingRuntime instead of XRPL.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { findPair, isValidPairKey, TradingPair } from '../../../../lib/tradingPairs';
import { loadConfig } from '../../../../../src/config';
import { getSharedClient, getCachedPrice, setCachedPrice } from '../../../../lib/xrplClient';
import { logger } from '../../../../../src/analytics/logger';
import {
    isSingleProcessMode,
    getOrderBookFromRuntime,
    isRuntimeWarmingUp,
    initRuntimeBridge,
} from '../../../../lib/runtimeBridge';

export const config = {
    api: { bodyParser: false },
};

// =============================================================================
// Types
// =============================================================================

interface PairSummary {
    pair: string;
    midPrice: number;
    bid: number;
    ask: number;
    spreadBps: number;
    lastUpdated: number;
    network: 'mainnet' | 'testnet';
    availableOnNetwork: boolean;
    warnings: string[];
    cached?: boolean;
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
 * Extract price from a book_offers response.
 */
function extractPrice(
    offers: any[] | undefined,
    baseIsXRP: boolean,
    quoteIsXRP: boolean,
    isAsk: boolean
): number {
    if (!offers || offers.length === 0) {
        return 0;
    }

    const offer = offers[0];
    if (!offer) return 0;

    if (isAsk) {
        // Ask: TakerGets = base, TakerPays = quote
        const baseQty = baseIsXRP
            ? Number(offer.TakerGets) / 1_000_000
            : Number((offer.TakerGets as any)?.value || 0);
        const quoteQty = quoteIsXRP
            ? Number(offer.TakerPays) / 1_000_000
            : Number((offer.TakerPays as any)?.value || 0);
        return baseQty > 0 ? quoteQty / baseQty : 0;
    } else {
        // Bid: TakerGets = quote, TakerPays = base
        const quoteQty = quoteIsXRP
            ? Number(offer.TakerGets) / 1_000_000
            : Number((offer.TakerGets as any)?.value || 0);
        const baseQty = baseIsXRP
            ? Number(offer.TakerPays) / 1_000_000
            : Number((offer.TakerPays as any)?.value || 0);
        return baseQty > 0 ? quoteQty / baseQty : 0;
    }
}

/**
 * Fetch bid/ask from XRPL for a trading pair.
 */
async function fetchPairPrices(
    pair: TradingPair,
    endpoint: string
): Promise<{ bid: number; ask: number; warnings: string[] }> {
    const warnings: string[] = [];
    let bid = 0;
    let ask = 0;

    try {
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
            limit: 5,
        });

        // Fetch bids (buying base with quote)
        const bidsRes = await client.request({
            command: 'book_offers',
            taker_gets: quoteAmount as any,
            taker_pays: baseAmount as any,
            ledger_index: 'validated',
            limit: 5,
        });

        const askOffers = (asksRes.result as any)?.offers;
        const bidOffers = (bidsRes.result as any)?.offers;

        ask = extractPrice(askOffers, baseIsXRP, quoteIsXRP, true);
        bid = extractPrice(bidOffers, baseIsXRP, quoteIsXRP, false);

        // Check for warnings
        if (!askOffers || askOffers.length === 0) {
            warnings.push('No ask offers in order book');
        }
        if (!bidOffers || bidOffers.length === 0) {
            warnings.push('No bid offers in order book');
        }
        if (askOffers?.length === 1 || bidOffers?.length === 1) {
            warnings.push('Low order book depth');
        }
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn({ pair: pair.key, error: errorMessage }, '[PairSummary] XRPL request failed');

        if (errorMessage.includes('Rate limited')) {
            warnings.push('Temporarily rate limited - try again shortly');
        } else {
            warnings.push('Unable to fetch current prices');
        }
    }

    return { bid, ask, warnings };
}

// =============================================================================
// Handler
// =============================================================================

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<PairSummary | ErrorResponse>
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

    // Initialize runtime bridge in single-process mode
    if (isSingleProcessMode()) {
        try {
            await initRuntimeBridge();
        } catch (err) {
            logger.warn({ err }, '[PairSummary] Runtime bridge init failed, falling back to direct XRPL');
        }
    }

    // Extract pair key from dynamic route
    const { key } = req.query;
    const pairKey = Array.isArray(key) ? key[0] : key;

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
                const response: PairSummary = {
                    pair: pairKey,
                    midPrice: 0,
                    bid: 0,
                    ask: 0,
                    spreadBps: 0,
                    lastUpdated: Date.now(),
                    network: currentNetwork,
                    availableOnNetwork: false,
                    warnings: ['Runtime starting - data will be available shortly'],
                    warmingUp: true,
                    fromRuntime: true,
                };
                return res.status(200).json(response);
            }

            // Return runtime data if available
            if (orderBook && orderBook.bids.length > 0) {
                const bestBid = orderBook.bids[0]?.price ?? 0;
                const bestAsk = orderBook.asks[0]?.price ?? 0;
                const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

                const response: PairSummary = {
                    pair: pairKey,
                    midPrice,
                    bid: bestBid,
                    ask: bestAsk,
                    spreadBps: orderBook.spreadBps,
                    lastUpdated: orderBook.lastUpdated,
                    network: currentNetwork,
                    availableOnNetwork: midPrice > 0,
                    warnings: [],
                    fromRuntime: true,
                };
                res.setHeader('Cache-Control', 'private, max-age=1');
                return res.status(200).json(response);
            }

            // Fallback: no runtime data yet, return empty with warning
            const response: PairSummary = {
                pair: pairKey,
                midPrice: 0,
                bid: 0,
                ask: 0,
                spreadBps: 0,
                lastUpdated: Date.now(),
                network: currentNetwork,
                availableOnNetwork: false,
                warnings: ['Waiting for order book data from runtime'],
                fromRuntime: true,
            };
            return res.status(200).json(response);
        }

        // =====================================================================
        // Dual-process mode (legacy): direct XRPL calls
        // =====================================================================

        // Check cache first
        const cached = getCachedPrice(pairKey);
        if (cached) {
            const response: PairSummary = {
                pair: pairKey,
                midPrice: cached.midPrice,
                bid: cached.bidPrice,
                ask: cached.askPrice,
                spreadBps: cached.spreadBps,
                lastUpdated: Date.now(),
                network: currentNetwork,
                availableOnNetwork: cached.midPrice > 0,
                warnings: [],
                cached: true,
            };

            if (cached.midPrice === 0) {
                response.warnings.push('No liquidity available on this network');
            }

            return res.status(200).json(response);
        }

        // Fetch fresh prices
        const { bid, ask, warnings } = await fetchPairPrices(pair, cfg.xrpl.endpoint);

        // Calculate mid price and spread
        const midPrice = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
        const spreadBps = midPrice > 0 && bid > 0 && ask > 0
            ? ((ask - bid) / midPrice) * 10000
            : 0;

        // Determine network availability
        const availableOnNetwork = midPrice > 0;

        // Network mismatch warning
        if (pair.network === 'mainnet' && currentNetwork === 'testnet') {
            if (!availableOnNetwork) {
                warnings.push('This pair uses mainnet issuers - may not be available on testnet');
            }
        }

        // Cache the result
        setCachedPrice(pairKey, { midPrice, bidPrice: bid, askPrice: ask, spreadBps });

        const response: PairSummary = {
            pair: pairKey,
            midPrice,
            bid,
            ask,
            spreadBps,
            lastUpdated: Date.now(),
            network: currentNetwork,
            availableOnNetwork,
            warnings,
        };

        // Short cache for price data
        res.setHeader('Cache-Control', 'private, max-age=1');
        return res.status(200).json(response);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Internal server error';
        logger.error({ err, pairKey }, '[API /pairs/[key]/summary] Error');
        return res.status(500).json({
            error: errorMessage,
            code: 'INTERNAL_ERROR',
            requestId,
        });
    }
}
