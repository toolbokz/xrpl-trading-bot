/**
 * useCandles Hook
 * 
 * Fetches candlestick (OHLCV) data from /api/pairs/[key]/candles
 * with polling and proper loading/error/empty states.
 * 
 * Supports incremental updates for live chart updates.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CandlestickData, UTCTimestamp } from 'lightweight-charts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Candle {
    time: number; // Unix timestamp in seconds
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface UseCandlesState {
    candles: CandlestickData<UTCTimestamp>[];
    loading: boolean;
    error: string | null;
    isEmpty: boolean;
    lastUpdated: number | null;
}

export interface UseCandlesOptions {
    /** Candle interval (default: '1m') */
    interval?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
    /** Number of candles to fetch (default: 120) */
    limit?: number;
    /** Polling interval in milliseconds (default: 10000) */
    pollInterval?: number;
    /** Enable/disable fetching (default: true) */
    enabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert API candle to lightweight-charts format
 */
function toChartCandle(candle: Candle): CandlestickData<UTCTimestamp> {
    return {
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
    };
}

/**
 * Merge new candles with existing candles, updating the last candle if times match
 */
function mergeCandles(
    existing: CandlestickData<UTCTimestamp>[],
    incoming: Candle[]
): CandlestickData<UTCTimestamp>[] {
    if (incoming.length === 0) return existing;

    const chartCandles = incoming.map(toChartCandle);

    if (existing.length === 0) return chartCandles;

    // Create a map for efficient lookup
    const candleMap = new Map<number, CandlestickData<UTCTimestamp>>();

    // Add existing candles
    for (const candle of existing) {
        const time = typeof candle.time === 'number' ? candle.time : Number(candle.time);
        candleMap.set(time, candle);
    }

    // Merge/update with incoming candles
    for (const candle of chartCandles) {
        const time = typeof candle.time === 'number' ? candle.time : Number(candle.time);
        candleMap.set(time, candle);
    }

    // Convert back to array and sort by time
    const merged = Array.from(candleMap.values()).sort((a, b) => {
        const timeA = typeof a.time === 'number' ? a.time : Number(a.time);
        const timeB = typeof b.time === 'number' ? b.time : Number(b.time);
        return timeA - timeB;
    });

    return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook Implementation
// ─────────────────────────────────────────────────────────────────────────────

export function useCandles(
    pairKey: string | null | undefined,
    options: UseCandlesOptions = {}
): UseCandlesState {
    const {
        interval = '1m',
        limit = 120,
        pollInterval = 10000,
        enabled = true,
    } = options;

    const [candles, setCandles] = useState<CandlestickData<UTCTimestamp>[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    // Track mounted state for async cleanup
    const isMountedRef = useRef(true);
    const abortControllerRef = useRef<AbortController | null>(null);
    const isInitialFetchRef = useRef(true);
    const lastUpdatedRef = useRef(lastUpdated);
    lastUpdatedRef.current = lastUpdated;

    const fetchCandles = useCallback(async (isInitial = false) => {
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
            const params = new URLSearchParams({
                interval,
                limit: String(limit),
            });

            // For incremental updates, fetch only recent candles
            if (!isInitial && lastUpdatedRef.current) {
                params.set('since', String(lastUpdatedRef.current));
                params.set('limit', '5'); // Only fetch last few candles for updates
            }

            const url = `/api/pairs/${encodeURIComponent(pairKey)}/candles?${params}`;
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

            const newCandles: Candle[] = result.candles || [];

            if (isInitial) {
                setCandles(newCandles.map(toChartCandle));
            } else {
                // Merge incremental updates
                setCandles(prev => mergeCandles(prev, newCandles));
            }

            setLastUpdated(result.lastUpdated || Date.now());
            setError(null);
        } catch (err) {
            if (!isMountedRef.current) return;

            // Ignore abort errors
            if (err instanceof Error && err.name === 'AbortError') return;

            const message = err instanceof Error ? err.message : 'Failed to fetch candles';
            setError(message);
            console.error('[useCandles] Error:', message);
        } finally {
            if (isMountedRef.current) {
                setLoading(false);
            }
        }
    }, [pairKey, interval, limit, enabled]);

    // Initial fetch and polling
    useEffect(() => {
        isMountedRef.current = true;
        isInitialFetchRef.current = true;

        if (!pairKey || !enabled) {
            setCandles([]);
            setLoading(false);
            setError(null);
            setLastUpdated(null);
            return;
        }

        // Initial fetch
        fetchCandles(true);
        isInitialFetchRef.current = false;

        // Set up polling
        const intervalId = setInterval(() => {
            fetchCandles(false);
        }, pollInterval);

        return () => {
            isMountedRef.current = false;
            clearInterval(intervalId);
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [pairKey, interval, limit, pollInterval, enabled, fetchCandles]);

    // Reset on pair change
    useEffect(() => {
        setCandles([]);
        setError(null);
        setLastUpdated(null);
    }, [pairKey]);

    const isEmpty = candles.length === 0;

    return {
        candles,
        loading,
        error,
        isEmpty,
        lastUpdated,
    };
}
