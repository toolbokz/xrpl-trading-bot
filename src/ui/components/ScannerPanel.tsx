'use client';

import React, { useMemo, useState } from 'react';
import { ArrowDownUp, Radar, Target } from 'lucide-react';
import { Panel, PanelBadge } from './Panel';
import { useRuntimeCache } from '../lib/hooks/useRuntimeCache';
import { sortMarkets, toBackgroundView, type RadarSortKey, type ScannerMarketItem } from './backgroundScannerViewModel';

interface ScannerPanelProps {
    compact?: boolean;
}

export function ScannerPanel({ compact = false }: ScannerPanelProps) {
    const { data, loading } = useRuntimeCache();
    const snapshot = data?.snapshot ?? null;
    const bg = toBackgroundView(snapshot);
    const [sortBy, setSortBy] = useState<RadarSortKey>('stale');

    const rows = useMemo(() => {
        const markets = bg?.markets ?? [];
        return sortMarkets(markets, sortBy).slice(0, 12);
    }, [bg?.markets, sortBy]);

    const topPairs = useMemo(() => (bg?.crossMarket.bestPairs ?? []).slice(0, 3), [bg?.crossMarket.bestPairs]);

    return (
        <Panel
            title="Scanner"
            icon={Radar}
            compact={compact}
            fillHeight
            subtitle={`last scan ${fmtTime(bg?.asOfMs ?? snapshot?.asOfMs ?? null)}`}
            actions={
                <div className="flex items-center gap-1">
                    <SortButton label="Stale" active={sortBy === 'stale'} onClick={() => setSortBy('stale')} />
                    <SortButton label="Spread" active={sortBy === 'spread'} onClick={() => setSortBy('spread')} />
                    <SortButton label="Depth" active={sortBy === 'depth'} onClick={() => setSortBy('depth')} />
                </div>
            }
            bodyClassName="p-0"
        >
            {!bg ? (
                <div className="p-3 text-[11px] text-slate-500">{loading ? 'Updating scanner…' : 'Scanner disabled or warming up.'}</div>
            ) : (
                <div className="h-full overflow-auto">
                    <div className="border-b border-white/10 px-2 py-2">
                        <div className="mb-1 flex items-center justify-between">
                            <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
                                <Target size={10} /> Fair Value
                            </div>
                            <PanelBadge tone={bg.health.degraded ? 'warning' : 'success'}>
                                {bg.health.degraded ? 'degraded' : 'healthy'}
                            </PanelBadge>
                        </div>
                        <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
                            <Metric label="Fair" value={fmtNum(bg.fairValue.fairValue, 6)} />
                            <Metric label="Div" value={fmtSignedBps(bg.fairValue.divergenceBps)} />
                            <Metric label="Conf" value={bg.fairValue.confidence == null ? '—' : `${Math.round(bg.fairValue.confidence)}%`} />
                        </div>
                        {topPairs.length > 0 ? (
                            <div className="mt-2 grid grid-cols-3 gap-1">
                                {topPairs.map((item, index) => (
                                    <div key={`${item.pairKey}-${index}`} className="rounded border border-white/10 bg-white/5 px-2 py-1">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="truncate text-[10px] text-slate-300">{item.pairKey}</span>
                                            <span className="text-[10px] font-semibold text-sky-300">{item.score}</span>
                                        </div>
                                        <div className="mt-0.5 text-[9px] text-slate-500">{fmtStale(item.stalenessMs)} / {fmtNum(item.spreadBps, 1)}bps</div>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>

                    <table className="w-full text-[11px] font-mono">
                        <thead className="sticky top-0 border-b border-white/10 bg-card text-[9px] uppercase tracking-wider text-slate-500">
                            <tr>
                                <th className="px-2 py-1 text-left">Pair</th>
                                <th className="px-2 py-1 text-right">Mid</th>
                                <th className="px-2 py-1 text-right">Spread</th>
                                <th className="px-2 py-1 text-right">Depth</th>
                                <th className="px-2 py-1 text-right">Stale</th>
                                <th className="px-2 py-1 text-right">Verdict</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <ScannerRow key={row.pairKey} row={row} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded border border-white/10 bg-white/[0.03] px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
            <div className="text-[12px] font-semibold text-slate-100">{value}</div>
        </div>
    );
}

function SortButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] ${active
                ? 'border-sky-500/30 bg-sky-500/15 text-sky-300'
                : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                }`}
        >
            <ArrowDownUp size={10} />
            {label}
        </button>
    );
}

function ScannerRow({ row }: { row: ScannerMarketItem }) {
    const staleWarn = row.stalenessMs > 20_000;
    const spreadWarn = row.spreadBps > 150;

    return (
        <tr className={`border-b border-white/5 ${staleWarn ? 'opacity-70' : ''}`}>
            <td className="max-w-[120px] truncate px-2 py-1 text-slate-300">{row.pairKey}</td>
            <td className="px-2 py-1 text-right text-slate-200">{fmtNum(row.mid, 6)}</td>
            <td className={`px-2 py-1 text-right ${spreadWarn ? 'text-amber-300' : 'text-slate-300'}`}>
                {fmtNum(row.spreadBps, 1)}
            </td>
            <td className="px-2 py-1 text-right text-slate-400">{fmtDepth(row.depthTopNotional)}</td>
            <td className={`px-2 py-1 text-right ${staleWarn ? 'text-amber-300' : 'text-slate-400'}`}>
                {fmtStale(row.stalenessMs)}
            </td>
            <td className="px-2 py-1 text-right">
                <VerdictBadge verdict={row.verdict} />
            </td>
        </tr>
    );
}

function VerdictBadge({ verdict }: { verdict: string }) {
    const upper = verdict.toUpperCase();
    if (upper === 'AVAILABLE') return <PanelBadge tone="success">OK</PanelBadge>;
    if (upper === 'DEGRADED') return <PanelBadge tone="warning">DEG</PanelBadge>;
    return <PanelBadge tone="neutral">{upper.slice(0, 3)}</PanelBadge>;
}

function fmtNum(v: number | null, digits: number): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
}

function fmtSignedBps(v: number | null): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`;
}

function fmtDepth(v: number): string {
    if (!Number.isFinite(v) || v <= 0) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
}

function fmtStale(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60_000)}m`;
}

function fmtTime(ts: number | null): string {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export default ScannerPanel;
