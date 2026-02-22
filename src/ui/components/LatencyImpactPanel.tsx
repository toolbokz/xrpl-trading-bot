'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Activity, Clock3, Gauge, TrendingUp } from 'lucide-react';
import { deriveLatencyImpactViewModel, type LatencyImpactConfigModel, type LatencyImpactSummary } from './latencyImpactViewModel';

interface ExecutionQualityResponse {
    summary: LatencyImpactSummary;
}

interface LatencyImpactConfigResponse {
    config: LatencyImpactConfigModel & {
        quantiles: number;
        defaultField: string;
    };
}

export interface LatencyImpactPanelProps {
    pairKey?: string;
    enabled?: boolean;
    pollInterval?: number;
}

function fmt(value: number | null | undefined, digits = 2): string {
    if (value == null || !Number.isFinite(value)) return 'N/A';
    return value.toFixed(digits);
}

function fmtPct(value: number | null | undefined, digits = 1): string {
    if (value == null || !Number.isFinite(value)) return 'N/A';
    return `${value.toFixed(digits)}%`;
}

function fmtThresholdValue(value: number | null, unit: '%' | 'bps' | 'ms'): string {
    if (value == null || !Number.isFinite(value)) return 'N/A';
    if (unit === '%') return `${(value * 100).toFixed(2)}%`;
    if (unit === 'ms') return `${value.toFixed(0)}ms`;
    return `${value.toFixed(3)} bps`;
}

export function LatencyImpactPanel({
    pairKey,
    enabled = true,
    pollInterval = 15_000,
}: LatencyImpactPanelProps) {
    const [summary, setSummary] = useState<LatencyImpactSummary | null>(null);
    const [config, setConfig] = useState<LatencyImpactConfigResponse['config'] | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        try {
            const eqParams = new URLSearchParams();
            if (pairKey) eqParams.set('pairKey', pairKey);
            eqParams.set('sinceMs', String(Date.now() - (6 * 60 * 60 * 1000)));

            const [eqRes, cfgRes] = await Promise.all([
                fetch(`/api/analytics/execution-quality?${eqParams.toString()}`),
                fetch('/api/analytics/latency-impact-config'),
            ]);
            if (!eqRes.ok) throw new Error(`Execution quality HTTP ${eqRes.status}`);
            if (!cfgRes.ok) throw new Error(`Latency config HTTP ${cfgRes.status}`);

            const eqJson = await eqRes.json() as ExecutionQualityResponse;
            const cfgJson = await cfgRes.json() as LatencyImpactConfigResponse;
            setSummary(eqJson.summary ?? null);
            setConfig(cfgJson.config ?? null);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch latency impact data');
        } finally {
            setLoading(false);
        }
    }, [pairKey]);

    useEffect(() => {
        if (!enabled) return () => undefined;
        let cancelled = false;
        const run = async () => {
            if (cancelled) return;
            await fetchData();
        };
        void run();
        const id = setInterval(() => { void run(); }, pollInterval);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [enabled, fetchData, pollInterval]);

    const model = useMemo(
        () => deriveLatencyImpactViewModel(summary, config),
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
                <span className="text-[11px] text-slate-500">
                    {loading ? 'Loading...' : config ? `${config.defaultField} / q${config.quantiles}` : 'No config'}
                </span>
            </div>

            {error && (
                <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-2 gap-2">
                <Stat label="Decision->Submit" value={`${fmt(summary?.avgDecisionToSubmitMs, 0)} ms`} icon={Clock3} />
                <Stat label="Submit->Validate" value={`${fmt(summary?.avgSubmitToValidatedMs, 0)} ms`} icon={Clock3} />
                <Stat label="Decision->Fill" value={`${fmt(summary?.avgDecisionToValidatedMs, 0)} ms`} icon={Activity} />
                <Stat label="Latency Budget" value={fmtPct(model.latencyBudgetUsedPct, 1)} icon={Gauge} />
                <Stat label="Avg Fill Ratio" value={summary?.avgFillRatio != null ? fmtPct(summary.avgFillRatio * 100, 1) : 'N/A'} icon={TrendingUp} />
                <Stat label="Reject / Partial" value={`${fmtPct(model.rejectRate * 100, 1)} / ${fmtPct(model.partialRate * 100, 1)}`} icon={Activity} />
            </div>

            <div className="space-y-1 rounded border border-white/10 bg-white/[0.02] px-2 py-2 text-[11px]">
                <Line label="Avg slippage vs intent" value={`${fmt(summary?.avgSlippageBpsVsIntent, 2)} bps`} />
                <Line label="Realized spread (1m / 5m)" value={`${fmt(summary?.avgRealizedSpreadBps1m, 2)} / ${fmt(summary?.avgRealizedSpreadBps5m, 2)} bps`} />
                <Line label="Impact (1m / 5m)" value={`${fmt(summary?.avgImpactBps1m, 2)} / ${fmt(summary?.avgImpactBps5m, 2)} bps`} />
                <Line label="Missing fill snapshot rate" value={fmtPct((summary?.missingFillSnapshotRate ?? 0) * 100, 2)} />
                <Line label="Missing ack / markout rate" value={`${fmtPct((summary?.missingAckRate ?? 0) * 100, 2)} / ${fmtPct((summary?.missingMarkoutRate ?? 0) * 100, 2)}`} />
                <Line label="TS monotonic / neg-age rate" value={`${fmtPct((summary?.tsMonotonicityViolationRate ?? 0) * 100, 3)} / ${fmtPct((summary?.negRateAgeDelta ?? 0) * 100, 2)}`} />
                <Line label="Weekly drift (P50 / P90)" value={`${fmt(summary?.weeklyP50DriftBps, 3)} / ${fmt(summary?.weeklyP90DriftBps, 3)} bps`} />
                <Line label="Net profitability proxy" value={`${fmt(model.profitabilityScore, 2)} bps`} />
                <Line
                    label="Config thresholds"
                    value={config ? `fresh ${config.decisionFreshnessMs}ms | drift ${config.weeklyP50DriftLimitBps} bps | slip ${config.slippageImprovementBps} bps` : 'N/A'}
                />
            </div>

            <div className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
                <div className="border-b border-white/10 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">
                    Per-Threshold Policy Checks
                </div>
                <div className="max-h-[180px] overflow-auto">
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
                            {model.thresholdChecks.map((check) => {
                                const statusTone = check.status === 'FAIL'
                                    ? 'text-red-300'
                                    : check.status === 'WARN'
                                        ? 'text-amber-300'
                                        : 'text-emerald-300';
                                return (
                                    <tr key={check.key} className="border-b border-white/5 text-slate-300">
                                        <td className="px-2 py-1">{check.label}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmtThresholdValue(check.actual, check.unit)}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmtThresholdValue(check.limit, check.unit)}</td>
                                        <td className={clsx('px-2 py-1 text-right font-semibold', statusTone)}>{check.status}</td>
                                    </tr>
                                );
                            })}
                            {model.thresholdChecks.length === 0 && (
                                <tr>
                                    <td className="px-2 py-2 text-slate-500" colSpan={4}>No threshold data</td>
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

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Clock3 }) {
    return (
        <div className="rounded border border-white/10 bg-white/[0.02] px-2 py-1.5">
            <div className="mb-0.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
                <span>{label}</span>
                <Icon size={10} />
            </div>
            <div className="font-mono text-[12px] text-slate-200">{value}</div>
        </div>
    );
}

function Line({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between border-b border-white/5 pb-1 last:border-b-0 last:pb-0">
            <span className="text-slate-500">{label}</span>
            <span className="font-mono text-slate-200">{value}</span>
        </div>
    );
}
