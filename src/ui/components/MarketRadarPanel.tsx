'use client';

import { useMemo, useState } from 'react';
import { Radar, ArrowDownUp } from 'lucide-react';
import { Panel, PanelBadge } from './Panel';
import { useRuntimeCache } from '../lib/hooks/useRuntimeCache';
import {
    RadarSortKey,
    sortMarkets,
    toBackgroundView,
    type ScannerMarketItem,
} from './backgroundScannerViewModel';

interface MarketRadarPanelProps {
    pollInterval?: number;
    compact?: boolean;
}

export function MarketRadarPanel({
    pollInterval = 4000,
    compact = false,
}: MarketRadarPanelProps) {
    const { data, loading } = useRuntimeCache({ pollInterval, enabled: true });
    const snapshot = data?.snapshot ?? null;
    const bg = toBackgroundView(snapshot);

    const [sortBy, setSortBy] = useState<RadarSortKey>('stale');

    const rows = useMemo(() => {
        const markets = bg?.markets ?? [];
        return sortMarkets(markets, sortBy).slice(0, 12);
    }, [bg?.markets, sortBy]);
    const rankedBestPairs = useMemo(() => (bg?.crossMarket.bestPairs ?? []).slice(0, 3), [bg?.crossMarket.bestPairs]);

    return (
        <Panel
            title="Market Radar"
            icon={Radar}
            compact={compact}
            className="h-full"
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
            {!bg || rows.length === 0 ? (
                <div className="p-3 text-[11px] text-slate-500">{loading ? 'Updating market radar…' : 'Scanner disabled or warming up.'}</div>
            ) : (
                <div className="h-full overflow-auto">
                    {rankedBestPairs.length > 0 ? (
                        <div className="px-2 py-2 border-b border-white/10">
                            <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Best pairs</div>
                            <div className="grid grid-cols-3 gap-1">
                                {rankedBestPairs.map((item, index) => (
                                    <div key={`${item.pairKey}-${index}`} className="rounded border border-white/10 bg-white/5 px-2 py-1">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="truncate text-[10px] text-slate-300">{item.pairKey}</span>
                                            <span className="text-[10px] font-semibold text-sky-300">{item.score}</span>
                                        </div>
                                        <div className="mt-0.5 text-[9px] text-slate-500">{fmtStale(item.stalenessMs)} / {fmtNum(item.spreadBps, 1)}bps</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    <table className="w-full text-[11px] font-mono">
                        <thead className="sticky top-0 bg-card border-b border-white/10 text-[9px] uppercase tracking-wider text-slate-500">
                            <tr>
                                <th className="text-left px-2 py-1">Pair</th>
                                <th className="text-right px-2 py-1">Mid</th>
                                <th className="text-right px-2 py-1">Spread</th>
                                <th className="text-right px-2 py-1">Depth</th>
                                <th className="text-right px-2 py-1">Stale</th>
                                <th className="text-right px-2 py-1">Verdict</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const staleWarn = row.stalenessMs > 20_000;
                                const spreadWarn = row.spreadBps > 150;
                                return (
                                    <tr key={row.pairKey} className={`border-b border-white/5 ${staleWarn ? 'opacity-70' : ''}`}>
                                        <td className="px-2 py-1 text-slate-300 truncate max-w-[120px]">{row.pairKey}</td>
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
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    );
}

function SortButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] border ${active
                ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
                }`}
        >
            <ArrowDownUp size={10} />
            {label}
        </button>
    );
}

function VerdictBadge({ verdict }: { verdict: string }) {
    const upper = verdict.toUpperCase();
    if (upper === 'AVAILABLE') return <PanelBadge tone="success">OK</PanelBadge>;
    if (upper === 'DEGRADED') return <PanelBadge tone="warning">DEG</PanelBadge>;
    return <PanelBadge tone="neutral">{upper.slice(0, 3)}</PanelBadge>;
}

function fmtNum(v: number, digits: number): string {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(digits);
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

export function sortMarketRadarRows(rows: ScannerMarketItem[], sortBy: RadarSortKey): ScannerMarketItem[] {
    return sortMarkets(rows, sortBy);
}

export default MarketRadarPanel;
