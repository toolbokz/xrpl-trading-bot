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
    const isBreach = inverse ? value > threshold : value < threshold;
    const percentage = inverse
        ? Math.min(100, (value / threshold) * 100)
        : Math.min(100, (value / (threshold * 2)) * 100);

    return (
        <div className="space-y-0.5">
            <div className="flex justify-between text-[10px]">
                <span className="flex items-center gap-1 text-slate-400">
                    <Icon size={10} />
                    {label}
                </span>
                <span className={clsx(isBreach ? 'text-danger' : 'text-slate-200')}>
                    {format(value)}
                    <span className="text-slate-600 ml-1">({inverse ? '≤' : '≥'}{format(threshold)})</span>
                </span>
            </div>
            <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                <div
                    className={clsx('h-full rounded-full transition-all duration-300', isBreach ? 'bg-danger' : 'bg-success')}
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
            <div className="card p-3">
                <div className="flex items-center gap-1.5 text-slate-500 text-[10px]">
                    <RefreshCw className="animate-spin" size={10} />
                    <span>Loading…</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="card p-3 border-danger/30">
                <div className="flex items-center gap-1.5 text-danger text-[10px]">
                    <AlertTriangle size={10} />
                    <span>{error}</span>
                </div>
            </div>
        );
    }

    if (!available || !state) {
        return (
            <div className="card p-3">
                <div className="flex items-center gap-2">
                    <Shield size={12} className="text-slate-500" />
                    <span className="text-[11px] text-slate-400">Capital Protection — unavailable</span>
                </div>
            </div>
        );
    }

    const config = modeConfig[state.mode];
    const ModeIcon = config.icon;

    return (
        <div className={clsx('card border overflow-hidden flex flex-col h-full', config.bgClass)}>
            {/* Header */}
            <div className="flex items-center justify-between px-2.5 py-1.5 shrink-0">
                <div className="flex items-center gap-2">
                    <ModeIcon size={13} className={config.textClass} />
                    <div>
                        <span className="text-[11px] font-semibold text-slate-200">Capital Protection</span>
                        <span className={clsx('text-[9px] ml-1.5 uppercase', config.textClass)}>{config.label}</span>
                    </div>
                </div>
                <div className="flex items-center gap-2 text-[10px]">
                    {state.sizeMultiplier < 1 && (
                        <span className="text-amber-400">×{(state.sizeMultiplier * 100).toFixed(0)}%</span>
                    )}
                    {state.cooldownMs > 0 && (
                        <span className="text-slate-500">{(state.cooldownMs / 1000).toFixed(1)}s cd</span>
                    )}
                </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2 scrollbar-thin">

                {/* Reasons */}
                {state.reasons.length > 0 && (
                    <div className="mb-2 p-2 rounded bg-black/20 space-y-0.5">
                        {state.reasons.map((reason, i) => (
                            <div key={i} className="flex items-start gap-1 text-[10px]">
                                <AlertTriangle size={9} className={clsx('mt-0.5 flex-shrink-0', config.textClass)} />
                                <span className="text-slate-300">{reason}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Metrics */}
                {state.metrics && state.thresholds && state.metrics.tradesCount >= state.thresholds.minTrades && (
                    <div className="space-y-2">
                        <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                            Metrics ({state.metrics.tradesCount} trades)
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

                        <div className="grid grid-cols-3 gap-2 pt-1.5 border-t border-white/5">
                            <div className="text-center">
                                <div className="text-[9px] text-slate-500">Win</div>
                                <div className="text-[11px] text-slate-200 font-mono">{(state.metrics.winRate * 100).toFixed(1)}%</div>
                            </div>
                            <div className="text-center">
                                <div className="text-[9px] text-slate-500">Partials</div>
                                <div className={clsx(
                                    'text-[11px] font-mono',
                                    state.metrics.partialFillRate > state.thresholds.maxPartialFillRate ? 'text-danger' : 'text-slate-200'
                                )}>
                                    {(state.metrics.partialFillRate * 100).toFixed(1)}%
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="text-[9px] text-slate-500">Fails</div>
                                <div className={clsx(
                                    'text-[11px] font-mono',
                                    state.metrics.consecutiveFailures >= state.thresholds.consecFailShutdown ? 'text-danger' : 'text-slate-200'
                                )}>
                                    {state.metrics.consecutiveFailures}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {state.metrics && state.thresholds && state.metrics.tradesCount < state.thresholds.minTrades && (
                    <div className="text-[10px] text-slate-500 text-center py-2">
                        Collecting… {state.metrics.tradesCount}/{state.thresholds.minTrades}
                    </div>
                )}
            </div>

            {lastUpdate && (
                <div className="px-2.5 py-1 border-t border-white/5 flex justify-between text-[9px] text-slate-600 shrink-0">
                    <span>{lastUpdate.toLocaleTimeString()}</span>
                    {state.evaluatedAt && <span>{new Date(state.evaluatedAt).toLocaleTimeString()}</span>}
                </div>
            )}
        </div>
    );
}
