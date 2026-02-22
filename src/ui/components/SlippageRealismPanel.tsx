'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { deriveSlippageRealismViewModel, type SlippageRealismConfigModel, type SlippageRealismSummary } from './slippageRealismViewModel';

interface ExecutionQualityResponse {
    summary: SlippageRealismSummary;
}

interface SlippageRealismConfigResponse {
    config: SlippageRealismConfigModel;
}

export interface SlippageRealismPanelProps {
    pairKey?: string;
    enabled?: boolean;
    pollInterval?: number;
}

function fmtThresholdValue(value: number | null, unit: '%' | 'bps' | 'ms'): string {
    if (value == null || !Number.isFinite(value)) return 'N/A';
    if (unit === '%') return `${(value * 100).toFixed(2)}%`;
    if (unit === 'ms') return `${value.toFixed(0)}ms`;
    return `${value.toFixed(2)} bps`;
}

export function SlippageRealismPanel({
    pairKey,
    enabled = true,
    pollInterval = 20_000,
}: SlippageRealismPanelProps) {
    const [summary, setSummary] = useState<SlippageRealismSummary | null>(null);
    const [config, setConfig] = useState<SlippageRealismConfigModel | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (pairKey) params.set('pairKey', pairKey);
            params.set('sinceMs', String(Date.now() - (24 * 60 * 60 * 1000)));

            const [summaryRes, configRes] = await Promise.all([
                fetch(`/api/analytics/execution-quality?${params.toString()}`),
                fetch('/api/analytics/slippage-realism-config'),
            ]);
            if (!summaryRes.ok) throw new Error(`Execution quality HTTP ${summaryRes.status}`);
            if (!configRes.ok) throw new Error(`Slippage config HTTP ${configRes.status}`);

            const summaryJson = await summaryRes.json() as ExecutionQualityResponse;
            const configJson = await configRes.json() as SlippageRealismConfigResponse;
            setSummary(summaryJson.summary ?? null);
            setConfig(configJson.config ?? null);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch slippage realism data');
        } finally {
            setLoading(false);
        }
    }, [pairKey]);

    useEffect(() => {
        if (!enabled) return () => undefined;
        void fetchData();
        const id = setInterval(() => { void fetchData(); }, pollInterval);
        return () => clearInterval(id);
    }, [enabled, fetchData, pollInterval]);

    const model = useMemo(
        () => deriveSlippageRealismViewModel(summary, config),
        [summary, config],
    );

    const verdictTone = model.verdict === 'GOOD'
        ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
        : model.verdict === 'WARN'
            ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
            : model.verdict === 'DEGRADED'
                ? 'text-red-300 border-red-500/30 bg-red-500/10'
                : 'text-slate-300 border-white/10 bg-white/[0.03]';

    return (
        <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
                <span className={clsx('rounded border px-2 py-1 text-xs font-semibold tracking-wide', verdictTone)}>
                    {model.verdict}
                </span>
                <span className="text-[11px] text-slate-500">{loading ? 'Loading...' : '24h window'}</span>
            </div>

            {error && (
                <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                    {error}
                </div>
            )}

            <div className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
                <div className="border-b border-white/10 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">
                    Slippage Realism Threshold Checks
                </div>
                <div className="max-h-[220px] overflow-auto">
                    <table className="w-full text-[11px]">
                        <thead className="text-slate-500">
                            <tr className="border-b border-white/5">
                                <th className="px-2 py-1 text-left">Check</th>
                                <th className="px-2 py-1 text-right">Actual</th>
                                <th className="px-2 py-1 text-right">Limit</th>
                                <th className="px-2 py-1 text-right">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {model.checks.map((check) => {
                                const tone = check.status === 'FAIL'
                                    ? 'text-red-300'
                                    : check.status === 'WARN'
                                        ? 'text-amber-300'
                                        : check.status === 'PASS'
                                            ? 'text-emerald-300'
                                            : 'text-slate-400';
                                return (
                                    <tr key={check.key} className="border-b border-white/5 text-slate-300">
                                        <td className="px-2 py-1">{check.label}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmtThresholdValue(check.actual, check.unit)}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmtThresholdValue(check.limit, check.unit)}</td>
                                        <td className={clsx('px-2 py-1 text-right font-semibold', tone)}>{check.status}</td>
                                    </tr>
                                );
                            })}
                            {model.checks.length === 0 && (
                                <tr>
                                    <td className="px-2 py-2 text-slate-500" colSpan={4}>No checks available</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] text-slate-300">
                {model.reasons[0]}
                {model.reasons[1] ? ` | ${model.reasons[1]}` : ''}
            </div>
        </div>
    );
}
