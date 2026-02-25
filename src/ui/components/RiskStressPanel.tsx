'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ShieldAlert, TrendingDown, Activity, Ban, Shield, Zap } from 'lucide-react';
import clsx from 'clsx';
import { Panel } from './Panel';
import type { RiskStressData, RiskEvent } from '../lib/hooks/useRiskStress';
import type { SpreadModel } from '../lib/hooks/useSpreadModel';

interface RiskStressPanelProps {
    data: RiskStressData;
    spread: SpreadModel;
    loading?: boolean;
    error?: string | null;
}

type ViewMode = 'overview' | 'adverse' | 'exposure' | 'events' | 'distribution';

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

function HealthDot({ ok, label }: { ok: boolean | null; label: string }) {
    return (
        <div className="flex items-center gap-1.5 text-[11px]">
            <div className={clsx(
                'h-2 w-2 rounded-full',
                ok == null ? 'bg-slate-600' : ok ? 'bg-emerald-400' : 'bg-red-400',
            )} />
            <span className={ok == null ? 'text-slate-500' : ok ? 'text-slate-300' : 'text-red-300'}>{label}</span>
        </div>
    );
}

function ProgressBar({ current, max, tone }: { current: number; max: number; tone: string }) {
    const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0;
    return (
        <div className="h-1.5 w-full rounded-full bg-white/10">
            <div
                className={clsx('h-1.5 rounded-full transition-all', tone)}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
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

    const dailyLossPct = (data.dailyLossLimit != null && data.dailyLossLimit > 0 && data.dailyLossCurrent != null)
        ? (data.dailyLossCurrent / data.dailyLossLimit) * 100
        : 0;

    return (
        <Panel
            title="Risk Stress"
            icon={ShieldAlert}
            compact
            fillHeight
            subtitle="Adverse selection · drawdown · exposure · system health"
            actions={
                <div className="flex rounded bg-white/5 p-0.5">
                    {(['overview', 'adverse', 'exposure', 'events', 'distribution'] as const).map((mode) => (
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

                {/* Kill switch alert — always visible when active */}
                {!loading && !error && data.killSwitch && (
                    <div className="flex items-start gap-2 rounded border border-red-600/60 bg-red-600/20 px-2 py-1.5 text-red-200">
                        <Ban size={14} className="mt-0.5 shrink-0" />
                        <div>
                            <div className="font-semibold text-[12px]">KILL SWITCH ACTIVE</div>
                            <div className="text-[10px] text-red-300/80">Emergency shutdown engaged — all execution halted</div>
                        </div>
                    </div>
                )}

                {/* Execution blocked alert */}
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

                {/* ──── OVERVIEW TAB ──── */}
                {!loading && !error && view === 'overview' && (
                    <>
                        {/* Primary risk metrics row */}
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
                                sub={
                                    data.thresholds.maxDrawdownPct != null
                                        ? `limit ${data.thresholds.maxDrawdownPct.toFixed(1)}% · max ${fmt(data.maxDrawdownPct, 2)}%`
                                        : data.maxDrawdownPct == null ? '' : `max ${data.maxDrawdownPct.toFixed(2)}%`
                                }
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
                        </div>

                        {/* Secondary risk metrics row (new) */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                            <MetricCard
                                label="DD Confidence"
                                value={data.drawdownConfidence == null ? '—' : (data.drawdownConfidence ? 'qualified' : 'low')}
                                tone={data.drawdownConfidence == null ? 'text-slate-400' : (data.drawdownConfidence ? 'text-emerald-300' : 'text-amber-300')}
                                sub={
                                    data.thresholds.minTradesForDrawdown != null
                                        ? `${data.hardRiskTradesCount ?? 0}/${data.thresholds.minTradesForDrawdown} trades`
                                        : `trades ${data.hardRiskTradesCount ?? 0}`
                                }
                            />
                            <MetricCard
                                label="Equity"
                                value={data.hardRiskEquityNow == null ? '—' : data.hardRiskEquityNow.toFixed(4)}
                                tone="text-slate-200"
                                sub={`peak ${data.hardRiskPeakEquity == null ? '—' : data.hardRiskPeakEquity.toFixed(4)}`}
                            />
                            <MetricCard
                                label="Daily Loss"
                                value={data.dailyLossCurrent == null ? '—' : data.dailyLossCurrent.toFixed(4)}
                                tone={dailyLossPct >= 80 ? 'text-red-400' : dailyLossPct >= 50 ? 'text-amber-300' : 'text-slate-200'}
                                sub={data.dailyLossLimit == null ? '' : `limit ${data.dailyLossLimit.toFixed(2)} (${dailyLossPct.toFixed(0)}%)`}
                            />
                            <MetricCard
                                label="Failures"
                                value={String(data.consecutiveFailures)}
                                tone={data.consecutiveFailures >= 5 ? 'text-red-400' : data.consecutiveFailures >= 3 ? 'text-amber-300' : 'text-slate-200'}
                                sub="consecutive"
                            />
                        </div>

                        {/* Daily loss gauge bar */}
                        {data.dailyLossLimit != null && data.dailyLossLimit > 0 && (
                            <div className="rounded border border-white/10 bg-white/[0.02] p-2">
                                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
                                    <span>Daily Loss Utilization</span>
                                    <span>{dailyLossPct.toFixed(1)}%</span>
                                </div>
                                <ProgressBar
                                    current={data.dailyLossCurrent ?? 0}
                                    max={data.dailyLossLimit}
                                    tone={dailyLossPct >= 80 ? 'bg-red-500' : dailyLossPct >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}
                                />
                            </div>
                        )}

                        {/* System health row */}
                        <div className="flex flex-wrap items-center gap-3 rounded border border-white/10 bg-white/[0.02] px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-slate-500 mr-1">System Health</div>
                            <HealthDot ok={data.runtimeReady} label="Runtime" />
                            <HealthDot ok={data.marketDataValid} label="Market Data" />
                            <HealthDot ok={data.balancesFresh} label="Balances" />
                            <HealthDot ok={data.feedHealthy} label="Feed" />
                            <HealthDot ok={data.executionAllowed} label="Execution" />
                        </div>

                        {/* Spread distribution snapshot */}
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

                {/* ──── ADVERSE TAB ──── */}
                {!loading && !error && view === 'adverse' && (
                    <>
                        {/* Primary adverse metrics */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            <MetricCard
                                label="Adverse Rate (1h)"
                                value={data.adverseRate == null ? '—' : `${(data.adverseRate * 100).toFixed(1)}%`}
                                tone={toneForAdverse(data.adverseRate)}
                                sub={`${riskBand(data.adverseRate)} risk band`}
                                icon={AlertTriangle}
                            />
                            <MetricCard
                                label="Adverse Fills"
                                value={`${data.adverseCount} / ${data.sampleCount}`}
                                tone={data.adverseCount > 0 ? 'text-amber-300' : 'text-slate-200'}
                                sub={data.sampleCount > 0 ? `${((data.adverseCount / data.sampleCount) * 100).toFixed(1)}% of samples` : 'no samples'}
                            />
                            <MetricCard
                                label="Sample Count"
                                value={String(data.sampleCount)}
                                tone={data.sampleCount < 10 ? 'text-amber-300' : 'text-slate-200'}
                                sub={data.sampleCount < 10 ? 'low confidence' : 'sufficient data'}
                                icon={Activity}
                            />
                        </div>

                        {/* Adverse rate gauge */}
                        <div className="rounded border border-white/10 bg-white/[0.02] p-2">
                            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
                                <span>Adverse Selection Severity</span>
                                <span className={toneForAdverse(data.adverseRate)}>{riskBand(data.adverseRate)}</span>
                            </div>
                            <div className="relative h-2 w-full rounded-full bg-white/10 overflow-hidden">
                                <div
                                    className={clsx(
                                        'h-full rounded-full transition-all duration-500',
                                        data.adverseRate == null ? 'bg-slate-600'
                                            : data.adverseRate >= 0.30 ? 'bg-red-500'
                                                : data.adverseRate >= 0.15 ? 'bg-amber-500'
                                                    : 'bg-emerald-500',
                                    )}
                                    style={{ width: `${Math.min(100, (data.adverseRate ?? 0) * 100 * (100 / 50))}%` }}
                                />
                                {/* Threshold markers */}
                                <div className="absolute top-0 h-full w-px bg-amber-400/60" style={{ left: '30%' }} title="MED threshold (15%)" />
                                <div className="absolute top-0 h-full w-px bg-red-400/60" style={{ left: '60%' }} title="HIGH threshold (30%)" />
                            </div>
                            <div className="mt-1 flex justify-between text-[9px] text-slate-600">
                                <span>0%</span>
                                <span className="text-amber-500/50">15% (MED)</span>
                                <span className="text-red-500/50">30% (HIGH)</span>
                                <span>50%+</span>
                            </div>
                        </div>

                        {/* Risk band explanation */}
                        <div className="grid gap-2 sm:grid-cols-3">
                            {[
                                { band: 'LOW', range: '< 15%', desc: 'Normal flow conditions, minimal adverse selection detected', tone: 'border-emerald-500/30 bg-emerald-500/5', text: 'text-emerald-400' },
                                { band: 'MED', range: '15–30%', desc: 'Elevated adverse selection — position sizing should be reduced', tone: 'border-amber-500/30 bg-amber-500/5', text: 'text-amber-400' },
                                { band: 'HIGH', range: '≥ 30%', desc: 'Severe adverse flow — consider pausing execution', tone: 'border-red-500/30 bg-red-500/5', text: 'text-red-400' },
                            ].map((b) => (
                                <div
                                    key={b.band}
                                    className={clsx(
                                        'rounded border p-2 text-[10px]',
                                        b.tone,
                                        riskBand(data.adverseRate) === b.band ? 'ring-1 ring-white/20' : 'opacity-60',
                                    )}
                                >
                                    <div className={clsx('font-semibold', b.text)}>{b.band} ({b.range})</div>
                                    <div className="text-slate-400 mt-0.5">{b.desc}</div>
                                </div>
                            ))}
                        </div>

                        {/* Context metrics */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                            <MetricCard
                                label="Drawdown"
                                value={data.drawdownPct == null ? '—' : `${data.drawdownPct.toFixed(2)}%`}
                                tone={data.drawdownPct != null && data.drawdownPct >= 8 ? 'text-red-400' : 'text-slate-200'}
                                sub="correlated risk"
                                icon={TrendingDown}
                            />
                            <MetricCard
                                label="Feed Health"
                                value={data.feedHealthy === true ? 'Healthy' : data.feedHealthy === false ? 'Degraded' : '—'}
                                tone={data.feedHealthy === true ? 'text-emerald-300' : data.feedHealthy === false ? 'text-red-400' : 'text-slate-400'}
                                sub="data quality"
                            />
                            <MetricCard
                                label="Spread Now"
                                value={spread.currentSpreadBps == null ? '—' : `${spread.currentSpreadBps.toFixed(1)} bps`}
                                tone={spread.currentSpreadBps != null && spread.currentSpreadBps > 150 ? 'text-amber-300' : 'text-slate-200'}
                                sub="wider spread → more adverse"
                            />
                            <MetricCard
                                label="Consec Failures"
                                value={String(data.consecutiveFailures)}
                                tone={data.consecutiveFailures >= 5 ? 'text-red-400' : data.consecutiveFailures >= 3 ? 'text-amber-300' : 'text-slate-200'}
                                sub="execution quality"
                            />
                        </div>
                    </>
                )}

                {/* ──── EXPOSURE TAB ──── */}
                {!loading && !error && view === 'exposure' && (
                    <>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                            <MetricCard
                                label="Net Position"
                                value={data.exposure.netPositionBase == null ? '—' : data.exposure.netPositionBase.toFixed(4)}
                                tone={
                                    data.exposure.netPositionBase == null
                                        ? 'text-slate-400'
                                        : data.exposure.netPositionBase > 0
                                            ? 'text-emerald-300'
                                            : data.exposure.netPositionBase < 0
                                                ? 'text-red-300'
                                                : 'text-slate-200'
                                }
                                sub={data.exposure.netPositionBase != null
                                    ? (data.exposure.netPositionBase > 0 ? 'LONG' : data.exposure.netPositionBase < 0 ? 'SHORT' : 'FLAT')
                                    : 'base currency'}
                                icon={Activity}
                            />
                            <MetricCard
                                label="Notional Exposure"
                                value={data.exposure.notionalExposure == null ? '—' : data.exposure.notionalExposure.toFixed(2)}
                                tone="text-slate-200"
                                sub={
                                    data.thresholds.maxExposureNotional != null
                                        ? `limit ${data.thresholds.maxExposureNotional.toFixed(0)}`
                                        : 'quote currency'
                                }
                            />
                            <MetricCard
                                label="Inventory Skew"
                                value={data.exposure.inventorySkewPct == null ? '—' : `${data.exposure.inventorySkewPct.toFixed(1)}%`}
                                tone={
                                    data.exposure.inventorySkewPct == null
                                        ? 'text-slate-400'
                                        : Math.abs(data.exposure.inventorySkewPct) > 60
                                            ? 'text-red-400'
                                            : Math.abs(data.exposure.inventorySkewPct) > 30
                                                ? 'text-amber-300'
                                                : 'text-emerald-300'
                                }
                                sub={
                                    data.thresholds.maxInventorySkewPct != null
                                        ? `limit ±${data.thresholds.maxInventorySkewPct.toFixed(0)}%`
                                        : 'balanced = 0%'
                                }
                            />
                            <MetricCard
                                label="Mid Price"
                                value={data.exposure.lastMidPrice == null ? '—' : data.exposure.lastMidPrice.toFixed(6)}
                                tone="text-slate-200"
                                sub="last known"
                            />
                        </div>

                        {/* Exposure utilization bars */}
                        {data.thresholds.maxExposureNotional != null && data.thresholds.maxExposureNotional > 0 && (
                            <div className="rounded border border-white/10 bg-white/[0.02] p-2">
                                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
                                    <span>Exposure Utilization</span>
                                    <span>
                                        {fmt(data.exposure.notionalExposure, 2)} / {fmt(data.thresholds.maxExposureNotional, 0)}
                                    </span>
                                </div>
                                <ProgressBar
                                    current={data.exposure.notionalExposure ?? 0}
                                    max={data.thresholds.maxExposureNotional}
                                    tone={
                                        ((data.exposure.notionalExposure ?? 0) / data.thresholds.maxExposureNotional) >= 0.8
                                            ? 'bg-red-500'
                                            : ((data.exposure.notionalExposure ?? 0) / data.thresholds.maxExposureNotional) >= 0.5
                                                ? 'bg-amber-500'
                                                : 'bg-emerald-500'
                                    }
                                />
                            </div>
                        )}

                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                            <MetricCard
                                label="Fills Tracked"
                                value={String(data.exposure.fillCount)}
                                tone="text-slate-200"
                                sub="since reset"
                            />
                            <MetricCard
                                label="Total Bought"
                                value={data.exposure.totalBought.toFixed(4)}
                                tone="text-emerald-300"
                                sub="base"
                            />
                            <MetricCard
                                label="Total Sold"
                                value={data.exposure.totalSold.toFixed(4)}
                                tone="text-red-300"
                                sub="base"
                            />
                            <MetricCard
                                label="Last Fill"
                                value={data.exposure.lastFillMs != null && data.exposure.lastFillMs > 0
                                    ? new Date(data.exposure.lastFillMs).toLocaleTimeString([], { hour12: false })
                                    : '—'}
                                tone="text-slate-200"
                                sub={data.exposure.lastFillMs != null && data.exposure.lastFillMs > 0
                                    ? `${Math.round((Date.now() - data.exposure.lastFillMs) / 1000)}s ago`
                                    : 'no fills'}
                            />
                        </div>
                    </>
                )}

                {/* ──── EVENTS TAB ──── */}
                {!loading && !error && view === 'events' && (
                    <div className="space-y-2">
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">
                            Risk Event Timeline ({data.recentEvents.length} events)
                        </div>
                        {data.recentEvents.length === 0 && (
                            <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-4 text-center text-[11px] text-slate-500">
                                No risk events recorded
                            </div>
                        )}
                        <div className="max-h-[400px] space-y-1 overflow-auto">
                            {data.recentEvents.map((event, idx) => (
                                <RiskEventRow key={`${event.timestamp}-${idx}`} event={event} />
                            ))}
                        </div>
                    </div>
                )}

                {/* ──── DISTRIBUTION TAB ──── */}
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

function RiskEventRow({ event }: { event: RiskEvent }) {
    const typeConfig = {
        RISK_LIMIT_BLOCK: { icon: Ban, color: 'text-red-400', border: 'border-red-500/30', bg: 'bg-red-500/5' },
        RISK_LIMIT_WARNING: { icon: AlertTriangle, color: 'text-amber-400', border: 'border-amber-500/30', bg: 'bg-amber-500/5' },
        RISK_LIMIT_RECOVERY: { icon: Shield, color: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5' },
    }[event.type] ?? { icon: Zap, color: 'text-slate-400', border: 'border-white/10', bg: 'bg-white/[0.02]' };

    const EventIcon = typeConfig.icon;
    const label = event.type.replace('RISK_LIMIT_', '');

    return (
        <div className={clsx('flex items-start gap-2 rounded border px-2 py-1.5 text-[11px]', typeConfig.border, typeConfig.bg)}>
            <EventIcon size={12} className={clsx('mt-0.5 shrink-0', typeConfig.color)} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className={clsx('font-semibold', typeConfig.color)}>{label}</span>
                    <span className="text-slate-500">{event.pairKey}</span>
                    <span className="ml-auto text-[10px] text-slate-500">
                        {new Date(event.timestamp).toLocaleTimeString([], { hour12: false })}
                    </span>
                </div>
                {event.reasons.length > 0 && (
                    <div className="mt-0.5 text-slate-400">{event.reasons.join(', ')}</div>
                )}
            </div>
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
