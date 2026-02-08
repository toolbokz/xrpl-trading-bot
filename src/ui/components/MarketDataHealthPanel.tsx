/**
 * MarketDataHealthPanel - compact horizontal data-health status strip.
 */

'use client';

import { useMarketHealth, MarketHealthData } from '../lib/hooks/useMarketHealth';

function formatAge(ageMs: number | null): string {
    if (ageMs === null) return '—';
    if (ageMs < 1000) return '<1s';
    if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
    if (ageMs < 3600_000) return `${Math.round(ageMs / 60_000)}m`;
    return `${Math.round(ageMs / 3600_000)}h`;
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
    const color = !ok ? 'bg-slate-600' : warn ? 'bg-amber-400' : 'bg-emerald-400';
    return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${color} ${warn ? 'animate-pulse' : ''}`} />;
}

function Cell({ label, children, stale, available }: {
    label: string;
    children: React.ReactNode;
    stale?: boolean;
    available?: boolean;
}) {
    return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/[0.03] min-w-0">
            <Dot ok={available !== false} warn={stale === true} />
            <span className="text-[9px] text-slate-500 uppercase tracking-wider shrink-0">{label}</span>
            <div className="flex items-center gap-1 min-w-0 text-[10px] font-mono">
                {children}
            </div>
        </div>
    );
}

function SourceTag({ source }: { source: MarketHealthData['candles']['source'] }) {
    const map: Record<string, string> = {
        live: 'text-emerald-400',
        historical: 'text-blue-400',
        empty: 'text-slate-500',
    };
    return (
        <span className={`text-[9px] font-semibold uppercase ${map[source] ?? 'text-slate-600'}`}>
            {source === 'live' ? 'LIVE' : source === 'historical' ? 'HIST' : source === 'empty' ? '—' : '?'}
        </span>
    );
}

export function MarketDataHealthPanel() {
    const { data, loading, error } = useMarketHealth();

    const healthy = data?.overall.healthy ?? false;
    const warnCount = data?.overall.warnings.length ?? 0;

    return (
        <div className="rounded-lg bg-card/60 border border-white/[0.06] px-2 py-1.5">
            <div className="flex items-center justify-center gap-2 flex-wrap">
                {/* Title + badge */}
                <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Health</span>
                    {!loading && !error && (
                        <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${healthy ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {healthy ? 'OK' : `${warnCount}W`}
                        </span>
                    )}
                </div>

                {loading && <span className="text-[10px] text-slate-500">Loading…</span>}
                {error && <span className="text-[10px] text-red-400">Error</span>}

                {data && !loading && !error && (
                    <>
                        <Cell label="XRPL" available={data.xrpl.connected}>
                            <span className={data.xrpl.connected ? 'text-emerald-400' : 'text-red-400'}>
                                {data.xrpl.connected ? 'Up' : 'Down'}
                            </span>
                        </Cell>
                        <Cell label="Book" stale={data.orderBook.stale} available={data.orderBook.available}>
                            <span className={data.orderBook.stale ? 'text-amber-400' : 'text-slate-300'}>
                                {formatAge(data.orderBook.ageMs)}
                            </span>
                        </Cell>
                        <Cell label="Tape" stale={data.tradeTape.stale} available={data.tradeTape.available}>
                            <span className={data.tradeTape.stale ? 'text-amber-400' : 'text-slate-300'}>
                                {formatAge(data.tradeTape.ageMs)}
                            </span>
                            <span className="text-slate-600">{data.tradeTape.tradeCount5m}/5m</span>
                        </Cell>
                        <Cell label="Candles" stale={data.candles.stale} available={data.candles.source !== 'unknown'}>
                            <span className={data.candles.stale ? 'text-amber-400' : 'text-slate-300'}>
                                {formatAge(data.candles.ageMs)}
                            </span>
                            <SourceTag source={data.candles.source} />
                        </Cell>
                        <Cell label="Net" available={true}>
                            <span className={`text-[9px] font-semibold uppercase ${data.network === 'mainnet' ? 'text-violet-400' : 'text-cyan-400'
                                }`}>
                                {data.network}
                            </span>
                        </Cell>

                        {/* Inline warnings (compact) */}
                        {warnCount > 0 && (
                            <div className="flex items-center gap-1 ml-auto">
                                <span className="text-[9px] text-amber-400">⚠</span>
                                <span className="text-[9px] text-amber-400/80 max-w-[200px] truncate">
                                    {data.overall.warnings[0]}
                                    {warnCount > 1 && ` +${warnCount - 1}`}
                                </span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
