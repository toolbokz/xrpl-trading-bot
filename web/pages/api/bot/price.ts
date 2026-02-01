import type { NextApiRequest, NextApiResponse } from 'next';
import { loadConfig } from '../../../../src/config';
import { tradingPairs } from '../../../lib/tradingPairs';
import { getSharedClient, getCachedPrice, setCachedPrice } from '../../../lib/xrplClient';

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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    try {
        const config = loadConfig();

        // Get pair from query or use default
        const pairKey = typeof req.query.pair === 'string' ? req.query.pair : 'XRP/RLUSD';
        const pair = tradingPairs.find((p) => p.key === pairKey);

        if (!pair) {
            return res.status(400).json({ error: `Unknown trading pair: ${pairKey}` });
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
        const client = await getSharedClient(config.xrpl.endpoint);

        const baseCurrency = pair.base.currency;
        const baseIssuer = pair.base.issuer;
        const quoteCurrency = pair.quote.currency;
        const quoteIssuer = pair.quote.issuer;

        // Build taker_gets/taker_pays based on currencies
        const baseIsXRP = baseCurrency.toUpperCase() === 'XRP';
        const quoteIsXRP = quoteCurrency.toUpperCase() === 'XRP';

        const baseAmount = baseIsXRP
            ? { currency: 'XRP' }
            : { currency: currencyToHex(baseCurrency), issuer: baseIssuer };

        const quoteAmount = quoteIsXRP
            ? { currency: 'XRP' }
            : { currency: currencyToHex(quoteCurrency), issuer: quoteIssuer };

        // Get asks (selling base for quote)
        const asksRes = await client.request({
            command: 'book_offers',
            taker_gets: baseAmount,
            taker_pays: quoteAmount,
            ledger_index: 'validated',
            limit: 1,
        });

        // Get bids (buying base with quote)
        const bidsRes = await client.request({
            command: 'book_offers',
            taker_gets: quoteAmount,
            taker_pays: baseAmount,
            ledger_index: 'validated',
            limit: 1,
        });

        let askPrice = 0;
        let bidPrice = 0;

        // Calculate ask price (price to buy base)
        if (asksRes.result.offers?.length > 0) {
            const offer = asksRes.result.offers[0];
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
        if (bidsRes.result.offers?.length > 0) {
            const offer = bidsRes.result.offers[0];
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
    } catch (err: any) {
        console.error('Price API error:', err);

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
            });
        }

        return res.status(500).json({ error: err?.message || 'Failed to fetch price' });
    }
}
