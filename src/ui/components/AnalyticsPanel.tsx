/**
 * Analytics Panel Component
 * 
 * Displays trading analytics including win rate, profit factor, expectancy,
 * slippage metrics, and regime performance matrix.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart3, TrendingUp, AlertTriangle, Activity, Target, Percent, Grid3X3 } from 'lucide-react';
import clsx from 'clsx';
import {
    ResponsiveContainer,
    AreaChart,
    Area,
    XAxis,
    YAxis,
} from 'recharts';

// ─────────────────────────────────────────────────────────────────────────────
// Types (matching API response)
// ─────────────────────────────────────────────────────────────────────────────

interface AnalyticsSummary {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
    expectancy: number;
    avgSlippageBps: number;
    totalPnlApprox: number;
    maxDrawdown: number;
    avgEdgeBps: number;
}

interface RegimeStats {
    regime: string;
    trades: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
    avgSlippageBps: number;
}

interface StrategyStats {
    strategy: string;
    trades: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
}

interface AnalyticsApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        sinceMs: number | null;
    };
    summary: AnalyticsSummary;
    byRegime: RegimeStats[];
    byStrategy: StrategyStats[];
}

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';

interface HeatmapCellData {
    regime: FlowRegime;
    trades: number;
    winRate: number;
    profitFactor: number;
    score: number;
}

interface StrategyHeatmap {
    perStrategy: Record<string, Record<FlowRegime, HeatmapCellData>>;
}

const ALL_REGIMES: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];

const REGIME_SHORT: Record<FlowRegime, string> = {
    quiet: 'Qt',
    normal: 'Nm',
    trendingUp: '↑',
    trendingDown: '↓',
    chaotic: 'Ch',
    illiquid: 'Il',
};

function scoreColor(score: number): string {
    if (score >= 2) return 'bg-emerald-600/60 text-emerald-200';
    if (score >= 0.5) return 'bg-emerald-700/40 text-emerald-300';
    if (score >= -0.5) return 'bg-slate-700/50 text-slate-300';
    if (score >= -2) return 'bg-amber-700/40 text-amber-300';
    return 'bg-red-700/40 text-red-300';
}

// ─────────────────────────────────────────────────────────────────────────────
// Regime Display Config
// ─────────────────────────────────────────────────────────────────────────────

const REGIME_LABELS: Record<string, { label: string; color: string }> = {
    quiet: { label: 'Quiet', color: 'text-slate-400' },
    normal: { label: 'Normal', color: 'text-emerald-400' },
    trendingUp: { label: 'Up Trend', color: 'text-blue-400' },
    trendingDown: { label: 'Down Trend', color: 'text-amber-400' },
    chaotic: { label: 'Chaotic', color: 'text-red-400' },
    illiquid: { label: 'Illiquid', color: 'text-red-500' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Components
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
    label,
    value,
    suffix = '',
    positive,
    icon: Icon
}: {
    label: string;
    value: string | number;
    suffix?: string;
    positive?: boolean | null;
    icon?: typeof Activity;
}) {
    return (
        <div className="bg-white/5 rounded p-3 border border-white/5">
            <div className="flex items-center gap-1 mb-1">
                {Icon && <Icon size={10} className="text-slate-500" />}
                <span className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</span>
            </div>
            <div className={clsx(
                'text-sm font-mono font-medium',
                positive === true && 'text-emerald-400',
                positive === false && 'text-red-400',
                positive === null && 'text-slate-300'
            )}>
                {value}{suffix}
            </div>
        </div>
    );
}

function ProgressBar({ value, max, color = 'bg-sky-500' }: { value: number; max: number; color?: string }) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    return (
        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
                className={clsx('h-full rounded-full transition-all', color)}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// History buffer for rolling charts
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ANALYTICS_HISTORY = 30;

interface AnalyticsHistoryEntry {
    ts: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
}

/**
 * Mini equity / win-rate area chart (recharts)
 */
function MiniEquityChart({ history }: { history: AnalyticsHistoryEntry[] }) {
    if (history.length < 3) return null;

    const chartData = history.map((h, i) => ({
        idx: i,
        pnl: h.totalPnl,
        wr: h.winRate * 100,
    }));

    const isPositive = chartData[chartData.length - 1]!.pnl >= 0;

    return (
        <div className="bg-white/5 rounded p-2 border border-white/5">
            <div className="flex items-center justify-between mb-0.5">
                <span className="text-[9px] text-slate-500 uppercase tracking-wider">Equity</span>
                <span className={clsx(
                    'text-[10px] font-mono',
                    isPositive ? 'text-emerald-400' : 'text-red-400',
                )}>
                    {isPositive ? '+' : ''}{chartData[chartData.length - 1]!.pnl.toFixed(4)}
                </span>
            </div>
            <ResponsiveContainer width="100%" height={40}>
                <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                    <defs>
                        <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <Area
                        type="monotone"
                        dataKey="pnl"
                        stroke={isPositive ? '#22c55e' : '#ef4444'}
                        strokeWidth={1.5}
                        fill="url(#equityGrad)"
                        dot={false}
                        isAnimationActive={false}
                    />
                    <XAxis hide dataKey="idx" />
                    <YAxis hide domain={['dataMin', 'dataMax']} />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

interface AnalyticsPanelProps {
    /** Polling interval in ms (default: 15000) */
    pollInterval?: number;
    /** Trading pair to filter (optional) */
    pairKey?: string;
}

export function AnalyticsPanel({ pollInterval = 15000, pairKey }: AnalyticsPanelProps) {
    const [data, setData] = useState<AnalyticsApiResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const analyticsHistoryRef = useRef<AnalyticsHistoryEntry[]>([]);
    const [analyticsHistory, setAnalyticsHistory] = useState<AnalyticsHistoryEntry[]>([]);
    const [strategyHeatmap, setStrategyHeatmap] = useState<StrategyHeatmap | null>(null);

    const fetchAnalytics = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (pairKey) params.set('pair', pairKey);

            const url = `/api/analytics/summary${params.toString() ? `?${params}` : ''}`;
            const res = await fetch(url);

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const json: AnalyticsApiResponse = await res.json();
            setData(json);
            setError(null);

            // Accumulate history for equity curve
            if (json.summary.trades > 0) {
                const entry: AnalyticsHistoryEntry = {
                    ts: Date.now(),
                    winRate: json.summary.winRate,
                    totalPnl: json.summary.totalPnlApprox,
                    profitFactor: json.summary.profitFactor,
                };
                const next = [...analyticsHistoryRef.current, entry].slice(-MAX_ANALYTICS_HISTORY);
                analyticsHistoryRef.current = next;
                setAnalyticsHistory(next);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch analytics');
        } finally {
            setLoading(false);
        }
    }, [pairKey]);

    const fetchHeatmap = useCallback(async () => {
        try {
            const res = await fetch('/api/analytics/regimes/heatmap?hours=24&minTrades=5');
            if (res.ok) {
                const json = await res.json();
                setStrategyHeatmap(json.heatmap ?? null);
            }
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        fetchAnalytics();
        fetchHeatmap();
        const interval = setInterval(fetchAnalytics, pollInterval);
        const heatmapInterval = setInterval(fetchHeatmap, 30000);
        return () => { clearInterval(interval); clearInterval(heatmapInterval); };
    }, [fetchAnalytics, fetchHeatmap, pollInterval]);

    // Loading state
    if (loading && !data) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-1.5 p-2.5 border-b border-white/5">
                    <BarChart3 size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-200">Analytics</span>
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex items-center gap-1.5 text-slate-500 text-[10px]">
                        <Activity size={12} className="animate-pulse" />
                        <span>Loading…</span>
                    </div>
                </div>
            </div>
        );
    }

    // Error state
    if (error && !data) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-1.5 p-2.5 border-b border-white/5">
                    <BarChart3 size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-200">Analytics</span>
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex items-center gap-1.5 text-danger text-[10px]">
                        <AlertTriangle size={10} />
                        <span>{error}</span>
                    </div>
                </div>
            </div>
        );
    }

    // No data state
    if (!data || data.summary.trades === 0) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-1.5 p-2.5 border-b border-white/5">
                    <BarChart3 size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-200">Analytics</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-3 text-center">
                    <BarChart3 size={20} className="text-slate-600 mb-1" />
                    <p className="text-[11px] text-slate-400">No trade data yet</p>
                    <p className="text-[10px] text-slate-500">Analytics appear after trades execute</p>
                </div>
            </div>
        );
    }

    const { summary, byRegime, byStrategy } = data;

    return (
        <div className="card h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-white/5 shrink-0">
                <div className="flex items-center gap-1.5">
                    <BarChart3 size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-200">Analytics</span>
                </div>
                <span className="text-[9px] text-slate-500">
                    {summary.trades} trades
                </span>
            </div>

            {/* Content - scrollable */}
            <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
                {/* Key Metrics */}
                <div className="grid grid-cols-2 gap-2">
                    <StatCard
                        label="Win Rate"
                        value={(summary.winRate * 100).toFixed(1)}
                        suffix="%"
                        positive={summary.winRate > 0.5 ? true : summary.winRate < 0.4 ? false : null}
                        icon={Percent}
                    />
                    <StatCard
                        label="Profit Factor"
                        value={summary.profitFactor === Infinity ? '∞' : summary.profitFactor.toFixed(2)}
                        positive={summary.profitFactor > 1 ? true : summary.profitFactor < 1 ? false : null}
                        icon={TrendingUp}
                    />
                    <StatCard
                        label="Expectancy"
                        value={summary.expectancy.toFixed(4)}
                        positive={summary.expectancy > 0 ? true : summary.expectancy < 0 ? false : null}
                        icon={Target}
                    />
                    <StatCard
                        label="Avg Slippage"
                        value={summary.avgSlippageBps.toFixed(1)}
                        suffix=" bps"
                        positive={summary.avgSlippageBps < 5 ? true : summary.avgSlippageBps > 20 ? false : null}
                        icon={Activity}
                    />
                </div>

                {/* Max Drawdown */}
                <div className="bg-white/5 rounded p-2 border border-white/5">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] text-slate-500 uppercase tracking-wider">Max Drawdown</span>
                        <span className={clsx(
                            'text-xs font-mono',
                            summary.maxDrawdown > 0.1 ? 'text-red-400' : 'text-slate-300'
                        )}>
                            {(summary.maxDrawdown * 100).toFixed(1)}%
                        </span>
                    </div>
                    <ProgressBar
                        value={summary.maxDrawdown * 100}
                        max={50}
                        color={summary.maxDrawdown > 0.1 ? 'bg-red-500' : 'bg-slate-400'}
                    />
                </div>

                {/* Equity Curve (rolling) */}
                <MiniEquityChart history={analyticsHistory} />

                {/* Regime Matrix */}
                <div>
                    <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">By Regime</div>
                    <div className="space-y-1">
                        {byRegime.filter(r => r.trades > 0).map(regime => {
                            const config = REGIME_LABELS[regime.regime] || { label: regime.regime, color: 'text-slate-400' };
                            return (
                                <div
                                    key={regime.regime}
                                    className="flex items-center justify-between text-[11px] bg-white/5 rounded px-2 py-1"
                                >
                                    <span className={config.color}>{config.label}</span>
                                    <div className="flex items-center gap-2 text-slate-400">
                                        <span className="text-[10px]">{regime.trades}</span>
                                        <span className={clsx(
                                            'font-mono',
                                            regime.winRate > 0.5 ? 'text-emerald-400' : regime.winRate < 0.4 ? 'text-red-400' : ''
                                        )}>
                                            {(regime.winRate * 100).toFixed(0)}%
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                        {byRegime.filter(r => r.trades > 0).length === 0 && (
                            <div className="text-[10px] text-slate-500 text-center py-1">No regime data</div>
                        )}
                    </div>
                </div>

                {/* Strategy Stats */}
                {byStrategy.length > 0 && (
                    <div>
                        <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">By Strategy</div>
                        <div className="space-y-1">
                            {byStrategy.map(strat => (
                                <div
                                    key={strat.strategy}
                                    className="flex items-center justify-between text-[11px] bg-white/5 rounded px-2 py-1"
                                >
                                    <span className="text-slate-300 truncate max-w-[90px]">{strat.strategy}</span>
                                    <div className="flex items-center gap-2 text-slate-400">
                                        <span className="text-[10px]">{strat.trades}</span>
                                        <span className={clsx(
                                            'font-mono',
                                            strat.winRate > 0.5 ? 'text-emerald-400' : strat.winRate < 0.4 ? 'text-red-400' : ''
                                        )}>
                                            {(strat.winRate * 100).toFixed(0)}%
                                        </span>
                                        <span className={clsx(
                                            'font-mono',
                                            strat.profitFactor > 1 ? 'text-emerald-400' : 'text-red-400'
                                        )}>
                                            {strat.profitFactor === Infinity ? '∞' : strat.profitFactor.toFixed(1)}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Win/Loss Bar */}
                <div className="bg-white/5 rounded p-2 border border-white/5">
                    <div className="flex items-center justify-between text-[10px] mb-1.5">
                        <span className="text-emerald-400">{summary.wins} W</span>
                        <span className="text-slate-500">
                            {summary.trades > 0
                                ? `${((summary.wins / summary.trades) * 100).toFixed(0)}% / ${((summary.losses / summary.trades) * 100).toFixed(0)}%`
                                : '—'}
                        </span>
                        <span className="text-red-400">{summary.losses} L</span>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden flex">
                        {summary.trades > 0 && (
                            <>
                                <div
                                    className="h-full bg-emerald-500 transition-all"
                                    style={{ width: `${(summary.wins / summary.trades) * 100}%` }}
                                />
                                <div
                                    className="h-full bg-red-500 transition-all"
                                    style={{ width: `${(summary.losses / summary.trades) * 100}%` }}
                                />
                            </>
                        )}
                    </div>
                </div>

                {/* Strategy × Regime Heatmap */}
                {strategyHeatmap && Object.keys(strategyHeatmap.perStrategy).length > 0 && (
                    <div>
                        <div className="flex items-center gap-1 text-[9px] text-slate-500 uppercase tracking-wider mb-1">
                            <Grid3X3 size={9} />
                            <span>Strategy × Regime</span>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="text-[9px] w-full">
                                <thead>
                                    <tr className="text-slate-500">
                                        <th className="text-left font-normal pr-1"></th>
                                        {ALL_REGIMES.map(r => (
                                            <th key={r} className="font-normal text-center px-0.5">{REGIME_SHORT[r]}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {Object.entries(strategyHeatmap.perStrategy).map(([strategy, regimes]) => (
                                        <tr key={strategy}>
                                            <td className="text-slate-400 truncate max-w-[60px] pr-1">{strategy}</td>
                                            {ALL_REGIMES.map(regime => {
                                                const cell = regimes[regime];
                                                if (!cell || cell.trades < 1) {
                                                    return <td key={regime} className="px-0.5 py-0.5"><div className="rounded text-center bg-slate-700/30 text-slate-600 px-1">-</div></td>;
                                                }
                                                return (
                                                    <td key={regime} className="px-0.5 py-0.5">
                                                        <div className={clsx('rounded text-center px-1 font-mono', scoreColor(cell.score))}>
                                                            {cell.score.toFixed(1)}
                                                        </div>
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="text-[9px] text-slate-600 text-right px-3 py-1.5 border-t border-white/5 shrink-0">
                Updated: {data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : 'N/A'}
            </div>
        </div>
    );
}

export default AnalyticsPanel;
