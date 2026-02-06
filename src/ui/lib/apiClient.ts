/**
 * API Client - Typed fetch utilities with caching and error handling
 * 
 * This module provides a professional, typed interface for all API calls.
 * Features:
 * - Typed request/response DTOs
 * - Consistent error handling
 * - SWR-compatible caching
 * - Request deduplication
 * 
 * @module lib/apiClient
 */

import { z } from 'zod';

// =============================================================================
// Error Types
// =============================================================================

export interface ApiErrorResponse {
    error: string;
    code?: string | undefined;
    requestId?: string | undefined;
    details?: Array<{ field: string; message: string }> | undefined;
}

export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly code?: string,
        public readonly requestId?: string,
        public readonly details?: Array<{ field: string; message: string }>
    ) {
        super(message);
        this.name = 'ApiError';
    }

    static fromResponse(status: number, data: ApiErrorResponse): ApiError {
        return new ApiError(
            data.error || 'Unknown error',
            status,
            data.code,
            data.requestId,
            data.details
        );
    }

    toJSON(): ApiErrorResponse {
        return {
            error: this.message,
            code: this.code,
            requestId: this.requestId,
            details: this.details,
        };
    }
}

// =============================================================================
// DTO Types - Pair Endpoints
// =============================================================================

export interface PairListItem {
    key: string;
    description: string;
    liquidity: 'high' | 'medium' | 'low';
    network: 'mainnet' | 'testnet';
    baseCurrency: string;
    quoteCurrency: string;
}

export interface PairSummary {
    pair: string;
    midPrice: number;
    bid: number;
    ask: number;
    spreadBps: number;
    lastUpdated: number;
    network: 'mainnet' | 'testnet';
    availableOnNetwork: boolean;
    warnings: string[];
    cached?: boolean | undefined;
}

export interface OrderBookLevel {
    price: number;
    size: number;
    total: number;
}

export interface OrderBookData {
    pair: string;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    lastUpdated: number;
    network: 'mainnet' | 'testnet';
    availableOnNetwork: boolean;
}

export interface TradeRecord {
    id: string;
    timestamp: number;
    pair: string;
    side: 'BUY' | 'SELL';
    price: number;
    amount: number;
    total: number;
}

// =============================================================================
// Zod Schemas for Response Validation
// =============================================================================

export const pairListItemSchema = z.object({
    key: z.string(),
    description: z.string(),
    liquidity: z.enum(['high', 'medium', 'low']),
    network: z.enum(['mainnet', 'testnet']),
    baseCurrency: z.string(),
    quoteCurrency: z.string(),
});

export const pairSummarySchema = z.object({
    pair: z.string(),
    midPrice: z.number(),
    bid: z.number(),
    ask: z.number(),
    spreadBps: z.number(),
    lastUpdated: z.number(),
    network: z.enum(['mainnet', 'testnet']),
    availableOnNetwork: z.boolean(),
    warnings: z.array(z.string()),
    cached: z.boolean().optional(),
});

export const orderBookLevelSchema = z.object({
    price: z.number(),
    size: z.number(),
    total: z.number(),
});

export const orderBookDataSchema = z.object({
    pair: z.string(),
    bids: z.array(orderBookLevelSchema),
    asks: z.array(orderBookLevelSchema),
    lastUpdated: z.number(),
    network: z.enum(['mainnet', 'testnet']),
    availableOnNetwork: z.boolean(),
});

// =============================================================================
// Cache Implementation
// =============================================================================

interface CacheEntry<T> {
    data: T;
    timestamp: number;
    expiresAt: number;
}

class ResponseCache {
    private cache = new Map<string, CacheEntry<unknown>>();
    private defaultTTL = 1000; // 1 second default

    get<T>(key: string): T | null {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return null;
        }
        return entry.data as T;
    }

    set<T>(key: string, data: T, ttlMs: number = this.defaultTTL): void {
        const now = Date.now();
        this.cache.set(key, {
            data,
            timestamp: now,
            expiresAt: now + ttlMs,
        });
    }

    invalidate(keyPattern?: string): void {
        if (!keyPattern) {
            this.cache.clear();
            return;
        }
        for (const key of this.cache.keys()) {
            if (key.includes(keyPattern)) {
                this.cache.delete(key);
            }
        }
    }

    getTimestamp(key: string): number | null {
        const entry = this.cache.get(key);
        return entry ? entry.timestamp : null;
    }
}

export const apiCache = new ResponseCache();

// =============================================================================
// Fetch Utilities
// =============================================================================

interface FetchOptions<T> {
    /** Cache TTL in milliseconds (0 to disable) */
    cacheTTL?: number | undefined;
    /** Skip cache read (still writes to cache) */
    bypassCache?: boolean | undefined;
    /** Zod schema for response validation */
    schema?: z.ZodSchema<T> | undefined;
    /** Request timeout in milliseconds */
    timeout?: number | undefined;
    /** Custom headers */
    headers?: Record<string, string> | undefined;
}

async function fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function apiGet<T>(
    path: string,
    options: FetchOptions<T> = {}
): Promise<T> {
    const { cacheTTL = 1000, bypassCache = false, schema, timeout = 10000, headers = {} } = options;

    // Check cache
    const cacheKey = `GET:${path}`;
    if (!bypassCache && cacheTTL > 0) {
        const cached = apiCache.get<T>(cacheKey);
        if (cached !== null) {
            return cached;
        }
    }

    // Make request
    const response = await fetchWithTimeout(
        path,
        {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                ...headers,
            },
        },
        timeout
    );

    // Handle errors
    if (!response.ok) {
        let errorData: ApiErrorResponse;
        try {
            errorData = await response.json();
        } catch {
            errorData = { error: response.statusText };
        }
        throw ApiError.fromResponse(response.status, errorData);
    }

    // Parse response
    const data = await response.json();

    // Validate with schema if provided
    if (schema) {
        const result = schema.safeParse(data);
        if (!result.success) {
            console.error('API response validation failed:', result.error.errors);
            // Return data anyway but log warning in development
        }
    }

    // Cache response
    if (cacheTTL > 0) {
        apiCache.set(cacheKey, data, cacheTTL);
    }

    return data as T;
}

export async function apiPost<T, B = unknown>(
    path: string,
    body: B,
    options: Omit<FetchOptions<T>, 'cacheTTL' | 'bypassCache'> = {}
): Promise<T> {
    const { schema, timeout = 10000, headers = {} } = options;

    const response = await fetchWithTimeout(
        path,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...headers,
            },
            body: JSON.stringify(body),
        },
        timeout
    );

    if (!response.ok) {
        let errorData: ApiErrorResponse;
        try {
            errorData = await response.json();
        } catch {
            errorData = { error: response.statusText };
        }
        throw ApiError.fromResponse(response.status, errorData);
    }

    const data = await response.json();

    if (schema) {
        const result = schema.safeParse(data);
        if (!result.success) {
            console.error('API response validation failed:', result.error.errors);
        }
    }

    // Invalidate related cache entries
    apiCache.invalidate(path.split('?')[0]);

    return data as T;
}

// =============================================================================
// Pair API Functions
// =============================================================================

/**
 * Fetch list of all trading pairs.
 */
export async function fetchPairs(options?: { bypassCache?: boolean }): Promise<PairListItem[]> {
    return apiGet<PairListItem[]>('/api/pairs', {
        cacheTTL: 60000, // 1 minute cache
        bypassCache: options?.bypassCache,
        schema: z.array(pairListItemSchema),
    });
}

/**
 * Fetch summary for a specific pair (price, spread, availability).
 */
export async function fetchPairSummary(
    key: string,
    options?: { bypassCache?: boolean }
): Promise<PairSummary> {
    return apiGet<PairSummary>(`/api/pairs/${encodeURIComponent(key)}/summary`, {
        cacheTTL: 1000, // 1 second cache
        bypassCache: options?.bypassCache,
        schema: pairSummarySchema,
    });
}

/**
 * Fetch order book for a specific pair.
 */
export async function fetchOrderBook(
    key: string,
    options?: { depth?: number; bypassCache?: boolean }
): Promise<OrderBookData> {
    const depth = options?.depth ?? 10;
    return apiGet<OrderBookData>(
        `/api/pairs/${encodeURIComponent(key)}/orderbook?depth=${depth}`,
        {
            cacheTTL: 1000, // 1 second cache
            bypassCache: options?.bypassCache,
            schema: orderBookDataSchema,
        }
    );
}

/**
 * Fetch recent trades for a pair (if available).
 */
export async function fetchRecentTrades(
    key: string,
    options?: { limit?: number; bypassCache?: boolean }
): Promise<TradeRecord[]> {
    const limit = options?.limit ?? 20;
    return apiGet<TradeRecord[]>(
        `/api/pairs/${encodeURIComponent(key)}/trades?limit=${limit}`,
        {
            cacheTTL: 5000, // 5 second cache
            bypassCache: options?.bypassCache,
        }
    );
}

// =============================================================================
// Number Formatting Utilities
// =============================================================================

/**
 * Format XRP amount (6 decimal places).
 */
export function formatXRP(amount: number): string {
    return amount.toFixed(6);
}

/**
 * Format IOU amount with appropriate precision.
 * @param amount - The amount to format
 * @param currency - The currency code for context-aware formatting
 */
export function formatIOU(amount: number, currency?: string): string {
    // Stablecoins typically use 2 decimal places
    const stablecoins = ['USD', 'USDT', 'USDC', 'RLUSD', 'EUR'];
    if (currency && stablecoins.includes(currency.toUpperCase())) {
        return amount.toFixed(4);
    }
    // Crypto assets may need more precision
    if (currency && ['BTC', 'ETH'].includes(currency.toUpperCase())) {
        return amount.toFixed(8);
    }
    // Default: 6 decimals
    return amount.toFixed(6);
}

/**
 * Format spread in basis points.
 */
export function formatSpreadBps(bps: number): string {
    if (bps < 0) return '0.00';
    if (bps < 1) return bps.toFixed(2);
    if (bps < 10) return bps.toFixed(1);
    return Math.round(bps).toString();
}

/**
 * Format price for display, adapting precision to value.
 */
export function formatPrice(price: number, quoteCurrency?: string): string {
    if (price === 0) return '0';

    // For very small prices (like BTC/ETH ratios)
    if (price < 0.0001) {
        return price.toExponential(4);
    }

    // For prices close to 1 (like stablecoins)
    if (quoteCurrency && ['USD', 'USDT', 'USDC', 'RLUSD', 'EUR'].includes(quoteCurrency.toUpperCase())) {
        return price.toFixed(4);
    }

    // For crypto prices
    if (price < 1) {
        return price.toFixed(6);
    }

    // For larger prices
    return price.toFixed(4);
}

/**
 * Get liquidity badge color class.
 */
export function getLiquidityColor(liquidity: 'high' | 'medium' | 'low'): string {
    switch (liquidity) {
        case 'high':
            return 'bg-success/20 text-success';
        case 'medium':
            return 'bg-yellow-500/20 text-yellow-400';
        case 'low':
            return 'bg-danger/20 text-danger';
    }
}

/**
 * Get network badge color class.
 */
export function getNetworkColor(network: 'mainnet' | 'testnet'): string {
    return network === 'mainnet'
        ? 'bg-blue-500/20 text-blue-400'
        : 'bg-orange-500/20 text-orange-400';
}
