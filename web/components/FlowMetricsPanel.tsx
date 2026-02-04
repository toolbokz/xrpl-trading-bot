'use client';

import { useState, useEffect, useCallback } from 'react';
import { Activity, TrendingUp, TrendingDown, AlertTriangle, Pause, Waves, BarChart3 } from 'lucide-react';
import clsx from 'clsx';
import { FlowResponse } from '../pages/api/bot/flow';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';

interface RegimeConfig {
    label: string;
    icon: typeof Activity;
    tone: 'neutral' | 'success' | 'danger' | 'warning' | 'info';
    bgColor: string;
    borderColor: string;
    textColor: string;
}

const REGIME_CONFIG: Record<FlowRegime, RegimeConfig> = {
    quiet: {
        label: 'Quiet',
        icon: Pause,
        tone: 'neutral',
        bgColor: 'bg-slate-500/15',
        borderColor: 'border-slate-500/30',
        textColor: 'text-slate-300',
    },
    normal: {
        label: 'Normal',
        icon: Activity,
        tone: 'success',
        bgColor: 'bg-success/15',
        borderColor: 'border-success/30',
        textColor: 'text-success',
    },
    trendingUp: {
        label: 'Trending Up',
        icon: TrendingUp,
        tone: 'info',
        bgColor: 'bg-blue-500/15',
        borderColor: 'border-blue-500/30',
        textColor: 'text-blue-400',
    },
    trendingDown: {
        label: 'Trending Down',
        icon: TrendingDown,
        tone: 'warning',
        bgColor: 'bg-amber-500/15',
        borderColor: 'border-amber-500/30',
        textColor: 'text-amber-400',
    },
    chaotic: {
        label: 'Chaotic',
        icon: AlertTriangle,
        tone: 'danger',
        bgColor: 'bg-danger/15',
        borderColor: 'border-danger/30',
        textColor: 'text-danger',
    },
    illiquid: {
        label: 'Illiquid',
        icon: AlertTriangle,
        tone: 'danger',
        bgColor: 'bg-red-600/15',
        borderColor: 'border-red-600/30',
        textColor: 'text-red-400',
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regime badge showing current market state
 */
const RegimeBadge = ({ regime }: { regime: FlowRegime | null }) => {
    if (!regime) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                <Activity size={16} className="text-slate-400" />
                <span className="text-sm text-slate-400">No Data</span>
            </div>
        );
    }

    const config = REGIME_CONFIG[regime];
    const Icon = config.icon;

    return (
        <div className={clsx(
            'flex items-center gap-2 px-3 py-2 rounded-lg border',
            config.bgColor,
            config.borderColor
        )}>
            <Icon size={16} className={config.textColor} />
            <span className={clsx('text-sm font-medium', config.textColor)}>{config.label}</span>
        </div>
    );
};

/**
 * Horizontal gauge showing a value from -1 to 1
 */
const ImbalanceGauge = ({ value, label }: { value: number; label: string }) => {
    // Clamp value to -1..1
    const clampedValue = Math.max(-1, Math.min(1, value));
    // Convert to 0-100 percentage (50 is center)
    const position = ((clampedValue + 1) / 2) * 100;

    // Determine color based on value
    const getColor = () => {
        if (clampedValue > 0.3) return 'bg-blue-500';
        if (clampedValue < -0.3) return 'bg-amber-500';
        return 'bg-success';
    };

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-center">
                <span className="text-[11px] text-slate-400 uppercase tracking-wider">{label}</span>
                <span className="text-xs font-mono text-slate-300">{(clampedValue * 100).toFixed(1)}%</span>
            </div>
            <div className="relative h-2 bg-white/5 rounded-full overflow-hidden">
                {/* Center line */}
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/20" />

                {/* Value indicator */}
                <div
                    className={clsx('absolute top-0 h-full transition-all duration-300 rounded-full', getColor())}
                    style={{
                        left: clampedValue >= 0 ? '50%' : `${position}%`,
                        width: `${Math.abs(clampedValue) * 50}%`,
                    }}
                />

                {/* Marker */}
                <div
                    className="absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-white rounded-full shadow-lg transition-all duration-300"
                    style={{ left: `${position}%`, transform: 'translate(-50%, -50%)' }}
                />
            </div>
            <div className="flex justify-between text-[10px] text-slate-500">
                <span>Sell</span>
                <span>Buy</span>
            </div>
        </div>
    );
};

/**
 * Depth bar showing bid vs ask depth
 */
const DepthBar = ({ bidDepth, askDepth }: { bidDepth: number; askDepth: number }) => {
    const total = bidDepth + askDepth;
    const bidPercent = total > 0 ? (bidDepth / total) * 100 : 50;
    const askPercent = total > 0 ? (askDepth / total) * 100 : 50;

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-center">
                <span className="text-[11px] text-slate-400 uppercase tracking-wider">Book Depth</span>
                <span className="text-xs font-mono text-slate-300">{total.toFixed(0)} base</span>
            </div>
            <div className="flex h-3 rounded-full overflow-hidden">
                <div
                    className="bg-success/60 transition-all duration-300"
                    style={{ width: `${bidPercent}%` }}
                    title={`Bid: ${bidDepth.toFixed(2)}`}
                />
                <div
                    className="bg-danger/60 transition-all duration-300"
                    style={{ width: `${askPercent}%` }}
                    title={`Ask: ${askDepth.toFixed(2)}`}
                />
            </div>
            <div className="flex justify-between text-[10px]">
                <span className="text-success">{bidDepth.toFixed(0)} bid</span>
                <span className="text-danger">{askDepth.toFixed(0)} ask</span>
            </div>
        </div>
    );
};

/**
 * Signal strength meter
 */
const SignalStrengthMeter = ({ strength }: { strength: number }) => {
    const bars = 5;
    const filledBars = Math.round(strength * bars);

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-center">
                <span className="text-[11px] text-slate-400 uppercase tracking-wider">Signal Strength</span>
                <span className="text-xs font-mono text-slate-300">{(strength * 100).toFixed(0)}%</span>
            </div>
            <div className="flex gap-1">
                {Array.from({ length: bars }).map((_, i) => (
                    <div
                        key={i}
                        className={clsx(
                            'flex-1 h-2 rounded-sm transition-all duration-300',
                            i < filledBars
                                ? strength > 0.5 ? 'bg-amber-500' : 'bg-success'
                                : 'bg-white/10'
                        )}
                    />
                ))}
            </div>
        </div>
    );
};

/**
 * Price display with VWAP comparison
 */
const PriceDisplay = ({
    bestBid,
    bestAsk,
    midPrice,
    spreadBps,
    vwap,
    vwapDeviationBps
}: {
    bestBid: number;
    bestAsk: number;
    midPrice: number;
    spreadBps: number;
    vwap: number | null;
    vwapDeviationBps: number;
}) => {
    return (
        <div className="space-y-2">
            <div className="flex justify-between text-xs">
                <span className="text-success font-mono">{bestBid.toFixed(6)}</span>
                <span className="text-slate-400">Spread: {spreadBps.toFixed(1)} bps</span>
                <span className="text-danger font-mono">{bestAsk.toFixed(6)}</span>
            </div>
            {vwap && (
                <div className="flex justify-between text-xs">
                    <span className="text-slate-400">VWAP: <span className="font-mono text-slate-300">{vwap.toFixed(6)}</span></span>
                    <span className={clsx(
                        'font-mono',
                        vwapDeviationBps > 20 ? 'text-blue-400' : vwapDeviationBps < -20 ? 'text-amber-400' : 'text-slate-400'
                    )}>
                        {vwapDeviationBps >= 0 ? '+' : ''}{vwapDeviationBps.toFixed(1)} bps
                    </span>
                </div>
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Panel Component
// ─────────────────────────────────────────────────────────────────────────────

interface FlowMetricsPanelProps {
    /** Polling interval in ms (default: 1000) */
    pollInterval?: number;
    /** Show compact version */
    compact?: boolean;
}

export function FlowMetricsPanel({ pollInterval = 1000, compact = false }: FlowMetricsPanelProps) {
    const [data, setData] = useState<FlowResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchFlow = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/flow');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: FlowResponse = await res.json();
            setData(json);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch flow');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchFlow();
        const interval = setInterval(fetchFlow, pollInterval);
        return () => clearInterval(interval);
    }, [fetchFlow, pollInterval]);

    if (loading && !data) {
        return (
            <div className="card p-4">
                <div className="flex items-center gap-2 text-slate-400">
                    <Waves size={16} className="animate-pulse" />
                    <span className="text-sm">Loading flow metrics...</span>
                </div>
            </div>
        );
    }

    if (error && !data) {
        return (
            <div className="card p-4 border-danger/30">
                <div className="flex items-center gap-2 text-danger">
                    <AlertTriangle size={16} />
                    <span className="text-sm">{error}</span>
                </div>
            </div>
        );
    }

    // No metrics yet (bot not running or no data)
    if (!data?.hasMetrics) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-2 p-4 border-b border-white/5">
                    <Waves size={16} className="text-slate-400" />
                    <span className="text-sm font-medium text-slate-200">Flow Sentiment</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
                    <Activity size={32} className="text-slate-600 mb-3" />
                    <p className="text-sm text-slate-400 mb-1">No flow data available</p>
                    <p className="text-xs text-slate-500">Start the bot to begin collecting market flow metrics</p>
                </div>
            </div>
        );
    }

    const regime = data?.regime.current as FlowRegime | null;

    // Compact mode: just show regime badge and imbalance
    if (compact) {
        return (
            <div className="card p-3 flex items-center gap-4">
                <Waves size={16} className="text-slate-400" />
                <RegimeBadge regime={regime} />
                {data?.signals && (
                    <div className="flex-1 max-w-[120px]">
                        <div className="relative h-1.5 bg-white/5 rounded-full overflow-hidden">
                            <div
                                className={clsx(
                                    'absolute top-0 h-full rounded-full transition-all',
                                    data.signals.imbalance > 0.3 ? 'bg-blue-500' :
                                        data.signals.imbalance < -0.3 ? 'bg-amber-500' : 'bg-success'
                                )}
                                style={{
                                    left: data.signals.imbalance >= 0 ? '50%' : `${((data.signals.imbalance + 1) / 2) * 100}%`,
                                    width: `${Math.abs(data.signals.imbalance) * 50}%`,
                                }}
                            />
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Full panel
    return (
        <div className="card h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 pb-0 shrink-0">
                <div className="flex items-center gap-2">
                    <Waves size={18} className="text-slate-400" />
                    <h3 className="text-sm font-medium text-slate-200">Flow Sentiment</h3>
                </div>
                <RegimeBadge regime={regime} />
            </div>

            {/* Scrollable body */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 pt-3 space-y-4 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {/* Description */}
                <p className="text-xs text-slate-400">{data?.regime.description}</p>

                {/* Trading status */}
                <div className="flex gap-2">
                    <div className={clsx(
                        'text-[10px] px-2 py-1 rounded-full border',
                        data?.regime.safeForMM
                            ? 'bg-success/10 border-success/20 text-success'
                            : 'bg-danger/10 border-danger/20 text-danger'
                    )}>
                        MM: {data?.regime.safeForMM ? 'Safe' : 'Avoid'}
                    </div>
                    <div className={clsx(
                        'text-[10px] px-2 py-1 rounded-full border',
                        data?.regime.safeForArb
                            ? 'bg-success/10 border-success/20 text-success'
                            : 'bg-danger/10 border-danger/20 text-danger'
                    )}>
                        Arb: {data?.regime.safeForArb ? 'Safe' : 'Avoid'}
                    </div>
                </div>

                {/* Signals */}
                {data?.signals && (
                    <div className="space-y-3 pt-2 border-t border-white/5">
                        <ImbalanceGauge value={data.signals.imbalance} label="Trade Flow" />
                        <ImbalanceGauge value={data.signals.depthImbalance} label="Depth Bias" />
                        <SignalStrengthMeter strength={data.signals.signalStrength} />
                    </div>
                )}

                {/* Depth */}
                {data?.depth && (
                    <div className="pt-2 border-t border-white/5">
                        <DepthBar
                            bidDepth={data.depth.bidDepthBase}
                            askDepth={data.depth.askDepthBase}
                        />
                    </div>
                )}

                {/* Prices */}
                {data?.prices && (
                    <div className="pt-2 border-t border-white/5">
                        <PriceDisplay {...data.prices} />
                    </div>
                )}

            </div>

            {/* Last update - footer */}
            <div className="text-[10px] text-slate-500 text-right px-4 py-2 border-t border-white/5 shrink-0">
                Updated: {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : 'N/A'}
            </div>
        </div>
    );
}

export default FlowMetricsPanel;
