/**
 * useFlowMetrics hook — polls /api/bot/flow for pair-keyed flow metrics.
 *
 * Validates pairKey match and rejects stale/mismatched responses.
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import type { FlowMetrics, FlowRegime } from '../../../src/market/flowMetrics';

export interface FlowMetricsState {
    metrics: FlowMetrics | null;
    regime: FlowRegime | null;
    executionAllowed: boolean;
    loading: boolean;
    error: string | null;
    /** True if the last response was rejected (wrong pair or stale). */
    rejected: boolean;
}

export interface UseFlowMetricsOptions {
    /** Polling interval in milliseconds (default: 3000). */
    pollInterval?: number;
    /** Max staleness before rejecting (default: 30 000 ms). */
    maxStalenessMs?: number;
    /** Enable/disable fetching (default: true). */
    enabled?: boolean;
}

const API_ENDPOINT = '/api/bot/flow';

export function useFlowMetrics(
    pairKey: string | null | undefined,
    options: UseFlowMetricsOptions = {},
): FlowMetricsState {
    const { pollInterval = 3000, maxStalenessMs = 30_000, enabled = true } = options;
    const [metrics, setMetrics] = useState<FlowMetrics | null>(null);
    const [regime, setRegime] = useState<FlowRegime | null>(null);
    const [executionAllowed, setExecutionAllowed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [rejected, setRejected] = useState(false);
    const mountedRef = useRef(true);

    const fetchFlow = useCallback(
        async (isInitial = false) => {
            if (!pairKey || !enabled) return;
            if (isInitial) setLoading(true);

            try {
                const res = await fetch(API_ENDPOINT);
                if (!mountedRef.current) return;
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const payload = await res.json();
                if (!mountedRef.current) return;

                // Validate pair match and staleness
                if (payload.pairKey && payload.pairKey !== pairKey) {
                    setRejected(true);
                    return;
                }
                if (payload.asOfMs) {
                    const staleness = Date.now() - payload.asOfMs;
                    if (staleness > maxStalenessMs) {
                        setRejected(true);
                        return;
                    }
                }

                setMetrics(payload.metrics ?? null);
                setRegime(payload.regime?.current ?? null);
                setExecutionAllowed(payload.executionAllowed ?? false);
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
            setMetrics(null);
            setRegime(null);
            setExecutionAllowed(false);
            setError(null);
            setRejected(false);
            return;
        }
        fetchFlow(true);
        const id = setInterval(() => fetchFlow(false), pollInterval);
        return () => {
            mountedRef.current = false;
            clearInterval(id);
        };
    }, [pairKey, pollInterval, enabled, fetchFlow]);

    useEffect(() => {
        setMetrics(null);
        setRegime(null);
        setError(null);
        setRejected(false);
    }, [pairKey]);

    return { metrics, regime, executionAllowed, loading, error, rejected };
}
