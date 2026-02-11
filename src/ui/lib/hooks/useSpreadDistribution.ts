import { useState, useEffect, useCallback, useRef } from 'react';
import type { PairPayload } from '../types/pairPayload';
import type { RuntimeCacheSnapshot } from '../../../runtime/runtimeCacheRegistry';

export interface SpreadDistributionState {
    data: RuntimeCacheSnapshot['spreadDistribution'] | null;
    loading: boolean;
    error: string | null;
}

export interface UseSpreadDistributionOptions {
    pollInterval?: number;
}

const DEFAULT_STATE: SpreadDistributionState = {
    data: null,
    loading: true,
    error: null,
};

export function useSpreadDistribution(
    options: UseSpreadDistributionOptions = {},
): SpreadDistributionState {
    const { pollInterval = 10_000 } = options;
    const [state, setState] = useState<SpreadDistributionState>(DEFAULT_STATE);
    const abortRef = useRef<AbortController | null>(null);

    const fetchSpreadDistribution = useCallback(async () => {
        if (abortRef.current) {
            abortRef.current.abort();
        }
        abortRef.current = new AbortController();

        try {
            const res = await fetch('/api/metrics/runtime', { signal: abortRef.current.signal });
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData?.error || `HTTP ${res.status}`);
            }
            const payload = await res.json() as PairPayload<RuntimeCacheSnapshot>;
            setState({
                data: payload.data?.spreadDistribution ?? null,
                loading: false,
                error: null,
            });
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
            const message = err instanceof Error ? err.message : 'Failed to fetch spread distribution';
            setState({
                data: null,
                loading: false,
                error: message,
            });
        }
    }, []);

    useEffect(() => {
        fetchSpreadDistribution();
        const intervalId = setInterval(fetchSpreadDistribution, pollInterval);
        return () => {
            clearInterval(intervalId);
            if (abortRef.current) {
                abortRef.current.abort();
            }
        };
    }, [fetchSpreadDistribution, pollInterval]);

    return state;
}
