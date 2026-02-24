/**
 * useOrderBook Hook
 * 
 * Fetches real order book data from /api/pairs/[key]/orderbook
 * with polling and proper loading/error/empty states.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderBookLevel {
    price: number;
    size: number;
    total: number;
}

export interface OrderBookData {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    midPrice: number | null;
    spreadBps: number | null;
    lastUpdated: number | null;
    network: 'mainnet' | 'testnet' | null;
}

export interface UseOrderBookState {
    data: OrderBookData;
    loading: boolean;
    error: string | null;
    isEmpty: boolean;
    /** True when the last response was rejected (stale or pair mismatch). */
    rejected: boolean;
}

export interface UseOrderBookOptions {
    /** Polling interval in milliseconds (default: 3000) */
    pollInterval?: number;
    /** Number of levels to fetch (default: 15) */
    depth?: number;
    /** Enable/disable fetching (default: true) */
    enabled?: boolean;
    /** Maximum acceptable data age in ms (default: 30 000). */
    maxStalenessMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default State
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_ORDER_BOOK: OrderBookData = {
    bids: [],
    asks: [],
    midPrice: null,
    spreadBps: null,
    lastUpdated: null,
    network: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Hook Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STALENESS_MS = 30_000;

export function useOrderBook(
    pairKey: string | null | undefined,
    options: UseOrderBookOptions = {}
): UseOrderBookState {
    const {
        pollInterval = 3000,
        depth = 15,
        enabled = true,
        maxStalenessMs = DEFAULT_MAX_STALENESS_MS,
    } = options;

    const [data, setData] = useState<OrderBookData>(EMPTY_ORDER_BOOK);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [rejected, setRejected] = useState<boolean>(false);

    // Track mounted state for async cleanup
    const isMountedRef = useRef(true);
    const abortControllerRef = useRef<AbortController | null>(null);
    // Stable ref so the callback always sees the latest pairKey
    const pairKeyRef = useRef(pairKey);
    pairKeyRef.current = pairKey;

    const fetchOrderBook = useCallback(async (isInitial = false) => {
        if (!pairKey || !enabled) return;

        // Abort previous request if still pending
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        abortControllerRef.current = new AbortController();

        if (isInitial) {
            setLoading(true);
        }

        try {
            const url = `/api/pairs/${encodeURIComponent(pairKey)}/orderbook?depth=${depth}`;
            const response = await fetch(url, {
                signal: abortControllerRef.current.signal,
            });

            if (!isMountedRef.current) return;

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData?.error || `HTTP ${response.status}`);
            }

            const result = await response.json();

            if (!isMountedRef.current) return;

            // Pair-truth validation: response must match the requested pairKey
            const currentPairKey = pairKeyRef.current;
            if (currentPairKey && result.pair && result.pair !== currentPairKey) {
                setData(EMPTY_ORDER_BOOK);
                setError('Order book response pair mismatch');
                setRejected(true);
                return;
            }

            // Staleness validation
            const responseTs = result.lastUpdated || Date.now();
            const age = Date.now() - responseTs;
            if (age > maxStalenessMs) {
                setData(EMPTY_ORDER_BOOK);
                setError('Order book data is stale');
                setRejected(true);
                return;
            }

            // Calculate mid price and spread from bids/asks
            const bestBid = result.bids?.[0]?.price ?? null;
            const bestAsk = result.asks?.[0]?.price ?? null;
            let midPrice: number | null = null;
            let spreadBps: number | null = null;

            if (bestBid !== null && bestAsk !== null && bestBid > 0) {
                midPrice = (bestBid + bestAsk) / 2;
                spreadBps = ((bestAsk - bestBid) / bestBid) * 10000;
            }

            setData({
                bids: result.bids || [],
                asks: result.asks || [],
                midPrice,
                spreadBps,
                lastUpdated: result.lastUpdated || Date.now(),
                network: result.network || null,
            });
            setError(null);
            setRejected(false);
        } catch (err) {
            if (!isMountedRef.current) return;

            // Ignore abort errors
            if (err instanceof Error && err.name === 'AbortError') return;

            const message = err instanceof Error ? err.message : 'Failed to fetch order book';
            setData(EMPTY_ORDER_BOOK);
            setError(message);
            setRejected(true);
            console.error('[useOrderBook] Error:', message);
        } finally {
            if (isMountedRef.current) {
                setLoading(false);
            }
        }
    }, [pairKey, depth, enabled, maxStalenessMs]);

    // Initial fetch and polling
    useEffect(() => {
        isMountedRef.current = true;

        if (!pairKey || !enabled) {
            setData(EMPTY_ORDER_BOOK);
            setLoading(false);
            setError(null);
            return;
        }

        // Initial fetch
        fetchOrderBook(true);

        // Set up polling
        const intervalId = setInterval(() => {
            fetchOrderBook(false);
        }, pollInterval);

        return () => {
            isMountedRef.current = false;
            clearInterval(intervalId);
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [pairKey, pollInterval, enabled, fetchOrderBook]);

    // Reset on pair change
    useEffect(() => {
        setData(EMPTY_ORDER_BOOK);
        setError(null);
        setRejected(false);
    }, [pairKey]);

    const isEmpty = data.bids.length === 0 && data.asks.length === 0;

    return {
        data,
        loading,
        error,
        isEmpty,
        rejected,
    };
}
