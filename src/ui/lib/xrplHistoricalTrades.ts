/**
 * XRPL Historical Trades Fetcher
 * 
 * Fetches recent trade history for a trading pair from XRPL Data API
 * to seed candlestick charts when the trade tape is empty.
 * 
 * Uses the public XRPL Data API (data.xrplf.org) which provides
 * exchange data aggregated from the DEX.
 * 
 * Note: Some newer tokens (like RLUSD) may not be available in the API.
 */

import { logger } from '../../analytics/logger';

// =============================================================================
// Types
// =============================================================================

export interface HistoricalTrade {
    ts: number;       // Unix timestamp in milliseconds
    price: number;
    sizeBase: number;
}

interface XRPLDataExchange {
    base_amount: string | number;
    counter_amount: string | number;
    rate: number;
    executed_time: string;
    tx_hash: string;
}

interface XRPLDataResponse {
    result: string;
    count: number;
    exchanges?: XRPLDataExchange[];
}

// =============================================================================
// Configuration
// =============================================================================

const DATA_API_BASE = 'https://data.xrplf.org/v1';
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 200;

// Cache to avoid hammering the API
interface CacheEntry {
    trades: HistoricalTrade[];
    fetchedAt: number;
}
const tradeCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 1 minute cache

// =============================================================================
// XRPL Currency Formatting
// =============================================================================

/**
 * Convert currency code to hex format if needed.
 * XRPL non-standard currency codes (>3 chars) must be 40-char hex.
 */
function currencyToHex(currency: string): string {
    if (currency.length <= 3) {
        return currency.toUpperCase();
    }
    // Already hex-encoded
    if (currency.length === 40 && /^[A-F0-9]{40}$/i.test(currency)) {
        return currency.toUpperCase();
    }
    // Convert to hex (padded to 40 chars / 20 bytes)
    const hex = Buffer.from(currency, 'utf8').toString('hex').toUpperCase();
    return hex.padEnd(40, '0');
}

/**
 * Format currency for XRPL Data API.
 * XRP is represented as "XRP", issued currencies as "CURRENCY+ISSUER"
 * Non-standard currency codes (>3 chars) must be hex-encoded.
 */
function formatCurrencyForDataApi(currency: string, issuer?: string): string {
    if (currency.toUpperCase() === 'XRP') {
        return 'XRP';
    }
    if (!issuer) {
        throw new Error(`Issuer required for currency: ${currency}`);
    }
    // Use hex format for non-standard currency codes (like RLUSD)
    const currencyCode = currencyToHex(currency);
    return `${currencyCode}+${issuer}`;
}

// =============================================================================
// API Fetcher
// =============================================================================

/**
 * Fetch recent trades for a trading pair from XRPL Data API.
 * 
 * @param baseCurrency - Base currency (e.g., "XRP")
 * @param quoteCurrency - Quote currency (e.g., "RLUSD")
 * @param issuer - Issuer for the issued currency
 * @param limit - Maximum trades to fetch
 */
export async function fetchHistoricalTrades(
    baseCurrency: string,
    quoteCurrency: string,
    issuer?: string,
    limit: number = MAX_RESULTS
): Promise<HistoricalTrade[]> {
    // Validate inputs
    if (!baseCurrency || !quoteCurrency) {
        logger.warn({ baseCurrency, quoteCurrency }, '[HistoricalTrades] Invalid currency pair');
        return [];
    }

    const pairKey = `${baseCurrency}/${quoteCurrency}`;

    // Check cache first
    const cached = tradeCache.get(pairKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        logger.debug({ pairKey, count: cached.trades.length }, '[HistoricalTrades] Returning cached data');
        return cached.trades;
    }

    try {
        // Determine base and counter for the API
        // XRPL Data API expects: /exchanges/{base}/{counter}
        const base = formatCurrencyForDataApi(baseCurrency, baseCurrency === 'XRP' ? undefined : issuer);
        const counter = formatCurrencyForDataApi(quoteCurrency, quoteCurrency === 'XRP' ? undefined : issuer);

        const url = `${DATA_API_BASE}/exchanges/${encodeURIComponent(base)}/${encodeURIComponent(counter)}?limit=${limit}&descending=true`;

        logger.debug({ url, pairKey }, '[HistoricalTrades] Fetching from XRPL Data API');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json',
            },
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            // 404 is expected for pairs not in the XRPL Data API (like newer tokens)
            if (response.status === 404) {
                logger.debug({ status: response.status, pairKey }, '[HistoricalTrades] Pair not available in API (expected for newer tokens)');
            } else {
                logger.warn({ status: response.status, pairKey }, '[HistoricalTrades] API returned non-OK status');
            }
            return cached?.trades ?? [];
        }

        const data = await response.json() as XRPLDataResponse;

        if (data.result !== 'success' || !data.exchanges) {
            logger.warn({ result: data.result, pairKey }, '[HistoricalTrades] API returned unsuccessful result');
            return cached?.trades ?? [];
        }

        // Convert to our trade format
        const trades: HistoricalTrade[] = data.exchanges.map(ex => ({
            ts: new Date(ex.executed_time).getTime(),
            price: ex.rate,
            sizeBase: typeof ex.base_amount === 'string' ? parseFloat(ex.base_amount) : ex.base_amount,
        })).filter(t => !isNaN(t.ts) && !isNaN(t.price) && !isNaN(t.sizeBase));

        // Sort ascending by time for candle aggregation
        trades.sort((a, b) => a.ts - b.ts);

        // Update cache
        tradeCache.set(pairKey, { trades, fetchedAt: Date.now() });

        logger.info({ pairKey, count: trades.length }, '[HistoricalTrades] Fetched historical trades');
        return trades;

    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            logger.warn({ pairKey }, '[HistoricalTrades] Request timed out');
        } else {
            logger.warn({ err, pairKey }, '[HistoricalTrades] Failed to fetch');
        }
        return cached?.trades ?? [];
    }
}

/**
 * Clear the trade cache (useful for testing or forcing refresh).
 */
export function clearHistoricalTradeCache(): void {
    tradeCache.clear();
}
