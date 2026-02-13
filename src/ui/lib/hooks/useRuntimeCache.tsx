'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';

export interface RuntimeCacheLightSnapshot {
    pairKey: string;
    asOfMs: number;
    sequence: number;
    runtimeState: string | null;
    executionAllowed: boolean;
    background: unknown | null;
    orderbookMidPrice: number | null;
    orderbookSpreadBps: number | null;
    spreadDistribution: {
        updatedAtMs: number;
        lookback24h: {
            sampleCount: number;
            medianBps: number | null;
            p75Bps: number | null;
            p90Bps: number | null;
        };
        baselineMultiDay: {
            days: number;
            sampleCount: number;
            medianBps: number | null;
            p75Bps: number | null;
            p90Bps: number | null;
        };
    } | null;
}

export interface RuntimeCacheResponse {
    ok: boolean;
    snapshot: RuntimeCacheLightSnapshot | null;
}

export interface UseRuntimeCacheOptions {
    pollInterval?: number;
    enabled?: boolean;
}

export interface UseRuntimeCacheState {
    data: RuntimeCacheResponse | null;
    loading: boolean;
    error: string | null;
}

const RuntimeCacheContext = createContext<UseRuntimeCacheState | null>(null);

export function useRuntimeCache(options: UseRuntimeCacheOptions = {}): UseRuntimeCacheState {
    const ctx = useContext(RuntimeCacheContext);
    const local = useRuntimeCachePolling({
        ...options,
        enabled: (options.enabled ?? true) && !ctx,
    });
    return ctx ?? local;
}

export function RuntimeCacheProvider({
    children,
    pollInterval = 4000,
    enabled = true,
}: {
    children: ReactNode;
    pollInterval?: number;
    enabled?: boolean;
}) {
    const state = useRuntimeCachePolling({ pollInterval, enabled });
    return <RuntimeCacheContext.Provider value={state}>{children}</RuntimeCacheContext.Provider>;
}

function useRuntimeCachePolling({
    pollInterval = 4000,
    enabled = true,
}: UseRuntimeCacheOptions): UseRuntimeCacheState {
    const [data, setData] = useState<RuntimeCacheResponse | null>(null);
    const [loading, setLoading] = useState<boolean>(enabled);
    const [error, setError] = useState<string | null>(null);

    const abortRef = useRef<AbortController | null>(null);

    const fetchCache = useCallback(async () => {
        if (!enabled) {
            setLoading(false);
            return;
        }

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await fetch('/api/bot/cache', {
                method: 'GET',
                signal: controller.signal,
                cache: 'no-store',
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json() as RuntimeCacheResponse;
            setData(payload);
            setError(null);
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            setError(err instanceof Error ? err.message : 'Failed to fetch runtime cache');
        } finally {
            setLoading(false);
        }
    }, [enabled]);

    useEffect(() => {
        void fetchCache();
        if (!enabled) return () => undefined;

        const interval = setInterval(() => {
            void fetchCache();
        }, Math.max(1500, pollInterval));

        return () => {
            clearInterval(interval);
            abortRef.current?.abort();
        };
    }, [fetchCache, pollInterval, enabled]);

    return useMemo(() => ({ data, loading, error }), [data, loading, error]);
}
