/**
 * useBalances hook — polls /api/runtime/balances for pair-keyed balance data.
 *
 * Validates pairKey match and rejects stale/mismatched responses.
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import type { PairPayload } from '../types/pairPayload';
import { isPairPayloadUsable } from '../types/pairPayload';

export interface BalanceData {
    xrpBalance: number;
    quoteBalance: number;
    quoteCurrency: string;
    ledgerIndex: number;
}

export interface UseBalancesState {
    data: BalanceData | null;
    loading: boolean;
    error: string | null;
    /** True if the last response was rejected (wrong pair or stale). */
    rejected: boolean;
}

export interface UseBalancesOptions {
    /** Polling interval in milliseconds (default: 10 000). */
    pollInterval?: number;
    /** Max staleness before rejecting (default: 60 000 ms). */
    maxStalenessMs?: number;
    /** Enable/disable fetching (default: true). */
    enabled?: boolean;
}

const API_ENDPOINT = '/api/runtime/balances';

export function useBalances(
    pairKey: string | null | undefined,
    options: UseBalancesOptions = {},
): UseBalancesState {
    const { pollInterval = 10_000, maxStalenessMs = 60_000, enabled = true } = options;
    const [data, setData] = useState<BalanceData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [rejected, setRejected] = useState(false);
    const mountedRef = useRef(true);

    const fetchBalances = useCallback(
        async (isInitial = false) => {
            if (!pairKey || !enabled) return;
            if (isInitial) setLoading(true);

            try {
                const res = await fetch(API_ENDPOINT);
                if (!mountedRef.current) return;
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const payload: PairPayload<BalanceData> = await res.json();
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
        fetchBalances(true);
        const id = setInterval(() => fetchBalances(false), pollInterval);
        return () => {
            mountedRef.current = false;
            clearInterval(id);
        };
    }, [pairKey, pollInterval, enabled, fetchBalances]);

    useEffect(() => {
        setData(null);
        setError(null);
        setRejected(false);
    }, [pairKey]);

    return { data, loading, error, rejected };
}
