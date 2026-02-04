'use client';

import { useEffect, useState, useCallback } from 'react';
import {
    Grid3X3,
    RefreshCw,
    AlertTriangle,
    TrendingUp,
    TrendingDown,
    Minus,
    Ban,
    CheckCircle,
    Zap,
    Activity,
    Scale,
} from 'lucide-react';
import clsx from 'clsx';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';

interface RegimeHeatmapCell {
    regime: FlowRegime;
    trades: number;
    winRate: number;
    profitFactor: number;
    expectancyBps: number;
    avgEdgeBps: number;
    avgSlippageBps: number;
    avgSpreadBps: number;
    partialFillRate: number;
    score: number;
}

interface RegimeHeatmapResponse {
    global: Record<FlowRegime, RegimeHeatmapCell>;
    perStrategy: Record<string, Record<FlowRegime, RegimeHeatmapCell>>;
    meta: {
        lookbackHours: number;
        minTrades: number;
        totalTrades: number;
        computedAt: number;
    };
}

interface RegimeSizePolicy {
    multiplier: number;
    smoothedScore: number;
    rawScore: number;
    trades: number;
}

interface StrategyRegimePolicy {
    disabledRegimes: FlowRegime[];
    sizeByRegime: Record<FlowRegime, RegimeSizePolicy>;
}

interface RegimePolicy {
    updatedAt: number;
    lookbackHours: number;
    global: StrategyRegimePolicy;
    strategies: Record<string, StrategyRegimePolicy>;
    reasons: string[];
    stats: {
        totalTrades: number;
        regimeCounts: Record<FlowRegime, number>;
        computedAt: number;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ALL_REGIMES: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];

const regimeLabels: Record<FlowRegime, string> = {
    quiet: 'Quiet',
    normal: 'Normal',
    trendingUp: 'Trend ↑',
    trendingDown: 'Trend ↓',
    chaotic: 'Chaotic',
    illiquid: 'Illiquid',
};

const regimeIcons: Record<FlowRegime, typeof Activity> = {
    quiet: Minus,
    normal: CheckCircle,
    trendingUp: TrendingUp,
    trendingDown: TrendingDown,
    chaotic: Zap,
    illiquid: Ban,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get color class based on score
 */
function getScoreColor(score: number): string {
    if (score >= 10) return 'bg-emerald-500/80 text-white';
    if (score >= 5) return 'bg-emerald-500/50 text-white';
    if (score >= 0) return 'bg-emerald-500/20 text-emerald-300';
    if (score >= -5) return 'bg-red-500/20 text-red-300';
    if (score >= -10) return 'bg-red-500/50 text-white';
    return 'bg-red-500/80 text-white';
}

/**
 * Format number for display
 */
function formatValue(value: number, decimals: number = 1): string {
    return value.toFixed(decimals);
}

// ─────────────────────────────────────────────────────────────────────────────
// Heatmap Cell Component
// ─────────────────────────────────────────────────────────────────────────────

function HeatmapCell({
    cell,
    isDisabled,
    showMetric,
}: {
    cell: RegimeHeatmapCell;
    isDisabled: boolean;
    showMetric: 'score' | 'expectancyBps';
}) {
    const value = showMetric === 'score' ? cell.score : cell.expectancyBps;
    const colorClass = isDisabled ? 'bg-slate-700/50 text-slate-500' : getScoreColor(cell.score);

    return (
        <div
            className={clsx(
                'relative p-2 rounded text-center transition-all group cursor-pointer min-w-[60px]',
                colorClass,
                isDisabled && 'opacity-60'
            )}
            title={`${cell.regime}: ${cell.trades} trades, WR: ${(cell.winRate * 100).toFixed(0)}%, PF: ${cell.profitFactor.toFixed(2)}`}
        >
            <div className="text-sm font-medium">
                {cell.trades < 1 ? '-' : formatValue(value, 1)}
            </div>
            <div className="text-[10px] opacity-70">{cell.trades}t</div>
            {isDisabled && (
                <div className="absolute inset-0 flex items-center justify-center">
                    <Ban size={16} className="text-slate-400" />
                </div>
            )}

            {/* Tooltip on hover */}
            <div className="absolute z-10 hidden group-hover:block bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-48 p-2 bg-slate-800 border border-slate-700 rounded shadow-lg text-left text-xs">
                <div className="font-medium text-slate-200 mb-1">{regimeLabels[cell.regime]}</div>
                <div className="grid grid-cols-2 gap-1 text-slate-400">
                    <span>Trades:</span>
                    <span className="text-slate-200">{cell.trades}</span>
                    <span>Win Rate:</span>
                    <span className="text-slate-200">{(cell.winRate * 100).toFixed(1)}%</span>
                    <span>PF:</span>
                    <span className="text-slate-200">{cell.profitFactor.toFixed(2)}</span>
                    <span>Expectancy:</span>
                    <span className="text-slate-200">{cell.expectancyBps.toFixed(1)} bps</span>
                    <span>Score:</span>
                    <span className={cell.score >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {cell.score.toFixed(1)}
                    </span>
                    <span>Slippage:</span>
                    <span className="text-slate-200">{cell.avgSlippageBps.toFixed(1)} bps</span>
                    <span>Spread:</span>
                    <span className="text-slate-200">{cell.avgSpreadBps.toFixed(1)} bps</span>
                    <span>Partial:</span>
                    <span className="text-slate-200">{(cell.partialFillRate * 100).toFixed(0)}%</span>
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function RegimeHeatmapPanel() {
    const [heatmap, setHeatmap] = useState<RegimeHeatmapResponse | null>(null);
    const [policy, setPolicy] = useState<RegimePolicy | null>(null);
    const [loading, setLoading] = useState(true);
    const [recomputing, setRecomputing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showMetric, setShowMetric] = useState<'score' | 'expectancyBps'>('score');

    const fetchData = useCallback(async () => {
        try {
            const [heatmapRes, policyRes] = await Promise.all([
                fetch('/api/analytics/regimes/heatmap?hours=24&minTrades=5'),
                fetch('/api/analytics/regimes/policy'),
            ]);

            if (!heatmapRes.ok) throw new Error(`Heatmap: HTTP ${heatmapRes.status}`);
            if (!policyRes.ok) throw new Error(`Policy: HTTP ${policyRes.status}`);

            const heatmapData = await heatmapRes.json();
            const policyData = await policyRes.json();

            setHeatmap(heatmapData.heatmap);
            setPolicy(policyData.policy);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch');
        } finally {
            setLoading(false);
        }
    }, []);

    const handleRecompute = useCallback(async () => {
        setRecomputing(true);
        try {
            const res = await fetch('/api/analytics/regimes/recompute', { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.policy) {
                setPolicy(data.policy);
            }
            // Refresh heatmap too
            await fetchData();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to recompute');
        } finally {
            setRecomputing(false);
        }
    }, [fetchData]);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 30000); // Poll every 30s
        return () => clearInterval(interval);
    }, [fetchData]);

    // Get list of strategies from heatmap
    const strategies = heatmap ? Object.keys(heatmap.perStrategy) : [];

    // Get disabled regimes from policy
    const getDisabledRegimes = (strategyName: string | null): Set<FlowRegime> => {
        if (!policy) return new Set();
        const disabled = new Set<FlowRegime>(policy.global.disabledRegimes);
        if (strategyName) {
            const strategyPolicy = policy.strategies[strategyName];
            if (strategyPolicy) {
                strategyPolicy.disabledRegimes.forEach(r => disabled.add(r));
            }
        }
        return disabled;
    };

    const globalDisabled = getDisabledRegimes(null);

    if (loading) {
        return (
            <div className="card p-6">
                <div className="flex items-center gap-2 text-slate-400">
                    <RefreshCw className="animate-spin" size={16} />
                    <span>Loading regime heatmap...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="card p-6 border-danger/30">
                <div className="flex items-center gap-2 text-danger">
                    <AlertTriangle size={16} />
                    <span>Error: {error}</span>
                </div>
            </div>
        );
    }

    if (!heatmap) {
        return (
            <div className="card p-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-white/5">
                        <Grid3X3 size={20} className="text-slate-400" />
                    </div>
                    <div>
                        <h3 className="font-medium text-slate-200">Regime Heatmap</h3>
                        <p className="text-sm text-slate-400">No data available</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="card flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-indigo-500/10">
                        <Grid3X3 size={20} className="text-indigo-400" />
                    </div>
                    <div>
                        <h3 className="font-medium text-slate-200">Regime Performance</h3>
                        <p className="text-xs text-slate-400">
                            {heatmap.meta.totalTrades} trades • {heatmap.meta.lookbackHours}h window
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* Metric Toggle */}
                    <div className="flex rounded bg-white/5 p-0.5">
                        <button
                            onClick={() => setShowMetric('score')}
                            className={clsx(
                                'px-2 py-1 text-xs rounded transition-colors',
                                showMetric === 'score'
                                    ? 'bg-indigo-500/30 text-indigo-300'
                                    : 'text-slate-400 hover:text-slate-300'
                            )}
                        >
                            Score
                        </button>
                        <button
                            onClick={() => setShowMetric('expectancyBps')}
                            className={clsx(
                                'px-2 py-1 text-xs rounded transition-colors',
                                showMetric === 'expectancyBps'
                                    ? 'bg-indigo-500/30 text-indigo-300'
                                    : 'text-slate-400 hover:text-slate-300'
                            )}
                        >
                            Expectancy
                        </button>
                    </div>

                    {/* Recompute Button */}
                    <button
                        onClick={handleRecompute}
                        disabled={recomputing}
                        className="p-1.5 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
                        title="Recompute policy"
                    >
                        <RefreshCw size={14} className={recomputing ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 pt-0 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {/* Heatmap Grid */}
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="text-slate-400">
                                <th className="text-left p-1 font-normal"></th>
                                {ALL_REGIMES.map(regime => {
                                    const Icon = regimeIcons[regime];
                                    return (
                                        <th key={regime} className="p-1 font-normal text-center">
                                            <div className="flex flex-col items-center gap-0.5">
                                                <Icon size={12} />
                                                <span>{regimeLabels[regime]}</span>
                                            </div>
                                        </th>
                                    );
                                })}
                            </tr>
                        </thead>
                        <tbody>
                            {/* Global Row */}
                            <tr>
                                <td className="p-1 font-medium text-slate-300">Global</td>
                                {ALL_REGIMES.map(regime => (
                                    <td key={regime} className="p-1">
                                        <HeatmapCell
                                            cell={heatmap.global[regime]}
                                            isDisabled={globalDisabled.has(regime)}
                                            showMetric={showMetric}
                                        />
                                    </td>
                                ))}
                            </tr>

                            {/* Strategy Rows */}
                            {strategies.map(strategy => {
                                const strategyDisabled = getDisabledRegimes(strategy);
                                const shortName = strategy.replace('Strategy', '').replace(/-/g, ' ');
                                const strategyData = heatmap.perStrategy[strategy];
                                return (
                                    <tr key={strategy}>
                                        <td className="p-1 text-slate-400 whitespace-nowrap">{shortName}</td>
                                        {ALL_REGIMES.map(regime => {
                                            const cellData = strategyData?.[regime];
                                            return (
                                                <td key={regime} className="p-1">
                                                    {cellData ? (
                                                        <HeatmapCell
                                                            cell={cellData}
                                                            isDisabled={strategyDisabled.has(regime)}
                                                            showMetric={showMetric}
                                                        />
                                                    ) : (
                                                        <div className="relative p-2 rounded text-center min-w-[60px] bg-slate-700/30 text-slate-500">
                                                            <div className="text-sm font-medium">-</div>
                                                            <div className="text-[10px] opacity-70">0t</div>
                                                        </div>
                                                    )}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Policy Section */}
                {policy && (
                    <div className="border-t border-slate-700/50 pt-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                            <Scale size={12} className="text-slate-400" />
                            <span className="text-slate-400">Policy</span>
                            <span className="text-slate-500">•</span>
                            <span className="text-slate-500">
                                Updated {new Date(policy.updatedAt).toLocaleTimeString()}
                            </span>
                        </div>

                        {/* Global Disabled Regimes */}
                        {policy.global.disabledRegimes.length > 0 && (
                            <div className="flex items-center gap-2 text-xs">
                                <Ban size={12} className="text-red-400" />
                                <span className="text-slate-400">Disabled:</span>
                                {policy.global.disabledRegimes.map(regime => (
                                    <span
                                        key={regime}
                                        className="px-1.5 py-0.5 bg-red-500/20 text-red-300 rounded"
                                    >
                                        {regimeLabels[regime]}
                                    </span>
                                ))}
                            </div>
                        )}

                        {/* Size Multipliers (compact) */}
                        <div className="flex flex-wrap gap-1 text-xs">
                            {ALL_REGIMES.map(regime => {
                                const sizePolicy = policy.global.sizeByRegime[regime];
                                if (!sizePolicy || sizePolicy.multiplier === 1.0) return null;
                                return (
                                    <span
                                        key={regime}
                                        className={clsx(
                                            'px-1.5 py-0.5 rounded',
                                            sizePolicy.multiplier < 1
                                                ? 'bg-amber-500/20 text-amber-300'
                                                : 'bg-emerald-500/20 text-emerald-300'
                                        )}
                                    >
                                        {regimeLabels[regime]}: {(sizePolicy.multiplier * 100).toFixed(0)}%
                                    </span>
                                );
                            })}
                        </div>

                        {/* Reasons (last few) */}
                        {policy.reasons.length > 0 && (
                            <div className="text-[10px] text-slate-500 max-h-16 overflow-y-auto">
                                {policy.reasons.slice(-3).map((reason, i) => (
                                    <div key={i}>• {reason}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Legend */}
                <div className="flex items-center justify-center gap-2 text-[10px] text-slate-500 mt-4">
                    <span className="flex items-center gap-1">
                        <div className="w-3 h-3 rounded bg-emerald-500/80" />
                        <span>&gt;10</span>
                    </span>
                    <span className="flex items-center gap-1">
                        <div className="w-3 h-3 rounded bg-emerald-500/20" />
                        <span>0-10</span>
                    </span>
                    <span className="flex items-center gap-1">
                        <div className="w-3 h-3 rounded bg-red-500/20" />
                        <span>0 to -5</span>
                    </span>
                    <span className="flex items-center gap-1">
                        <div className="w-3 h-3 rounded bg-red-500/80" />
                        <span>&lt;-10</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
