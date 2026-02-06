/**
 * useTradeTape hook — polls /api/trades/tape for live trade tape data.
 *
 * Validates pairKey match and rejects stale/mismatched responses.
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import type { Trade } from '../../../market/tradeTape';
import type { PairPayload } from '../types/pairPayload';
import { isPairPayloadUsable } from '../types/pairPayload';

export interface TradeTapeData {
    trades: Trade[];
    tradeCount: number;
    lastTradeAtMs: number | null;
}

export interface UseTradeTapeState {
    data: TradeTapeData | null;
    loading: boolean;
    error: string | null;
    /** True if the last response was rejected (wrong pair or stale). */
    rejected: boolean;
}

export interface UseTradeTapeOptions {
    /** Polling interval in milliseconds (default: 3000). */
    pollInterval?: number;
    /** Max staleness before rejecting the response (default: 30 000 ms). */
    maxStalenessMs?: number;
    /** Enable/disable fetching (default: true). */
    enabled?: boolean;
}

const API_ENDPOINT = '/api/trades/tape';

export function useTradeTape(
    pairKey: string | null | undefined,
    options: UseTradeTapeOptions = {},
): UseTradeTapeState {
    const { pollInterval = 3000, maxStalenessMs = 30_000, enabled = true } = options;
    const [data, setData] = useState<TradeTapeData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [rejected, setRejected] = useState(false);
    const mountedRef = useRef(true);

    const fetchTape = useCallback(
        async (isInitial = false) => {
            if (!pairKey || !enabled) return;
            if (isInitial) setLoading(true);

            try {
                const res = await fetch(API_ENDPOINT);
                if (!mountedRef.current) return;
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const payload: PairPayload<TradeTapeData> = await res.json();
                if (!mountedRef.current) return;

                if (!isPairPayloadUsable(payload, pairKey, maxStalenessMs)) {
                    setRejected(true);
                    return;
                }

                setData(payload.data);
                setError(null);
                setRejected(false);
            } catch (err) {
                if (!mountedRef.current) return;
                setError(err instanceof Error ? err.message : 'Unknown error');
            } finally {
                if (mountedRef.current) setLoading(false);
            }
        },
        [pairKey, enabled, maxStalenessMs],
    );

    useEffect(() => {
        mountedRef.current = true;
        if (!pairKey || !enabled) {
            setData(null);
            setError(null);
            setRejected(false);
            return;
        }
        fetchTape(true);
        const id = setInterval(() => fetchTape(false), pollInterval);
        return () => {
            mountedRef.current = false;
            clearInterval(id);
        };
    }, [pairKey, pollInterval, enabled, fetchTape]);

    // Reset on pair change
    useEffect(() => {
        setData(null);
        setError(null);
        setRejected(false);
    }, [pairKey]);

    return { data, loading, error, rejected };
}
