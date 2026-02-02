/**
 * GET /api/pairs/[key]/orderbook
 * 
 * Returns the order book for a trading pair:
 * - Top N bids and asks with normalized prices/sizes
 * - Network availability status
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { findPair, isValidPairKey, TradingPair } from '../../../../lib/tradingPairs';
import { loadConfig } from '../../../../../src/config';
import { getSharedClient } from '../../../../lib/xrplClient';
import { logger } from '../../../../../src/analytics/logger';

export const config = {
    api: { bodyParser: false },
};

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

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<OrderBookResponse | ErrorResponse>
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
