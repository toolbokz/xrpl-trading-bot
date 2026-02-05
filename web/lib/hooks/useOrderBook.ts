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
}

export interface UseOrderBookOptions {
    /** Polling interval in milliseconds (default: 3000) */
    pollInterval?: number;
    /** Number of levels to fetch (default: 15) */
    depth?: number;
    /** Enable/disable fetching (default: true) */
    enabled?: boolean;
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

export function useOrderBook(
    pairKey: string | null | undefined,
    options: UseOrderBookOptions = {}
): UseOrderBookState {
    const {
        pollInterval = 3000,
        depth = 15,
        enabled = true,
    } = options;

    const [data, setData] = useState<OrderBookData>(EMPTY_ORDER_BOOK);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    // Track mounted state for async cleanup
    const isMountedRef = useRef(true);
    const abortControllerRef = useRef<AbortController | null>(null);

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
        } catch (err) {
            if (!isMountedRef.current) return;

            // Ignore abort errors
            if (err instanceof Error && err.name === 'AbortError') return;

            const message = err instanceof Error ? err.message : 'Failed to fetch order book';
            setError(message);
            console.error('[useOrderBook] Error:', message);
        } finally {
            if (isMountedRef.current) {
                setLoading(false);
            }
        }
    }, [pairKey, depth, enabled]);

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
    }, [pairKey]);

    const isEmpty = data.bids.length === 0 && data.asks.length === 0;

    return {
        data,
        loading,
        error,
        isEmpty,
    };
}
