'use client';

import { useEffect, useState, useCallback } from 'react';
import { Shield, AlertTriangle, AlertOctagon, Pause, CheckCircle, RefreshCw, TrendingDown, Target, BarChart3, Clock } from 'lucide-react';
import clsx from 'clsx';

/**
 * Governance state from API
 */
interface GovernanceState {
    mode: 'ALLOW' | 'THROTTLE' | 'PAUSE' | 'SHUTDOWN';
    reasons: string[];
    metrics: {
        tradesCount: number;
        profitFactor: number;
        expectancyBps: number;
        drawdownPct: number;
        avgSlippageBps: number;
        partialFillRate: number;
        winRate: number;
        consecutiveFailures: number;
    } | null;
    thresholds: {
        minTrades: number;
        maxDrawdownPct: number;
        minProfitFactor: number;
        minExpectancyBps: number;
        maxAvgSlippageBps: number;
        maxPartialFillRate: number;
        consecFailShutdown: number;
    } | null;
    sizeMultiplier: number;
    cooldownMs: number;
    evaluatedAt: string | null;
}

interface GovernanceApiResponse {
    requestId: string;
    timestamp: string;
    available: boolean;
    state: GovernanceState | null;
}

const modeConfig = {
    ALLOW: {
        icon: CheckCircle,
        label: 'Normal',
        description: 'All strategies operating normally',
        tone: 'success' as const,
        bgClass: 'bg-success/10 border-success/30',
        textClass: 'text-success',
    },
    THROTTLE: {
        icon: TrendingDown,
        label: 'Throttled',
        description: 'Position sizes reduced, cooldown active',
        tone: 'warning' as const,
        bgClass: 'bg-amber-500/10 border-amber-500/30',
        textClass: 'text-amber-400',
    },
    PAUSE: {
        icon: Pause,
        label: 'Paused',
        description: 'Strategy execution suspended',
        tone: 'warning' as const,
        bgClass: 'bg-amber-500/10 border-amber-500/30',
        textClass: 'text-amber-400',
    },
    SHUTDOWN: {
        icon: AlertOctagon,
        label: 'SHUTDOWN',
        description: 'Emergency halt - manual intervention required',
        tone: 'danger' as const,
        bgClass: 'bg-danger/10 border-danger/30',
        textClass: 'text-danger',
    },
};

function MetricBar({
    label,
    value,
    threshold,
    format,
    inverse = false,
    icon: Icon,
}: {
    label: string;
    value: number;
    threshold: number;
    format: (v: number) => string;
    inverse?: boolean;
    icon: typeof Target;
}) {
    // For "inverse" metrics, lower is better (drawdown, slippage, partial fills)
    // For normal metrics, higher is better (PF, expectancy, win rate)
    const isBreach = inverse ? value > threshold : value < threshold;
    const percentage = inverse
        ? Math.min(100, (value / threshold) * 100)
        : Math.min(100, (value / (threshold * 2)) * 100);

    return (
        <div className="space-y-1">
            <div className="flex justify-between text-xs">
                <span className="flex items-center gap-1.5 text-slate-400">
                    <Icon size={12} />
                    {label}
                </span>
                <span className={clsx(isBreach ? 'text-danger' : 'text-slate-200')}>
                    {format(value)}
                    <span className="text-slate-500 ml-1">
                        ({inverse ? '≤' : '≥'} {format(threshold)})
                    </span>
                </span>
            </div>
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                    className={clsx(
                        'h-full rounded-full transition-all duration-300',
                        isBreach ? 'bg-danger' : 'bg-success'
                    )}
                    style={{ width: `${percentage}%` }}
                />
            </div>
        </div>
    );
}

export function GovernancePanel() {
    const [state, setState] = useState<GovernanceState | null>(null);
    const [available, setAvailable] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

    const fetchGovernanceState = useCallback(async () => {
        try {
            const res = await fetch('/api/analytics/governance/state');
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data: GovernanceApiResponse = await res.json();
            setAvailable(data.available);
            setState(data.state);
            setLastUpdate(new Date());
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchGovernanceState();
        const interval = setInterval(fetchGovernanceState, 5000); // Poll every 5s
        return () => clearInterval(interval);
    }, [fetchGovernanceState]);

    if (loading) {
        return (
            <div className="card p-6">
                <div className="flex items-center gap-2 text-slate-400">
                    <RefreshCw className="animate-spin" size={16} />
                    <span>Loading governance state...</span>
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

    if (!available || !state) {
        return (
            <div className="card p-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-white/5">
                        <Shield size={20} className="text-slate-400" />
                    </div>
                    <div>
                        <h3 className="font-medium text-slate-200">Capital Protection</h3>
                        <p className="text-sm text-slate-400">Bot not running or governance unavailable</p>
                    </div>
                </div>
            </div>
        );
    }

    const config = modeConfig[state.mode];
    const ModeIcon = config.icon;

    return (
        <div className={clsx('card p-6 border', config.bgClass)}>
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className={clsx('p-2 rounded-lg', config.bgClass)}>
                        <ModeIcon size={20} className={config.textClass} />
                    </div>
                    <div>
                        <h3 className="font-medium text-slate-200">Capital Protection</h3>
                        <p className={clsx('text-sm', config.textClass)}>{config.label}</p>
                    </div>
                </div>
                <div className="text-right">
                    {state.sizeMultiplier < 1 && (
                        <div className="text-sm text-amber-400">
                            Size: {(state.sizeMultiplier * 100).toFixed(0)}%
                        </div>
                    )}
                    {state.cooldownMs > 0 && (
                        <div className="text-xs text-slate-400">
                            Cooldown: {(state.cooldownMs / 1000).toFixed(1)}s
                        </div>
                    )}
                </div>
            </div>

            {/* Reasons */}
            {state.reasons.length > 0 && (
                <div className="mb-4 p-3 rounded-lg bg-black/20 space-y-1">
                    {state.reasons.map((reason, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm">
                            <AlertTriangle size={14} className={clsx('mt-0.5 flex-shrink-0', config.textClass)} />
                            <span className="text-slate-300">{reason}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Metrics */}
            {state.metrics && state.thresholds && state.metrics.tradesCount >= state.thresholds.minTrades && (
                <div className="space-y-3">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">
                        Rolling Metrics ({state.metrics.tradesCount} trades)
                    </div>

                    <MetricBar
                        label="Drawdown"
                        value={state.metrics.drawdownPct}
                        threshold={state.thresholds.maxDrawdownPct}
                        format={(v) => `${v.toFixed(1)}%`}
                        inverse={true}
                        icon={TrendingDown}
                    />

                    <MetricBar
                        label="Profit Factor"
                        value={state.metrics.profitFactor}
                        threshold={state.thresholds.minProfitFactor}
                        format={(v) => v.toFixed(2)}
                        inverse={false}
                        icon={Target}
                    />

                    <MetricBar
                        label="Expectancy"
                        value={state.metrics.expectancyBps}
                        threshold={state.thresholds.minExpectancyBps}
                        format={(v) => `${v.toFixed(1)} bps`}
                        inverse={false}
                        icon={BarChart3}
                    />

                    <MetricBar
                        label="Avg Slippage"
                        value={state.metrics.avgSlippageBps}
                        threshold={state.thresholds.maxAvgSlippageBps}
                        format={(v) => `${v.toFixed(1)} bps`}
                        inverse={true}
                        icon={Clock}
                    />

                    {/* Additional metrics as text */}
                    <div className="grid grid-cols-3 gap-4 pt-2 border-t border-white/5">
                        <div className="text-center">
                            <div className="text-xs text-slate-400">Win Rate</div>
                            <div className="text-sm text-slate-200">{(state.metrics.winRate * 100).toFixed(1)}%</div>
                        </div>
                        <div className="text-center">
                            <div className="text-xs text-slate-400">Partial Fills</div>
                            <div className={clsx(
                                'text-sm',
                                state.metrics.partialFillRate > state.thresholds.maxPartialFillRate
                                    ? 'text-danger'
                                    : 'text-slate-200'
                            )}>
                                {(state.metrics.partialFillRate * 100).toFixed(1)}%
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-xs text-slate-400">Consec. Fails</div>
                            <div className={clsx(
                                'text-sm',
                                state.metrics.consecutiveFailures >= state.thresholds.consecFailShutdown
                                    ? 'text-danger'
                                    : 'text-slate-200'
                            )}>
                                {state.metrics.consecutiveFailures}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Insufficient data notice */}
            {state.metrics && state.thresholds && state.metrics.tradesCount < state.thresholds.minTrades && (
                <div className="text-sm text-slate-400 text-center py-4">
                    Collecting data... {state.metrics.tradesCount}/{state.thresholds.minTrades} trades
                </div>
            )}

            {/* Footer */}
            {lastUpdate && (
                <div className="mt-4 pt-3 border-t border-white/5 flex justify-between text-xs text-slate-500">
                    <span>Last check: {lastUpdate.toLocaleTimeString()}</span>
                    {state.evaluatedAt && (
                        <span>Evaluated: {new Date(state.evaluatedAt).toLocaleTimeString()}</span>
                    )}
                </div>
            )}
        </div>
    );
}
