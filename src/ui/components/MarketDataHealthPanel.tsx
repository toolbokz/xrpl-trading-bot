/**
 * MarketDataHealthPanel - displays market data freshness indicators.
 * 
 * Shows:
 * - Order book age
 * - Trade tape age & trade counts
 * - Candles data source
 * - Overall health status with warnings
 */

'use client';

import { useMarketHealth, MarketHealthData } from '../lib/hooks/useMarketHealth';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format age in human-readable format.
 */
function formatAge(ageMs: number | null): string {
    if (ageMs === null) return '—';

    if (ageMs < 1000) return '<1s';
    if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
    if (ageMs < 3600_000) return `${Math.round(ageMs / 60_000)}m`;
    return `${Math.round(ageMs / 3600_000)}h`;
}

/**
 * Get status color class based on staleness.
 */
function getStatusColor(stale: boolean, available: boolean): string {
    if (!available) return 'text-zinc-500';
    if (stale) return 'text-amber-400';
    return 'text-emerald-400';
}

/**
 * Get status indicator dot.
 */
function StatusDot({ stale, available }: { stale: boolean; available: boolean }) {
    const baseClasses = 'inline-block w-2 h-2 rounded-full mr-1.5';
    if (!available) return <span className={`${baseClasses} bg-zinc-600`} />;
    if (stale) return <span className={`${baseClasses} bg-amber-400 animate-pulse`} />;
    return <span className={`${baseClasses} bg-emerald-400`} />;
}

/**
 * Get candles source badge.
 */
function SourceBadge({ source }: { source: MarketHealthData['candles']['source'] }) {
    const baseClasses = 'text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase';

    switch (source) {
        case 'live':
            return (
                <span className={`${baseClasses} bg-emerald-500/20 text-emerald-400 border border-emerald-500/30`}>
                    LIVE
                </span>
            );
        case 'historical':
            return (
                <span className={`${baseClasses} bg-blue-500/20 text-blue-400 border border-blue-500/30`}>
                    HIST
                </span>
            );
        case 'empty':
            return (
                <span className={`${baseClasses} bg-zinc-500/20 text-zinc-400 border border-zinc-500/30`}>
                    EMPTY
                </span>
            );
        default:
            return (
                <span className={`${baseClasses} bg-zinc-700/50 text-zinc-500 border border-zinc-600`}>
                    ?
                </span>
            );
    }
}

// =============================================================================
// Sub-components
// =============================================================================

function HealthRow({
    label,
    value,
    stale,
    available,
    extra,
}: {
    label: string;
    value: string;
    stale: boolean;
    available: boolean;
    extra?: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 flex items-center">
                <StatusDot stale={stale} available={available} />
                {label}
            </span>
            <span className={`font-mono ${getStatusColor(stale, available)}`}>
                {value}
                {extra && <span className="ml-2">{extra}</span>}
            </span>
        </div>
    );
}

function WarningsList({ warnings }: { warnings: string[] }) {
    if (warnings.length === 0) return null;

    return (
        <div className="mt-2 pt-2 border-t border-zinc-700/50">
            <div className="text-[10px] text-amber-400 font-semibold mb-1 flex items-center">
                <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path
                        fillRule="evenodd"
                        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                    />
                </svg>
                WARNINGS
            </div>
            <ul className="space-y-0.5">
                {warnings.map((w, i) => (
                    <li key={i} className="text-[10px] text-amber-300/80 pl-3">
                        • {w}
                    </li>
                ))}
            </ul>
        </div>
    );
}

// =============================================================================
// Main Component
// =============================================================================

export function MarketDataHealthPanel() {
    const { data, loading, error } = useMarketHealth();

    // Overall status indicator
    const overallHealthy = data?.overall.healthy ?? false;
    const warningCount = data?.overall.warnings.length ?? 0;

    return (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center">
                    <svg className="w-3.5 h-3.5 mr-1.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    Data Health
                </h3>
                {/* Overall status badge */}
                {!loading && !error && (
                    <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded ${overallHealthy
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            }`}
                    >
                        {overallHealthy ? 'HEALTHY' : `${warningCount} WARN`}
                    </span>
                )}
            </div>

            {/* Loading state */}
            {loading && (
                <div className="text-xs text-zinc-500 flex items-center">
                    <svg className="animate-spin h-3 w-3 mr-2" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                    </svg>
                    Loading...
                </div>
            )}

            {/* Error state */}
            {error && (
                <div className="text-xs text-red-400">
                    <span className="font-semibold">Error:</span> {error}
                </div>
            )}

            {/* Health metrics */}
            {data && !loading && !error && (
                <div className="space-y-2">
                    {/* XRPL Connection */}
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-zinc-500 flex items-center">
                            <StatusDot stale={!data.xrpl.connected} available={true} />
                            XRPL
                        </span>
                        <span className="flex items-center gap-2">
                            <span className={`font-mono ${data.xrpl.connected ? 'text-emerald-400' : 'text-red-400'}`}>
                                {data.xrpl.connected ? 'Connected' : 'Disconnected'}
                            </span>
                            {data.xrpl.reconnects > 0 && (
                                <span className="text-[10px] text-zinc-500">
                                    ({data.xrpl.reconnects} reconn)
                                </span>
                            )}
                        </span>
                    </div>

                    {/* Endpoint info (truncated) */}
                    {data.xrpl.endpoint && (
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-zinc-500 pl-3.5">Endpoint</span>
                            <span className="font-mono text-zinc-400 text-[10px] truncate max-w-[120px]" title={data.xrpl.endpoint}>
                                {data.xrpl.endpoint.replace('wss://', '').split('/')[0]}
                            </span>
                        </div>
                    )}

                    {/* Order Book */}
                    <HealthRow
                        label="Order Book"
                        value={formatAge(data.orderBook.ageMs)}
                        stale={data.orderBook.stale}
                        available={data.orderBook.available}
                    />

                    {/* Trade Tape */}
                    <HealthRow
                        label="Trade Tape"
                        value={formatAge(data.tradeTape.ageMs)}
                        stale={data.tradeTape.stale}
                        available={data.tradeTape.available}
                        extra={
                            <span className="text-zinc-500 text-[10px]">
                                ({data.tradeTape.tradeCount5m} / 5m)
                            </span>
                        }
                    />

                    {/* Candles */}
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-zinc-500 flex items-center">
                            <StatusDot stale={data.candles.stale} available={data.candles.source !== 'unknown'} />
                            Candles
                        </span>
                        <span className="flex items-center gap-2">
                            <span className={`font-mono ${getStatusColor(data.candles.stale, data.candles.source !== 'unknown')}`}>
                                {formatAge(data.candles.ageMs)}
                            </span>
                            <SourceBadge source={data.candles.source} />
                        </span>
                    </div>

                    {/* Network badge */}
                    <div className="flex items-center justify-between text-xs mt-1 pt-1 border-t border-zinc-800/50">
                        <span className="text-zinc-500">Network</span>
                        <span
                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase ${data.network === 'mainnet'
                                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/30'
                                    : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                }`}
                        >
                            {data.network}
                        </span>
                    </div>

                    {/* Warnings */}
                    <WarningsList warnings={data.overall.warnings} />
                </div>
            )}
        </div>
    );
}
