'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface AdverseSelectionResponse {
    adverseRate?: number;
    sampleCount?: number;
    adverseCount?: number;
}

interface AnalyticsSummaryResponse {
    summary?: { maxDrawdown?: number };
    drawdown?: Array<{ drawdown: number }>;
    drawdownVelocity?: number;
}

export interface RiskStressData {
    adverseRate: number | null;
    sampleCount: number;
    adverseCount: number;
    drawdownPct: number | null;
    drawdownVelocity: number | null;
    maxDrawdownPct: number | null;
}

export interface UseRiskStressState {
    data: RiskStressData;
    loading: boolean;
    error: string | null;
}

export interface UseRiskStressOptions {
    pollInterval?: number;
    enabled?: boolean;
    pairKey?: string | null;
}

const EMPTY_DATA: RiskStressData = {
    adverseRate: null,
    sampleCount: 0,
    adverseCount: 0,
    drawdownPct: null,
    drawdownVelocity: null,
    maxDrawdownPct: null,
};

export function useRiskStress({
    pollInterval = 10_000,
    enabled = true,
    pairKey,
}: UseRiskStressOptions = {}): UseRiskStressState {
    const [data, setData] = useState<RiskStressData>(EMPTY_DATA);
    const [loading, setLoading] = useState<boolean>(enabled);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    const fetchRiskStress = useCallback(async () => {
        if (!enabled) {
            setLoading(false);
            return;
        }

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const pairQuery = pairKey ? `?pairKey=${encodeURIComponent(pairKey)}` : '';
            const [adverseRes, analyticsRes] = await Promise.all([
                fetch(`/api/analytics/adverse-selection-rate${pairQuery}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                }),
                fetch(`/api/analytics/summary${pairKey ? `?pair=${encodeURIComponent(pairKey)}` : ''}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                }),
            ]);

            const next: RiskStressData = { ...EMPTY_DATA };

            if (adverseRes.ok) {
                const adverse = await adverseRes.json() as AdverseSelectionResponse;
                next.adverseRate = Number.isFinite(adverse.adverseRate) ? adverse.adverseRate ?? null : null;
                next.sampleCount = Number.isFinite(adverse.sampleCount) ? adverse.sampleCount ?? 0 : 0;
                next.adverseCount = Number.isFinite(adverse.adverseCount) ? adverse.adverseCount ?? 0 : 0;
            }

            if (analyticsRes.ok) {
                const analytics = await analyticsRes.json() as AnalyticsSummaryResponse;
                const latestDrawdown = analytics.drawdown?.[analytics.drawdown.length - 1]?.drawdown;
                next.drawdownPct = Number.isFinite(latestDrawdown)
                    ? Math.abs(latestDrawdown ?? 0) * 100
                    : (Number.isFinite(analytics.summary?.maxDrawdown) ? Math.abs(analytics.summary?.maxDrawdown ?? 0) * 100 : null);
                next.maxDrawdownPct = Number.isFinite(analytics.summary?.maxDrawdown)
                    ? Math.abs(analytics.summary?.maxDrawdown ?? 0) * 100
                    : null;
                next.drawdownVelocity = Number.isFinite(analytics.drawdownVelocity)
                    ? analytics.drawdownVelocity ?? null
                    : null;
            }

            setData(next);
            setError(null);
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            setError(err instanceof Error ? err.message : 'Failed to fetch risk stress data');
        } finally {
            setLoading(false);
        }
    }, [enabled, pairKey]);

    useEffect(() => {
        void fetchRiskStress();
        if (!enabled) return () => undefined;

        const interval = setInterval(() => {
            void fetchRiskStress();
        }, Math.max(2000, pollInterval));

        return () => {
            clearInterval(interval);
            abortRef.current?.abort();
        };
    }, [fetchRiskStress, pollInterval, enabled]);

    return useMemo(() => ({ data, loading, error }), [data, loading, error]);
}
