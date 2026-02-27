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

interface BotRiskHardRiskMetrics {
    currentExposureNotional?: number;
    inventorySkewPct?: number;
    drawdownPct?: number;
    drawdownConfidence?: boolean;
    tradesCount?: number;
    peakEquity?: number;
    equityNow?: number;
    runtimeReady?: boolean;
    marketDataValid?: boolean;
    balancesFresh?: boolean;
    feedHealthy?: boolean;
}

interface BotRiskHardRiskEvent {
    type: 'RISK_LIMIT_WARNING' | 'RISK_LIMIT_BLOCK' | 'RISK_LIMIT_RECOVERY';
    pairKey: string;
    reasons: string[];
    metrics: BotRiskHardRiskMetrics;
    timestamp: number;
}

interface BotRiskThresholds {
    maxExposureNotional?: number;
    maxInventorySkewPct?: number;
    maxDrawdownPct?: number;
    minTradesForDrawdown?: number;
    minPeakEquityForDrawdown?: number;
    maxBalanceStalenessMs?: number;
    minFeedHealthScore?: number;
    warningThresholdRatio?: number;
}

interface BotRiskExposure {
    netPositionBase?: number;
    notionalExposure?: number;
    inventorySkewPct?: number;
    lastMidPrice?: number;
    fillCount?: number;
    totalBought?: number;
    totalSold?: number;
    lastFillMs?: number;
    pairKey?: string;
}

interface BotRiskResponse {
    killSwitch?: boolean;
    dailyLossLimit?: number;
    dailyLossCurrent?: number;
    maxExposure?: number;
    currentExposure?: number;
    consecutiveFailures?: number;
    maxTradeSize?: number;
    reserveFloorXRP?: number;
    positionSize?: number;
    hardRisk?: {
        pairKey?: string;
        result?: {
            riskState?: 'CLEAR' | 'WARNING' | 'BLOCKED';
            riskBlockReasons?: string[];
            warningReasons?: string[];
            metrics?: BotRiskHardRiskMetrics;
            executionAllowed?: boolean;
            evaluatedAt?: number;
        };
        thresholds?: BotRiskThresholds;
        recentEvents?: BotRiskHardRiskEvent[];
    };
    exposure?: BotRiskExposure;
    source?: 'config' | 'runtime';
}

/** Hard risk event for display in the UI. */
export interface RiskEvent {
    type: 'RISK_LIMIT_WARNING' | 'RISK_LIMIT_BLOCK' | 'RISK_LIMIT_RECOVERY';
    pairKey: string;
    reasons: string[];
    timestamp: number;
}

/** Threshold config for display. */
export interface RiskThresholds {
    maxExposureNotional: number | null;
    maxInventorySkewPct: number | null;
    maxDrawdownPct: number | null;
    minTradesForDrawdown: number | null;
}

/** Exposure snapshot for display. */
export interface RiskExposure {
    netPositionBase: number | null;
    notionalExposure: number | null;
    inventorySkewPct: number | null;
    lastMidPrice: number | null;
    fillCount: number;
    totalBought: number;
    totalSold: number;
    lastFillMs: number | null;
}

export interface RiskStressData {
    // Adverse selection
    adverseRate: number | null;
    sampleCount: number;
    adverseCount: number;
    // Drawdown
    drawdownPct: number | null;
    drawdownVelocity: number | null;
    maxDrawdownPct: number | null;
    // Hard risk state
    hardRiskState: 'CLEAR' | 'WARNING' | 'BLOCKED' | null;
    hardRiskReasons: string[];
    drawdownConfidence: boolean | null;
    hardRiskTradesCount: number | null;
    hardRiskPeakEquity: number | null;
    hardRiskEquityNow: number | null;
    // Kill switch & daily loss (from riskEngine.getStatus)
    killSwitch: boolean;
    dailyLossLimit: number | null;
    dailyLossCurrent: number | null;
    // Exposure
    maxExposure: number | null;
    currentExposure: number | null;
    consecutiveFailures: number;
    // System health booleans (from hardRisk metrics)
    runtimeReady: boolean | null;
    marketDataValid: boolean | null;
    balancesFresh: boolean | null;
    feedHealthy: boolean | null;
    // Thresholds (for context alongside values)
    thresholds: RiskThresholds;
    // Exposure tracker snapshot
    exposure: RiskExposure;
    // Recent risk events timeline
    recentEvents: RiskEvent[];
    // Execution allowed flag
    executionAllowed: boolean | null;
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
    hardRiskState: null,
    hardRiskReasons: [],
    drawdownConfidence: null,
    hardRiskTradesCount: null,
    hardRiskPeakEquity: null,
    hardRiskEquityNow: null,
    killSwitch: false,
    dailyLossLimit: null,
    dailyLossCurrent: null,
    maxExposure: null,
    currentExposure: null,
    consecutiveFailures: 0,
    runtimeReady: null,
    marketDataValid: null,
    balancesFresh: null,
    feedHealthy: null,
    thresholds: {
        maxExposureNotional: null,
        maxInventorySkewPct: null,
        maxDrawdownPct: null,
        minTradesForDrawdown: null,
    },
    exposure: {
        netPositionBase: null,
        notionalExposure: null,
        inventorySkewPct: null,
        lastMidPrice: null,
        fillCount: 0,
        totalBought: 0,
        totalSold: 0,
        lastFillMs: null,
    },
    recentEvents: [],
    executionAllowed: null,
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
            const [adverseRes, analyticsRes, riskRes] = await Promise.all([
                fetch(`/api/analytics/adverse-selection-rate${pairQuery}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                }),
                fetch(`/api/analytics/summary${pairKey ? `?pair=${encodeURIComponent(pairKey)}` : ''}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                }),
                fetch('/api/bot/risk', {
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

            if (riskRes.ok) {
                const risk = await riskRes.json() as BotRiskResponse;
                const hardRisk = risk.hardRisk?.result;
                const metrics = hardRisk?.metrics;

                // Hard risk state
                next.hardRiskState = hardRisk?.riskState ?? null;
                next.hardRiskReasons = hardRisk?.riskBlockReasons
                    ?? hardRisk?.warningReasons
                    ?? [];
                next.drawdownConfidence = typeof metrics?.drawdownConfidence === 'boolean'
                    ? metrics.drawdownConfidence
                    : null;
                next.hardRiskTradesCount = Number.isFinite(metrics?.tradesCount)
                    ? metrics?.tradesCount ?? null
                    : null;
                next.hardRiskPeakEquity = Number.isFinite(metrics?.peakEquity)
                    ? metrics?.peakEquity ?? null
                    : null;
                next.hardRiskEquityNow = Number.isFinite(metrics?.equityNow)
                    ? metrics?.equityNow ?? null
                    : null;
                next.executionAllowed = typeof hardRisk?.executionAllowed === 'boolean'
                    ? hardRisk.executionAllowed
                    : null;

                // Kill switch & daily loss (from riskEngine.getStatus spread into response)
                next.killSwitch = risk.killSwitch === true;
                next.dailyLossLimit = Number.isFinite(risk.dailyLossLimit) ? risk.dailyLossLimit! : null;
                next.dailyLossCurrent = Number.isFinite(risk.dailyLossCurrent) ? risk.dailyLossCurrent! : null;

                // Exposure from riskEngine status
                next.maxExposure = Number.isFinite(risk.maxExposure) ? risk.maxExposure! : null;
                next.currentExposure = Number.isFinite(risk.currentExposure) ? risk.currentExposure! : null;
                next.consecutiveFailures = Number.isFinite(risk.consecutiveFailures) ? risk.consecutiveFailures! : 0;

                // System health booleans
                next.runtimeReady = typeof metrics?.runtimeReady === 'boolean' ? metrics.runtimeReady : null;
                next.marketDataValid = typeof metrics?.marketDataValid === 'boolean' ? metrics.marketDataValid : null;
                next.balancesFresh = typeof metrics?.balancesFresh === 'boolean' ? metrics.balancesFresh : null;
                next.feedHealthy = typeof metrics?.feedHealthy === 'boolean' ? metrics.feedHealthy : null;

                // Thresholds (for context display)
                const thresholds = risk.hardRisk?.thresholds;
                if (thresholds) {
                    next.thresholds = {
                        maxExposureNotional: Number.isFinite(thresholds.maxExposureNotional) ? thresholds.maxExposureNotional! : null,
                        maxInventorySkewPct: Number.isFinite(thresholds.maxInventorySkewPct) ? thresholds.maxInventorySkewPct! : null,
                        maxDrawdownPct: Number.isFinite(thresholds.maxDrawdownPct) ? thresholds.maxDrawdownPct! : null,
                        minTradesForDrawdown: Number.isFinite(thresholds.minTradesForDrawdown) ? thresholds.minTradesForDrawdown! : null,
                    };
                }

                // Exposure tracker snapshot
                const exp = risk.exposure;
                if (exp) {
                    next.exposure = {
                        netPositionBase: Number.isFinite(exp.netPositionBase) ? exp.netPositionBase! : null,
                        notionalExposure: Number.isFinite(exp.notionalExposure) ? exp.notionalExposure! : null,
                        inventorySkewPct: Number.isFinite(exp.inventorySkewPct) ? exp.inventorySkewPct! : null,
                        lastMidPrice: Number.isFinite(exp.lastMidPrice) ? exp.lastMidPrice! : null,
                        fillCount: Number.isFinite(exp.fillCount) ? exp.fillCount! : 0,
                        totalBought: Number.isFinite(exp.totalBought) ? exp.totalBought! : 0,
                        totalSold: Number.isFinite(exp.totalSold) ? exp.totalSold! : 0,
                        lastFillMs: Number.isFinite(exp.lastFillMs) ? exp.lastFillMs! : null,
                    };
                }

                // Recent events timeline
                const events = risk.hardRisk?.recentEvents;
                if (Array.isArray(events)) {
                    next.recentEvents = events.slice(0, 20).map((e) => ({
                        type: e.type,
                        pairKey: e.pairKey ?? '',
                        reasons: Array.isArray(e.reasons) ? e.reasons : [],
                        timestamp: e.timestamp ?? 0,
                    }));
                }
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
