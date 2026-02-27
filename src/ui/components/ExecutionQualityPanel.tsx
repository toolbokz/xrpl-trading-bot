'use client';

import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, Clock3, SlidersHorizontal } from 'lucide-react';
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    BarChart,
    Bar,
} from 'recharts';
import clsx from 'clsx';
import { Panel } from './Panel';

type ExecutionSide = 'buy' | 'sell';
type ExecutionSource = 'bot' | 'manual' | 'unknown';

interface ExecutionQualitySummary {
    events: number;
    fills: number;
    rejects: number;
    partials: number;
    coverage1m: number;
    coverage5m: number;
    avgSlippageBpsVsIntent: number | null;
    avgSlippageBpsVsMid: number | null;
    avgSlippageBpsVsBbo: number | null;
    avgEffSpreadBps: number | null;
    avgRealizedSpreadBps1m: number | null;
    avgRealizedSpreadBps5m: number | null;
    avgImpactBps1m: number | null;
    avgImpactBps5m: number | null;
    avgFillRatio: number | null;
    avgDecisionToSubmitMs: number | null;
    avgSubmitToValidatedMs: number | null;
    avgDecisionToValidatedMs: number | null;
    missingFillSnapshotRate: number;
    missingAckRate: number;
    missingMarkoutRate: number;
    repriceAppliedRate: number;
    negSlippageRate: number;
    staleFillSnapshotRate: number;
    tooGoodRate: number;
    tooBadRate: number;
}

interface ExecutionQualityBucket {
    ts: number;
    count: number;
    avgSlippageBpsVsIntent: number | null;
    avgEffSpreadBps: number | null;
    avgRealizedSpreadBps1m: number | null;
    avgRealizedSpreadBps5m: number | null;
    avgImpactBps1m: number | null;
    avgImpactBps5m: number | null;
    avgFillRatio: number | null;
    avgDecisionToValidatedMs: number | null;
}

interface ExecutionQualityHistogramBin {
    min: number;
    max: number;
    count: number;
}

interface ExecutionQualityBreakdownRow {
    key: string;
    count: number;
    avgSlippageBpsVsIntent: number | null;
    avgEffSpreadBps: number | null;
    avgFillRatio: number | null;
}

interface ExecutionQualityAnomalies {
    suspiciousSlippageSpikes: number;
    partialFillAnomalies: number;
    quoteBaseIntegrityViolations: number;
}

interface ExecutionQualityApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        sinceMs: number | null;
        strategy: string | null;
        side: ExecutionSide | null;
        source: ExecutionSource | null;
        bucketMs: number;
    };
    summary: ExecutionQualitySummary;
    series: ExecutionQualityBucket[];
    histograms: {
        slippageBps: ExecutionQualityHistogramBin[];
        spreadBps: ExecutionQualityHistogramBin[];
        postTradeDriftBps: ExecutionQualityHistogramBin[];
    };
    breakdowns: {
        byPair: ExecutionQualityBreakdownRow[];
        byStrategy: ExecutionQualityBreakdownRow[];
        bySide: ExecutionQualityBreakdownRow[];
        byRegime: ExecutionQualityBreakdownRow[];
    };
    anomalies: ExecutionQualityAnomalies;
}

export interface ExecutionQualityPanelProps {
    pairKey?: string;
    strategy?: string;
    pollInterval?: number;
    enabled?: boolean;
}

const sinceOptions = [
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

const bucketOptions = [
    { label: '1m', ms: 60 * 1000 },
    { label: '5m', ms: 5 * 60 * 1000 },
    { label: '15m', ms: 15 * 60 * 1000 },
];

function fmt(value: number | null | undefined, digits: number = 2): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toFixed(digits);
}

function fmtPct(value: number | null | undefined, digits: number = 1): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(digits)}%`;
}

function Histogram({
    title,
    data,
}: {
    title: string;
    data: ExecutionQualityHistogramBin[];
}) {
    const chartData = useMemo(
        () =>
            data.map((bin, idx) => ({
                id: idx,
                label: `${bin.min}..${bin.max}`,
                count: bin.count,
            })),
        [data]
    );

    return (
        <div className="min-h-[160px] rounded border border-white/10 bg-white/[0.02] p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">{title}</div>
            <div className="h-[130px]">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                        <XAxis dataKey="id" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                        <Tooltip
                            contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }}
                            formatter={(value: number) => [value, 'count']}
                            labelFormatter={(idx) => chartData[Number(idx)]?.label ?? ''}
                        />
                        <Bar dataKey="count" fill="#38bdf8" radius={[2, 2, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

function BreakdownTable({
    title,
    rows,
}: {
    title: string;
    rows: ExecutionQualityBreakdownRow[];
}) {
    return (
        <div className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
            <div className="border-b border-white/10 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">{title}</div>
            <div className="max-h-[180px] overflow-auto">
                <table className="w-full text-[11px]">
                    <thead className="text-slate-500">
                        <tr className="border-b border-white/5">
                            <th className="px-2 py-1 text-left">Key</th>
                            <th className="px-2 py-1 text-right">Count</th>
                            <th className="px-2 py-1 text-right">Slip</th>
                            <th className="px-2 py-1 text-right">Spread</th>
                            <th className="px-2 py-1 text-right">Fill</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, 8).map((row) => (
                            <tr key={row.key} className="border-b border-white/5 text-slate-300">
                                <td className="px-2 py-1">{row.key}</td>
                                <td className="px-2 py-1 text-right">{row.count}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.avgSlippageBpsVsIntent, 1)}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.avgEffSpreadBps, 1)}</td>
                                <td className="px-2 py-1 text-right">{fmtPct(row.avgFillRatio, 1)}</td>
                            </tr>
                        ))}
                        {rows.length === 0 && (
                            <tr>
                                <td className="px-2 py-2 text-slate-500" colSpan={5}>No data</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export function ExecutionQualityPanel({
    pairKey,
    strategy,
    pollInterval = 15_000,
    enabled = true,
}: ExecutionQualityPanelProps) {
    const [data, setData] = useState<ExecutionQualityApiResponse | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    const [sinceWindowMs, setSinceWindowMs] = useState<number>(sinceOptions[1]!.ms);
    const [bucketMs, setBucketMs] = useState<number>(bucketOptions[0]!.ms);
    const [side, setSide] = useState<ExecutionSide | ''>('');
    const [source, setSource] = useState<ExecutionSource | ''>('');
    const [strategyFilter, setStrategyFilter] = useState<string>(strategy ?? '');

    useEffect(() => {
        setStrategyFilter(strategy ?? '');
    }, [strategy]);

    const fetchData = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (pairKey) params.set('pairKey', pairKey);
            if (sinceWindowMs > 0) params.set('sinceMs', String(Date.now() - sinceWindowMs));
            if (bucketMs > 0) params.set('bucketMs', String(bucketMs));
            if (strategyFilter.trim()) params.set('strategy', strategyFilter.trim());
            if (side) params.set('side', side);
            if (source) params.set('source', source);

            const res = await fetch(`/api/analytics/execution-quality?${params.toString()}`);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const json = await res.json() as ExecutionQualityApiResponse;
            setData(json);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch execution quality');
        } finally {
            setLoading(false);
        }
    }, [pairKey, sinceWindowMs, bucketMs, strategyFilter, side, source]);

    useEffect(() => {
        if (!enabled) return () => undefined;
        fetchData();
        const interval = setInterval(fetchData, pollInterval);
        return () => clearInterval(interval);
    }, [fetchData, pollInterval, enabled]);

    const series = useMemo(
        () =>
            (data?.series ?? []).map((point) => ({
                ...point,
                t: new Date(point.ts).toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' }),
                fillRatioPct: point.avgFillRatio == null ? null : point.avgFillRatio * 100,
            })),
        [data?.series]
    );

    const summary = data?.summary;

    return (
        <Panel
            title="Execution Quality"
            icon={BarChart3}
            compact
            fillHeight
            subtitle={
                <span>
                    Slippage: positive = worse execution. Prices are quote/base.
                </span>
            }
        >
            <div className="space-y-3 text-xs">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                    <label className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.02] px-2 py-1">
                        <Clock3 size={12} className="text-slate-500" />
                        <span className="text-slate-400">Window</span>
                        <select
                            className="ml-auto bg-transparent text-slate-200 outline-none"
                            value={sinceWindowMs}
                            onChange={(e) => setSinceWindowMs(Number(e.target.value))}
                        >
                            {sinceOptions.map((opt) => (
                                <option key={opt.ms} value={opt.ms} className="bg-slate-900">
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.02] px-2 py-1">
                        <SlidersHorizontal size={12} className="text-slate-500" />
                        <span className="text-slate-400">Bucket</span>
                        <select
                            className="ml-auto bg-transparent text-slate-200 outline-none"
                            value={bucketMs}
                            onChange={(e) => setBucketMs(Number(e.target.value))}
                        >
                            {bucketOptions.map((opt) => (
                                <option key={opt.ms} value={opt.ms} className="bg-slate-900">
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.02] px-2 py-1">
                        <span className="text-slate-400">Side</span>
                        <select
                            className="ml-auto bg-transparent text-slate-200 outline-none"
                            value={side}
                            onChange={(e) => setSide((e.target.value as ExecutionSide | '') ?? '')}
                        >
                            <option value="" className="bg-slate-900">all</option>
                            <option value="buy" className="bg-slate-900">buy</option>
                            <option value="sell" className="bg-slate-900">sell</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.02] px-2 py-1">
                        <span className="text-slate-400">Source</span>
                        <select
                            className="ml-auto bg-transparent text-slate-200 outline-none"
                            value={source}
                            onChange={(e) => setSource((e.target.value as ExecutionSource | '') ?? '')}
                        >
                            <option value="" className="bg-slate-900">all</option>
                            <option value="bot" className="bg-slate-900">bot</option>
                            <option value="manual" className="bg-slate-900">manual</option>
                            <option value="unknown" className="bg-slate-900">unknown</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.02] px-2 py-1 sm:col-span-2">
                        <span className="text-slate-400">Strategy</span>
                        <input
                            className="ml-2 flex-1 bg-transparent text-slate-200 outline-none"
                            value={strategyFilter}
                            onChange={(e) => setStrategyFilter(e.target.value)}
                            placeholder="all"
                        />
                    </label>
                </div>

                {loading && !data && (
                    <div className="flex items-center gap-2 text-slate-400">
                        <Activity size={12} className="animate-pulse" />
                        <span>Loading execution quality…</span>
                    </div>
                )}

                {error && (
                    <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">
                        <AlertTriangle size={12} />
                        <span>{error}</span>
                    </div>
                )}

                {data && summary && (
                    <>
                        {/* Primary metrics row */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                            <MetricCard label="Events" value={String(summary.events)} />
                            <MetricCard label="Fills / Rejects" value={`${summary.fills} / ${summary.rejects}`} />
                            <MetricCard label="Partials" value={String(summary.partials)} />
                            <MetricCard label="Avg Slip (Intent)" value={`${fmt(summary.avgSlippageBpsVsIntent, 1)} bps`} tone={summary.avgSlippageBpsVsIntent} />
                            <MetricCard label="Eff Spread" value={`${fmt(summary.avgEffSpreadBps, 1)} bps`} tone={summary.avgEffSpreadBps} />
                            <MetricCard label="Fill Ratio" value={fmtPct(summary.avgFillRatio)} />
                        </div>

                        {/* Slippage benchmarks row */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                            <MetricCard label="Slip vs Mid" value={`${fmt(summary.avgSlippageBpsVsMid, 1)} bps`} tone={summary.avgSlippageBpsVsMid} />
                            <MetricCard label="Slip vs BBO" value={`${fmt(summary.avgSlippageBpsVsBbo, 1)} bps`} tone={summary.avgSlippageBpsVsBbo} />
                            <MetricCard label="Realized 1m" value={`${fmt(summary.avgRealizedSpreadBps1m, 1)} bps`} tone={summary.avgRealizedSpreadBps1m} />
                            <MetricCard label="Realized 5m" value={`${fmt(summary.avgRealizedSpreadBps5m, 1)} bps`} tone={summary.avgRealizedSpreadBps5m} />
                            <MetricCard label="Impact 1m" value={`${fmt(summary.avgImpactBps1m, 1)} bps`} tone={summary.avgImpactBps1m} />
                            <MetricCard label="Impact 5m" value={`${fmt(summary.avgImpactBps5m, 1)} bps`} tone={summary.avgImpactBps5m} />
                        </div>

                        {/* Latency + Coverage + Data Quality row */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                            <MetricCard label="Decision→Submit" value={`${fmt(summary.avgDecisionToSubmitMs, 0)} ms`} />
                            <MetricCard label="Submit→Validated" value={`${fmt(summary.avgSubmitToValidatedMs, 0)} ms`} />
                            <MetricCard label="Decision→Validated" value={`${fmt(summary.avgDecisionToValidatedMs, 0)} ms`} />
                            <MetricCard label="Coverage 1m / 5m" value={`${fmtPct(summary.coverage1m)} / ${fmtPct(summary.coverage5m)}`} />
                            <MetricCard label="Reprice Applied" value={fmtPct(summary.repriceAppliedRate)} />
                            <MetricCard label="Neg Slippage" value={fmtPct(summary.negSlippageRate)} />
                        </div>

                        {/* Data quality indicators */}
                        <div className="flex flex-wrap gap-2">
                            <QualityBadge label="Missing Fill Snap" rate={summary.missingFillSnapshotRate} />
                            <QualityBadge label="Missing Ack" rate={summary.missingAckRate} />
                            <QualityBadge label="Missing Markout" rate={summary.missingMarkoutRate} />
                            <QualityBadge label="Stale Fill Snap" rate={summary.staleFillSnapshotRate} />
                            <QualityBadge label="Too Good" rate={summary.tooGoodRate} />
                            <QualityBadge label="Too Bad" rate={summary.tooBadRate} />
                        </div>

                        <div className="grid gap-3 xl:grid-cols-2">
                            <ChartCard title="Slippage / Spread / Realized 1m / Realized 5m">
                                <ResponsiveContainer width="100%" height={210}>
                                    <LineChart data={series}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                                        <Line type="monotone" dataKey="avgSlippageBpsVsIntent" name="Slippage" stroke="#f97316" dot={false} strokeWidth={1.8} />
                                        <Line type="monotone" dataKey="avgEffSpreadBps" name="Eff Spread" stroke="#22d3ee" dot={false} strokeWidth={1.8} />
                                        <Line type="monotone" dataKey="avgRealizedSpreadBps1m" name="Realized 1m" stroke="#a78bfa" dot={false} strokeWidth={1.8} />
                                        <Line type="monotone" dataKey="avgRealizedSpreadBps5m" name="Realized 5m" stroke="#c084fc" dot={false} strokeWidth={1.2} strokeDasharray="4 2" />
                                    </LineChart>
                                </ResponsiveContainer>
                            </ChartCard>

                            <ChartCard title="Impact 1m / 5m / Fill Ratio / Decision→Validated">
                                <ResponsiveContainer width="100%" height={210}>
                                    <LineChart data={series}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <YAxis yAxisId="bps" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                                        <Line yAxisId="bps" type="monotone" dataKey="avgImpactBps1m" name="Impact 1m" stroke="#fb923c" dot={false} strokeWidth={1.8} />
                                        <Line yAxisId="bps" type="monotone" dataKey="avgImpactBps5m" name="Impact 5m" stroke="#fdba74" dot={false} strokeWidth={1.2} strokeDasharray="4 2" />
                                        <Line yAxisId="pct" type="monotone" dataKey="fillRatioPct" name="Fill %" stroke="#34d399" dot={false} strokeWidth={1.8} />
                                        <Line yAxisId="bps" type="monotone" dataKey="avgDecisionToValidatedMs" name="Latency ms" stroke="#60a5fa" dot={false} strokeWidth={1.2} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </ChartCard>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-3">
                            <Histogram title="Slippage Histogram (bps)" data={data.histograms.slippageBps} />
                            <Histogram title="Effective Spread Histogram (bps)" data={data.histograms.spreadBps} />
                            <Histogram title="Post-Trade Drift Histogram (bps)" data={data.histograms.postTradeDriftBps} />
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                            <BreakdownTable title="By Pair" rows={data.breakdowns.byPair} />
                            <BreakdownTable title="By Strategy" rows={data.breakdowns.byStrategy} />
                            <BreakdownTable title="By Side" rows={data.breakdowns.bySide} />
                            <BreakdownTable title="By Regime" rows={data.breakdowns.byRegime} />
                        </div>

                        <div className="grid gap-2 sm:grid-cols-3">
                            <AnomalyBadge
                                label="Suspicious Slippage Spikes"
                                value={data.anomalies.suspiciousSlippageSpikes}
                                critical={data.anomalies.suspiciousSlippageSpikes > 0}
                            />
                            <AnomalyBadge
                                label="Partial Fill Anomalies"
                                value={data.anomalies.partialFillAnomalies}
                                critical={data.anomalies.partialFillAnomalies > 0}
                            />
                            <AnomalyBadge
                                label="Quote/Base Integrity Violations"
                                value={data.anomalies.quoteBaseIntegrityViolations}
                                critical={data.anomalies.quoteBaseIntegrityViolations > 0}
                            />
                        </div>
                    </>
                )}
            </div>
        </Panel>
    );
}

function MetricCard({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone?: number | null;
}) {
    const toneClass =
        tone == null || !Number.isFinite(tone)
            ? 'text-slate-200'
            : tone > 0
                ? 'text-red-300'
                : tone < 0
                    ? 'text-emerald-300'
                    : 'text-slate-200';

    return (
        <div className="rounded border border-white/10 bg-white/[0.02] p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
            <div className={clsx('text-sm font-mono font-semibold', toneClass)}>{value}</div>
        </div>
    );
}

function ChartCard({
    title,
    children,
}: {
    title: string;
    children: ReactNode;
}) {
    return (
        <div className="rounded border border-white/10 bg-white/[0.02] p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">{title}</div>
            {children}
        </div>
    );
}

function AnomalyBadge({
    label,
    value,
    critical,
}: {
    label: string;
    value: number;
    critical: boolean;
}) {
    return (
        <div className={clsx(
            'rounded border px-2 py-1 text-[11px]',
            critical
                ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
                : 'border-white/10 bg-white/[0.02] text-slate-300',
        )}>
            <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
            <div className="font-mono text-base font-semibold">{value}</div>
        </div>
    );
}

function QualityBadge({ label, rate }: { label: string; rate: number | null | undefined }) {
    const pct = rate != null && Number.isFinite(rate) ? rate * 100 : null;
    const isHigh = pct != null && pct > 10;
    const isMed = pct != null && pct > 5;
    return (
        <div className={clsx(
            'rounded border px-2 py-1 text-[11px]',
            isHigh
                ? 'border-red-400/40 bg-red-500/10 text-red-200'
                : isMed
                    ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                    : 'border-white/10 bg-white/[0.02] text-slate-300',
        )}>
            <span className="text-[10px] uppercase tracking-wide opacity-80">{label}:</span>{' '}
            <span className="font-mono font-semibold">{pct != null ? `${pct.toFixed(1)}%` : '—'}</span>
        </div>
    );
}
