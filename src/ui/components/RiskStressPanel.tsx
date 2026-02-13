'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ShieldAlert, TrendingDown } from 'lucide-react';
import clsx from 'clsx';
import { Panel } from './Panel';
import type { RiskStressData } from '../lib/hooks/useRiskStress';
import type { SpreadModel } from '../lib/hooks/useSpreadModel';

interface RiskStressPanelProps {
    data: RiskStressData;
    spread: SpreadModel;
    loading?: boolean;
    error?: string | null;
}

type ViewMode = 'overview' | 'distribution';

function fmt(value: number | null | undefined, digits = 1): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toFixed(digits);
}

function riskBand(adverseRate: number | null): 'LOW' | 'MED' | 'HIGH' | '—' {
    if (adverseRate == null || !Number.isFinite(adverseRate)) return '—';
    if (adverseRate >= 0.30) return 'HIGH';
    if (adverseRate >= 0.15) return 'MED';
    return 'LOW';
}

function toneForAdverse(rate: number | null): string {
    if (rate == null || !Number.isFinite(rate)) return 'text-slate-400';
    if (rate >= 0.30) return 'text-red-400';
    if (rate >= 0.15) return 'text-amber-400';
    return 'text-emerald-400';
}

export function RiskStressPanel({ data, spread, loading = false, error = null }: RiskStressPanelProps) {
    const [view, setView] = useState<ViewMode>('overview');

    const spreadRows = useMemo(
        () => [
            {
                label: '24h',
                sampleCount: spread.lookback24h?.sampleCount ?? 0,
                p50: spread.lookback24h?.medianBps ?? null,
                p75: spread.lookback24h?.p75Bps ?? null,
                p90: spread.lookback24h?.p90Bps ?? null,
            },
            {
                label: spread.baselineMultiDay?.days ? `Baseline ${spread.baselineMultiDay.days}d` : 'Baseline',
                sampleCount: spread.baselineMultiDay?.sampleCount ?? 0,
                p50: spread.baselineMultiDay?.medianBps ?? null,
                p75: spread.baselineMultiDay?.p75Bps ?? null,
                p90: spread.baselineMultiDay?.p90Bps ?? null,
            },
        ],
        [spread.lookback24h, spread.baselineMultiDay],
    );

    return (
        <Panel
            title="Risk Stress"
            icon={ShieldAlert}
            compact
            fillHeight
            subtitle="Adverse selection + drawdown + spread stress"
            actions={
                <div className="flex rounded bg-white/5 p-0.5">
                    {(['overview', 'distribution'] as const).map((mode) => (
                        <button
                            key={mode}
                            onClick={() => setView(mode)}
                            className={clsx(
                                'px-2 py-0.5 text-[10px] rounded transition-colors capitalize',
                                view === mode
                                    ? 'bg-sky-500/30 text-sky-300'
                                    : 'text-slate-500 hover:text-slate-300'
                            )}
                        >
                            {mode}
                        </button>
                    ))}
                </div>
            }
        >
            <div className="space-y-2 text-xs">
                {loading && (
                    <div className="text-[11px] text-slate-500">Loading risk stress...</div>
                )}

                {error && (
                    <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">
                        <AlertTriangle size={12} />
                        <span>{error}</span>
                    </div>
                )}

                {!loading && !error && data.hardRiskState === 'BLOCKED' && (
                    <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-300">
                        <AlertTriangle size={12} className="mt-0.5" />
                        <span className="text-[11px]">
                            Blocked by Hard Risk: {data.hardRiskReasons.length > 0 ? data.hardRiskReasons.join(', ') : 'unknown'}
                        </span>
                    </div>
                )}

                {!loading && !error && data.hardRiskState === 'WARNING' && (
                    <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-300">
                        <AlertTriangle size={12} className="mt-0.5" />
                        <span className="text-[11px]">
                            Hard Risk warning: {data.hardRiskReasons.length > 0 ? data.hardRiskReasons.join(', ') : 'warning active'}
                        </span>
                    </div>
                )}

                {!loading && !error && view === 'overview' && (
                    <>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                            <MetricCard
                                label="Adverse 1h"
                                value={data.adverseRate == null ? '—' : `${(data.adverseRate * 100).toFixed(1)}%`}
                                tone={toneForAdverse(data.adverseRate)}
                                sub={`${data.adverseCount}/${data.sampleCount} (${riskBand(data.adverseRate)})`}
                            />
                            <MetricCard
                                label="Drawdown"
                                value={data.drawdownPct == null ? '—' : `${data.drawdownPct.toFixed(2)}%`}
                                tone={data.drawdownPct != null && data.drawdownPct >= 8 ? 'text-red-400' : 'text-slate-200'}
                                sub={data.maxDrawdownPct == null ? '' : `max ${data.maxDrawdownPct.toFixed(2)}%`}
                                icon={TrendingDown}
                            />
                            <MetricCard
                                label="DD Velocity"
                                value={data.drawdownVelocity == null ? '—' : `${data.drawdownVelocity.toFixed(2)}/h`}
                                tone={data.drawdownVelocity != null && Math.abs(data.drawdownVelocity) > 5 ? 'text-amber-300' : 'text-slate-200'}
                                sub="rolling"
                            />
                            <MetricCard
                                label="Spread Now"
                                value={spread.currentSpreadBps == null ? '—' : `${spread.currentSpreadBps.toFixed(1)} bps`}
                                tone={spread.currentSpreadBps != null && spread.currentSpreadBps > 150 ? 'text-amber-300' : 'text-slate-200'}
                                sub={spread.updatedAtMs ? `upd ${new Date(spread.updatedAtMs).toLocaleTimeString([], { hour12: false })}` : 'runtime cache'}
                            />
                            <MetricCard
                                label="DD Confidence"
                                value={data.drawdownConfidence == null ? '—' : (data.drawdownConfidence ? 'qualified' : 'low')}
                                tone={data.drawdownConfidence == null ? 'text-slate-400' : (data.drawdownConfidence ? 'text-emerald-300' : 'text-amber-300')}
                                sub={`trades ${data.hardRiskTradesCount ?? 0}, peak ${data.hardRiskPeakEquity == null ? '—' : data.hardRiskPeakEquity.toFixed(3)}`}
                            />
                        </div>

                        <div className="grid gap-1 rounded border border-white/10 bg-white/[0.02] p-2 text-[11px]">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Spread Distribution Snapshot</div>
                            <div className="grid grid-cols-2 gap-2">
                                {spreadRows.map((row) => (
                                    <div key={row.label} className="space-y-1 rounded border border-white/5 bg-white/[0.03] p-2">
                                        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
                                            <span>{row.label}</span>
                                            <span>{row.sampleCount} smp</span>
                                        </div>
                                        <div className="grid grid-cols-3 gap-2 font-mono text-slate-300">
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">p50</span>
                                                <span>{fmt(row.p50, 1)}</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">p75</span>
                                                <span>{fmt(row.p75, 1)}</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">p90</span>
                                                <span>{fmt(row.p90, 1)}</span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </>
                )}

                {!loading && !error && view === 'distribution' && (
                    <div className="space-y-2">
                        {spreadRows.map((row) => (
                            <div key={row.label} className="rounded border border-white/10 bg-white/[0.02] p-2">
                                <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
                                    <span>{row.label}</span>
                                    <span>{row.sampleCount} samples</span>
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                                    <SpreadStat label="p50" value={row.p50} />
                                    <SpreadStat label="p75" value={row.p75} />
                                    <SpreadStat label="p90" value={row.p90} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Panel>
    );
}

function MetricCard({
    label,
    value,
    tone,
    sub,
    icon: Icon,
}: {
    label: string;
    value: string;
    tone?: string;
    sub?: string;
    icon?: typeof TrendingDown;
}) {
    return (
        <div className="rounded border border-white/10 bg-white/[0.02] p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
                <span>{label}</span>
                {Icon ? <Icon size={10} /> : null}
            </div>
            <div className={clsx('font-mono text-[13px] font-semibold', tone || 'text-slate-200')}>
                {value}
            </div>
            {sub ? <div className="text-[10px] text-slate-500">{sub}</div> : null}
        </div>
    );
}

function SpreadStat({ label, value }: { label: string; value: number | null }) {
    return (
        <div className="rounded border border-white/5 bg-white/[0.02] p-2 text-center">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
            <div className="font-mono text-[12px] text-slate-200">{fmt(value, 1)}</div>
        </div>
    );
}

export default RiskStressPanel;
