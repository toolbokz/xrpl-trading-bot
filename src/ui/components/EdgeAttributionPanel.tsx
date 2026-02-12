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

type EdgeSide = 'buy' | 'sell';
type EdgeSource = 'bot' | 'manual' | 'unknown';

interface EdgeAttributionSummary {
    events: number;
    coverageDecision: number;
    coverage1m: number;
    coverage5m: number;
    avgSignalEdgeBpsExAnte: number | null;
    avgSignalEdgeBpsExPost1m: number | null;
    avgSignalEdgeBpsExPost5m: number | null;
    avgExecutionEdgeBpsVsMid: number | null;
    avgExecutionEdgeBpsVsBbo: number | null;
    avgDriftBps1m: number | null;
    avgDriftBps5m: number | null;
    avgPnlExecQuote: number | null;
    avgPnlTotalQuote1m: number | null;
    avgPnlTotalQuote5m: number | null;
}

interface EdgeAttributionBucket {
    ts: number;
    count: number;
    avgExecutionEdgeBpsVsMid: number | null;
    avgDriftBps1m: number | null;
    avgSignalEdgeBpsExPost1m: number | null;
    avgPnlTotalQuote1m: number | null;
}

interface EdgeAttributionHistogramBin {
    min: number;
    max: number;
    count: number;
}

interface EdgeAttributionBreakdownRow {
    key: string;
    count: number;
    avgExecutionEdgeBpsVsMid: number | null;
    avgDriftBps1m: number | null;
    avgPnlTotalQuote1m: number | null;
}

interface EdgeAttributionTopTrade {
    txHash: string | null;
    ts: number;
    pairKey: string;
    strategy: string | null;
    side: EdgeSide | null;
    executionEdgeBpsVsMid: number | null;
    driftBps1m: number | null;
    pnlTotalQuote1m: number | null;
    fillPrice: number | null;
    midDecision: number | null;
    baseFilled: number | null;
}

interface EdgeAttributionApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        sinceMs: number | null;
        strategy: string | null;
        side: EdgeSide | null;
        source: EdgeSource | null;
        bucketMs: number;
    };
    summary: EdgeAttributionSummary;
    series: EdgeAttributionBucket[];
    histograms: {
        executionEdgeBps: EdgeAttributionHistogramBin[];
        driftBps: EdgeAttributionHistogramBin[];
    };
    breakdowns: {
        byPair: EdgeAttributionBreakdownRow[];
        byStrategy: EdgeAttributionBreakdownRow[];
        bySide: EdgeAttributionBreakdownRow[];
        byRegime: EdgeAttributionBreakdownRow[];
    };
    topTrades: {
        worstExecution: EdgeAttributionTopTrade[];
        adverseSelection: EdgeAttributionTopTrade[];
    };
}

export interface EdgeAttributionPanelProps {
    pairKey?: string;
    strategy?: string;
    pollInterval?: number;
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

export function EdgeAttributionPanel({
    pairKey,
    strategy,
    pollInterval = 20_000,
}: EdgeAttributionPanelProps) {
    const [data, setData] = useState<EdgeAttributionApiResponse | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    const [sinceWindowMs, setSinceWindowMs] = useState<number>(sinceOptions[1]!.ms);
    const [bucketMs, setBucketMs] = useState<number>(bucketOptions[0]!.ms);
    const [side, setSide] = useState<EdgeSide | ''>('');
    const [source, setSource] = useState<EdgeSource | ''>('');
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

            const res = await fetch(`/api/analytics/edge-attribution?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json() as EdgeAttributionApiResponse;
            setData(json);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch edge attribution');
        } finally {
            setLoading(false);
        }
    }, [pairKey, sinceWindowMs, bucketMs, strategyFilter, side, source]);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, pollInterval);
        return () => clearInterval(interval);
    }, [fetchData, pollInterval]);

    const series = useMemo(
        () =>
            (data?.series ?? []).map((point) => ({
                ...point,
                t: new Date(point.ts).toLocaleTimeString('en-US', {
                    hour12: false,
                    minute: '2-digit',
                    second: '2-digit',
                }),
            })),
        [data?.series]
    );

    const summary = data?.summary;

    return (
        <Panel
            title="True Edge Attribution"
            icon={BarChart3}
            compact
            fillHeight
            subtitle="Signal vs execution vs drift decomposition (quote/base)"
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
                            onChange={(e) => setSide((e.target.value as EdgeSide | '') ?? '')}
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
                            onChange={(e) => setSource((e.target.value as EdgeSource | '') ?? '')}
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
                        <span>Loading edge attribution…</span>
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
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
                            <MetricCard label="Events" value={String(summary.events)} />
                            <MetricCard label="Signal Ex-Ante" value={`${fmt(summary.avgSignalEdgeBpsExAnte, 1)} bps`} tone={summary.avgSignalEdgeBpsExAnte} />
                            <MetricCard label="Signal Ex-Post 1m" value={`${fmt(summary.avgSignalEdgeBpsExPost1m, 1)} bps`} tone={summary.avgSignalEdgeBpsExPost1m} />
                            <MetricCard label="Execution vs Mid" value={`${fmt(summary.avgExecutionEdgeBpsVsMid, 1)} bps`} tone={summary.avgExecutionEdgeBpsVsMid} />
                            <MetricCard label="Execution vs BBO" value={`${fmt(summary.avgExecutionEdgeBpsVsBbo, 1)} bps`} tone={summary.avgExecutionEdgeBpsVsBbo} />
                            <MetricCard label="Drift 1m" value={`${fmt(summary.avgDriftBps1m, 1)} bps`} tone={summary.avgDriftBps1m} />
                            <MetricCard label="Drift 5m" value={`${fmt(summary.avgDriftBps5m, 1)} bps`} tone={summary.avgDriftBps5m} />
                        </div>

                        <div className="grid gap-2 sm:grid-cols-3">
                            <CoverageCard label="Decision Coverage" value={fmtPct(summary.coverageDecision)} />
                            <CoverageCard label="Horizon 1m Coverage" value={fmtPct(summary.coverage1m)} />
                            <CoverageCard label="Horizon 5m Coverage" value={fmtPct(summary.coverage5m)} />
                        </div>

                        <div className="grid gap-3 xl:grid-cols-2">
                            <ChartCard title="Execution / Drift / Signal (1m)">
                                <ResponsiveContainer width="100%" height={210}>
                                    <LineChart data={series}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                                        <Line type="monotone" dataKey="avgExecutionEdgeBpsVsMid" stroke="#22d3ee" dot={false} strokeWidth={1.8} />
                                        <Line type="monotone" dataKey="avgDriftBps1m" stroke="#f97316" dot={false} strokeWidth={1.8} />
                                        <Line type="monotone" dataKey="avgSignalEdgeBpsExPost1m" stroke="#a78bfa" dot={false} strokeWidth={1.8} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </ChartCard>
                            <ChartCard title="Mark-to-1m PnL (quote)">
                                <ResponsiveContainer width="100%" height={210}>
                                    <LineChart data={series}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                                        <Line type="monotone" dataKey="avgPnlTotalQuote1m" stroke="#34d399" dot={false} strokeWidth={1.8} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </ChartCard>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                            <Histogram title="Execution Edge Histogram (bps)" data={data.histograms.executionEdgeBps} />
                            <Histogram title="Drift Histogram (bps)" data={data.histograms.driftBps} />
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                            <BreakdownTable title="By Pair" rows={data.breakdowns.byPair} />
                            <BreakdownTable title="By Strategy" rows={data.breakdowns.byStrategy} />
                            <BreakdownTable title="By Side" rows={data.breakdowns.bySide} />
                            <BreakdownTable title="By Regime" rows={data.breakdowns.byRegime} />
                        </div>

                        <div className="grid gap-3 xl:grid-cols-2">
                            <TopTradesTable title="Worst Execution Trades" rows={data.topTrades.worstExecution} />
                            <TopTradesTable title="Most Adverse Selection Trades" rows={data.topTrades.adverseSelection} />
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
                ? 'text-emerald-300'
                : tone < 0
                    ? 'text-red-300'
                    : 'text-slate-200';

    return (
        <div className="rounded border border-white/10 bg-white/[0.02] p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
            <div className={clsx('text-sm font-mono font-semibold', toneClass)}>{value}</div>
        </div>
    );
}

function CoverageCard({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded border border-white/10 bg-white/[0.02] p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
            <div className="text-sm font-mono font-semibold text-slate-200">{value}</div>
        </div>
    );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="rounded border border-white/10 bg-white/[0.02] p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">{title}</div>
            {children}
        </div>
    );
}

function Histogram({ title, data }: { title: string; data: EdgeAttributionHistogramBin[] }) {
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
    rows: EdgeAttributionBreakdownRow[];
}) {
    return (
        <div className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
            <div className="border-b border-white/10 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">{title}</div>
            <div className="max-h-[190px] overflow-auto">
                <table className="w-full text-[11px]">
                    <thead className="text-slate-500">
                        <tr className="border-b border-white/5">
                            <th className="px-2 py-1 text-left">Key</th>
                            <th className="px-2 py-1 text-right">Count</th>
                            <th className="px-2 py-1 text-right">Exec</th>
                            <th className="px-2 py-1 text-right">Drift</th>
                            <th className="px-2 py-1 text-right">PnL 1m</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, 8).map((row) => (
                            <tr key={row.key} className="border-b border-white/5 text-slate-300">
                                <td className="px-2 py-1">{row.key}</td>
                                <td className="px-2 py-1 text-right">{row.count}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.avgExecutionEdgeBpsVsMid, 1)}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.avgDriftBps1m, 1)}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.avgPnlTotalQuote1m, 4)}</td>
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

function TopTradesTable({
    title,
    rows,
}: {
    title: string;
    rows: EdgeAttributionTopTrade[];
}) {
    return (
        <div className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
            <div className="border-b border-white/10 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">{title}</div>
            <div className="max-h-[220px] overflow-auto">
                <table className="w-full text-[11px]">
                    <thead className="text-slate-500">
                        <tr className="border-b border-white/5">
                            <th className="px-2 py-1 text-left">Tx</th>
                            <th className="px-2 py-1 text-right">Exec</th>
                            <th className="px-2 py-1 text-right">Drift</th>
                            <th className="px-2 py-1 text-right">PnL 1m</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, 10).map((row, idx) => (
                            <tr key={`${row.txHash ?? 'none'}-${idx}`} className="border-b border-white/5 text-slate-300">
                                <td className="px-2 py-1 font-mono">{(row.txHash ?? 'n/a').slice(0, 10)}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.executionEdgeBpsVsMid, 1)}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.driftBps1m, 1)}</td>
                                <td className="px-2 py-1 text-right">{fmt(row.pnlTotalQuote1m, 4)}</td>
                            </tr>
                        ))}
                        {rows.length === 0 && (
                            <tr>
                                <td className="px-2 py-2 text-slate-500" colSpan={4}>No data</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
