import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { loadConfig } from '../../../../config';
import { findInstrument as findPair, isValidPairKey } from '../../../../market/instrumentRegistry';
import { getSharedClient, getCachedPrice, setCachedPrice } from '../../../lib/xrplClient';
import { logger } from '../../../../analytics/logger';

export const config = {
    api: { bodyParser: false },
};

/**
 * Convert a currency code to hex format if needed (for non-standard codes like RLUSD)
 */
function currencyToHex(currency: string): string {
    // Standard 3-character codes don't need conversion
    if (currency.length <= 3) {
        return currency;
    }
    // Convert to hex (padded to 40 chars / 20 bytes)
    const hex = Buffer.from(currency, 'utf8').toString('hex').toUpperCase();
    return hex.padEnd(40, '0');
}

interface PriceData {
    pair: string;
    midPrice: number;
    bidPrice: number;
    askPrice: number;
    spreadBps: number;
    timestamp: number;
    cached?: boolean;
}

async function handler(req: LocalRequest, res: NextApiResponse) {
    try {
        const cfg = loadConfig();

        // Get pair from query or use default
        const pairKey = typeof req.query.pair === 'string' ? req.query.pair : 'XRP/RLUSD';

        // Validate pair against source of truth
        if (!isValidPairKey(pairKey)) {
            return res.status(400).json({
                error: `Invalid trading pair: ${pairKey}`,
                code: 'INVALID_PAIR',
                requestId: req.requestId,
            });
        }

        const pair = findPair(pairKey);
        if (!pair) {
            return res.status(400).json({
                error: `Unknown trading pair: ${pairKey}`,
                code: 'PAIR_NOT_FOUND',
                requestId: req.requestId,
            });
        }

        // Check cache first
        const cached = getCachedPrice(pairKey);
        if (cached) {
            return res.status(200).json({
                pair: pairKey,
                ...cached,
                timestamp: Date.now(),
                cached: true,
            });
        }

        // Get shared client (reuses connection)
        const client = await getSharedClient(cfg.xrpl.endpoint);

        const baseCurrency = pair.base.currency;
        const baseIssuer = pair.base.issuer;
        const quoteCurrency = pair.quote.currency;
        const quoteIssuer = pair.quote.issuer;

        // Build taker_gets/taker_pays based on currencies
        const baseIsXRP = baseCurrency.toUpperCase() === 'XRP';
        const quoteIsXRP = quoteCurrency.toUpperCase() === 'XRP';

        // Type-safe currency amount construction
        type CurrencyAmount = { currency: string; issuer?: string | undefined };

        let baseAmount: CurrencyAmount;
        if (baseIsXRP) {
            baseAmount = { currency: 'XRP' };
        } else {
            baseAmount = { currency: currencyToHex(baseCurrency) };
            if (baseIssuer) baseAmount.issuer = baseIssuer;
        }

        let quoteAmount: CurrencyAmount;
        if (quoteIsXRP) {
            quoteAmount = { currency: 'XRP' };
        } else {
            quoteAmount = { currency: currencyToHex(quoteCurrency) };
            if (quoteIssuer) quoteAmount.issuer = quoteIssuer;
        }

        // Get asks (selling base for quote)
        const asksRes = await client.request({
            command: 'book_offers',
            taker_gets: baseAmount as any,
            taker_pays: quoteAmount as any,
            ledger_index: 'validated',
            limit: 1,
        });

        // Get bids (buying base with quote)
        const bidsRes = await client.request({
            command: 'book_offers',
            taker_gets: quoteAmount as any,
            taker_pays: baseAmount as any,
            ledger_index: 'validated',
            limit: 1,
        });

        let askPrice = 0;
        let bidPrice = 0;

        // Type guard for book_offers response
        const getOffers = (res: any) => res.result?.offers as Array<any> | undefined;

        // Calculate ask price (price to buy base)
        const askOffers = getOffers(asksRes);
        if (askOffers && askOffers.length > 0) {
            const offer = askOffers[0];
            const baseQty = baseIsXRP
                ? Number(offer.TakerGets) / 1_000_000
                : Number((offer.TakerGets as any).value);
            const quoteQty = quoteIsXRP
                ? Number(offer.TakerPays) / 1_000_000
                : Number((offer.TakerPays as any).value);
            if (baseQty > 0) {
                askPrice = quoteQty / baseQty;
            }
        }

        // Calculate bid price (price to sell base)
        const bidOffers = getOffers(bidsRes);
        if (bidOffers && bidOffers.length > 0) {
            const offer = bidOffers[0];
            const quoteQty = quoteIsXRP
                ? Number(offer.TakerGets) / 1_000_000
                : Number((offer.TakerGets as any).value);
            const baseQty = baseIsXRP
                ? Number(offer.TakerPays) / 1_000_000
                : Number((offer.TakerPays as any).value);
            if (baseQty > 0) {
                bidPrice = quoteQty / baseQty;
            }
        }

        // Don't disconnect - reuse connection
        // await client.disconnect();

        const midPrice = askPrice > 0 && bidPrice > 0 ? (askPrice + bidPrice) / 2 : askPrice || bidPrice;
        const spreadBps = midPrice > 0 && askPrice > 0 && bidPrice > 0
            ? ((askPrice - bidPrice) / midPrice) * 10000
            : 0;

        // Cache the result
        const priceResult = { midPrice, bidPrice, askPrice, spreadBps };
        setCachedPrice(pairKey, priceResult);

        const priceData: PriceData = {
            pair: pairKey,
            midPrice,
            bidPrice,
            askPrice,
            spreadBps,
            timestamp: Date.now(),
        };

        return res.status(200).json(priceData);
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch price';
        logger.error({ err }, '[API /bot/price] Error');

        // Return cached price if available on error
        const pairKey = typeof req.query.pair === 'string' ? req.query.pair : 'XRP/RLUSD';
        const cached = getCachedPrice(pairKey);
        if (cached) {
            return res.status(200).json({
                pair: pairKey,
                ...cached,
                timestamp: Date.now(),
                cached: true,
                stale: true,
                requestId: req.requestId,
            });
        }

        return res.status(500).json({ error: errorMessage, requestId: req.requestId });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
