'use client';

import { useMemo } from 'react';
import type { RuntimeCacheLightSnapshot } from './useRuntimeCache';
import { useRuntimeCache } from './useRuntimeCache';

export type SpreadDistributionSnapshot = RuntimeCacheLightSnapshot['spreadDistribution'];

export interface SpreadBucket {
    sampleCount: number;
    medianBps: number | null;
    p75Bps: number | null;
    p90Bps: number | null;
}

export interface BaselineSpreadBucket extends SpreadBucket {
    days: number;
}

export interface SpreadModel {
    currentSpreadBps: number | null;
    lookback24h: SpreadBucket | null;
    baselineMultiDay: BaselineSpreadBucket | null;
    updatedAtMs: number | null;
}

export function useSpreadModel(): {
    data: SpreadModel;
    loading: boolean;
    error: string | null;
} {
    const runtimeCache = useRuntimeCache();

    const data = useMemo<SpreadModel>(() => {
        const snapshot = runtimeCache.data?.snapshot ?? null;
        const distribution = snapshot?.spreadDistribution ?? null;

        return {
            currentSpreadBps: snapshot?.orderbookSpreadBps ?? null,
            lookback24h: distribution?.lookback24h ?? null,
            baselineMultiDay: distribution?.baselineMultiDay ?? null,
            updatedAtMs: distribution?.updatedAtMs ?? null,
        };
    }, [runtimeCache.data?.snapshot]);

    return {
        data,
        loading: runtimeCache.loading,
        error: runtimeCache.error,
    };
}
