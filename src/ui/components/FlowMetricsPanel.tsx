'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Activity, TrendingUp, TrendingDown, AlertTriangle, Pause, Waves, Zap } from 'lucide-react';
import clsx from 'clsx';
import { FlowResponse } from '../pages/api/bot/flow';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';

interface RegimeConfig {
    label: string;
    icon: typeof Activity;
    pillBg: string;
    pillBorder: string;
    pillText: string;
    timelineColor: string;
}

const REGIME_CONFIG: Record<FlowRegime, RegimeConfig> = {
    quiet: {
        label: 'Quiet',
        icon: Pause,
        pillBg: 'bg-slate-500/12',
        pillBorder: 'border-slate-500/25',
        pillText: 'text-slate-300',
        timelineColor: '#475569',
    },
    normal: {
        label: 'Normal',
        icon: Activity,
        pillBg: 'bg-emerald-500/12',
        pillBorder: 'border-emerald-500/25',
        pillText: 'text-emerald-400',
        timelineColor: '#34d399',
    },
    trendingUp: {
        label: 'Trending Up',
        icon: TrendingUp,
        pillBg: 'bg-sky-500/12',
        pillBorder: 'border-sky-500/25',
        pillText: 'text-sky-400',
        timelineColor: '#38bdf8',
    },
    trendingDown: {
        label: 'Trending Down',
        icon: TrendingDown,
        pillBg: 'bg-amber-500/12',
        pillBorder: 'border-amber-500/25',
        pillText: 'text-amber-400',
        timelineColor: '#f59e0b',
    },
    chaotic: {
        label: 'Chaotic',
        icon: Zap,
        pillBg: 'bg-red-500/12',
        pillBorder: 'border-red-500/25',
        pillText: 'text-red-400',
        timelineColor: '#ef4444',
    },
    illiquid: {
        label: 'Illiquid',
        icon: AlertTriangle,
        pillBg: 'bg-red-600/12',
        pillBorder: 'border-red-600/25',
        pillText: 'text-red-500',
        timelineColor: '#dc2626',
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// History buffer
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 60;

interface FlowHistoryEntry {
    ts: number;
    regime: FlowRegime;
    imbalance: number;
    midPrice: number;
    vwap: number | null;
    spreadBps: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG Mini-Chart (self-contained, glow + grid + dual-line)
// ─────────────────────────────────────────────────────────────────────────────

const PriceChart = ({
    midPrices,
    vwapPrices,
}: {
    midPrices: number[];
    vwapPrices: number[];
}) => {
    const VB_W = 400;
    const VB_H = 100;
    const pad = 2;

    const allVals = [...midPrices, ...vwapPrices].filter(v => v > 0);
    if (allVals.length < 2) return null;

    // Scale based on mid prices only so outlier VWAP values don't compress the chart
    const midOnly = midPrices.filter(v => v > 0);
    if (midOnly.length < 2) return null;

    const min = Math.min(...midOnly);
    const max = Math.max(...midOnly);
    const range = max - min || max * 0.001 || 1;

    const toPoints = (data: number[]) =>
        data.map((v, i) => {
            const x = pad + (i / (data.length - 1)) * (VB_W - pad * 2);
            const y = pad + (VB_H - pad * 2) - ((v - min) / range) * (VB_H - pad * 2);
            return `${x},${y}`;
        }).join(' ');

    const toFillPath = (data: number[]) => {
        const pts = data.map((v, i) => {
            const x = pad + (i / (data.length - 1)) * (VB_W - pad * 2);
            const y = pad + (VB_H - pad * 2) - ((v - min) / range) * (VB_H - pad * 2);
            return { x, y };
        });
        return `M ${pts[0]!.x},${pts[0]!.y} ` +
            pts.slice(1).map(p => `L ${p.x},${p.y}`).join(' ') +
            ` L ${pts[pts.length - 1]!.x},${VB_H} L ${pts[0]!.x},${VB_H} Z`;
    };

    const midGradId = 'mid-fill-grad';
    const glowId = 'mid-glow';

    const validMid = midPrices.filter(v => v > 0);
    const validVwap = vwapPrices.filter(v => v > 0);

    // Subtle horizontal grid lines
    const gridLines = [0.25, 0.5, 0.75].map(pct => {
        const y = pad + (VB_H - pad * 2) * (1 - pct);
        return y;
    });

    return (
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="w-full h-full">
            <defs>
                <linearGradient id={midGradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
                <filter id={glowId}>
                    <feGaussianBlur stdDeviation="1.5" result="blur" />
                    <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>

            {/* Grid lines */}
            {gridLines.map((y, i) => (
                <line key={i} x1={pad} y1={y} x2={VB_W - pad} y2={y} stroke="white" strokeOpacity={0.04} strokeWidth={0.5} />
            ))}

            {/* Mid fill */}
            {validMid.length >= 2 && (
                <path d={toFillPath(validMid)} fill={`url(#${midGradId})`} />
            )}

            {/* VWAP line (dashed amber) */}
            {validVwap.length >= 2 && (
                <polyline
                    points={toPoints(validVwap)}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={1}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="3,2"
                    opacity={0.7}
                />
            )}

            {/* Mid line with glow */}
            {validMid.length >= 2 && (
                <polyline
                    points={toPoints(validMid)}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    filter={`url(#${glowId})`}
                />
            )}
        </svg>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Micro Components
// ─────────────────────────────────────────────────────────────────────────────

/** Status pill for current regime */
const RegimePill = ({ regime }: { regime: FlowRegime | null }) => {
    if (!regime) {
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-[11px] text-slate-500">
                <Activity size={11} /> No Data
            </span>
        );
    }
    const cfg = REGIME_CONFIG[regime];
    const Icon = cfg.icon;
    return (
        <span className={clsx(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium',
            cfg.pillBg, cfg.pillBorder, cfg.pillText
        )}>
            <Icon size={11} /> {cfg.label}
        </span>
    );
};

/** Regime timeline strip — colored blocks showing regime changes over time */
const RegimeStrip = ({ history }: { history: FlowHistoryEntry[] }) => {
    if (history.length < 3) return null;
    return (
        <div className="space-y-0.5">
            <div className="flex justify-between text-[9px] text-slate-500 px-px">
                <span>{new Date(history[0]!.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="uppercase tracking-wider text-slate-600">Regime</span>
                <span>now</span>
            </div>
            <div className="flex h-[5px] rounded-sm overflow-hidden gap-[1px]">
                {history.map((entry, i) => (
                    <div
                        key={i}
                        className="flex-1 min-w-0 transition-colors duration-200"
                        style={{ backgroundColor: REGIME_CONFIG[entry.regime].timelineColor }}
                    />
                ))}
            </div>
        </div>
    );
};

/** Directional gauge — compact horizontal bar with sell/buy indicator */
const FlowGauge = ({
    value,
    label,
    leftLabel = 'Sell',
    rightLabel = 'Buy',
}: {
    value: number;
    label: string;
    leftLabel?: string;
    rightLabel?: string;
}) => {
    const clamped = Math.max(-1, Math.min(1, value));
    const position = ((clamped + 1) / 2) * 100;

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-baseline">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
                <span className={clsx(
                    'text-xs font-mono tabular-nums',
                    clamped > 0.15 ? 'text-sky-400' : clamped < -0.15 ? 'text-amber-400' : 'text-slate-300'
                )}>
                    {(clamped * 100).toFixed(1)}%
                </span>
            </div>
            <div className="relative h-[6px] bg-white/[0.04] rounded-full overflow-hidden">
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10" />
                <div
                    className={clsx(
                        'absolute top-0 h-full rounded-full transition-all duration-300',
                        clamped > 0.15 ? 'bg-sky-500/70' : clamped < -0.15 ? 'bg-amber-500/70' : 'bg-slate-400/50'
                    )}
                    style={{
                        left: clamped >= 0 ? '50%' : `${position}%`,
                        width: `${Math.abs(clamped) * 50}%`,
                    }}
                />
                <div
                    className="absolute top-1/2 w-[3px] h-[10px] bg-white/80 rounded-full transition-all duration-300"
                    style={{ left: `${position}%`, transform: 'translate(-50%, -50%)' }}
                />
            </div>
            <div className="flex justify-between text-[8px] text-slate-600">
                <span>{leftLabel}</span>
                <span>{rightLabel}</span>
            </div>
        </div>
    );
};

/** Book depth — bid vs ask with balance bar */
const DepthBar = ({ bidDepth, askDepth }: { bidDepth: number; askDepth: number }) => {
    const total = bidDepth + askDepth;
    const bidPct = total > 0 ? (bidDepth / total) * 100 : 50;

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-baseline">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">Book Depth</span>
                <span className="text-[10px] font-mono text-slate-400 tabular-nums">{total.toFixed(0)}</span>
            </div>
            <div className="flex h-[6px] rounded-full overflow-hidden gap-px">
                <div
                    className="bg-teal-500/50 rounded-l-full transition-all duration-300"
                    style={{ width: `${bidPct}%` }}
                />
                <div
                    className="bg-red-400/40 rounded-r-full transition-all duration-300"
                    style={{ width: `${100 - bidPct}%` }}
                />
            </div>
            <div className="flex justify-between text-[8px]">
                <span className="text-teal-400/80 font-mono tabular-nums">{bidDepth.toFixed(0)} bid</span>
                <span className="text-red-400/70 font-mono tabular-nums">{askDepth.toFixed(0)} ask</span>
            </div>
        </div>
    );
};

/** Signal strength — segmented blocks */
const SignalBlocks = ({ strength }: { strength: number }) => {
    const blocks = 5;
    const filled = Math.round(strength * blocks);

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-baseline">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">Signal</span>
                <span className="text-[10px] font-mono text-slate-400 tabular-nums">{(strength * 100).toFixed(0)}%</span>
            </div>
            <div className="flex gap-[3px]">
                {Array.from({ length: blocks }).map((_, i) => (
                    <div
                        key={i}
                        className={clsx(
                            'flex-1 h-[5px] rounded-[2px] transition-all duration-300',
                            i < filled
                                ? (strength > 0.6 ? 'bg-amber-500/70' : 'bg-sky-500/50')
                                : 'bg-white/[0.04]'
                        )}
                    />
                ))}
            </div>
        </div>
    );
};

/** Bottom metrics strip — single micro metric with optional sparkline */
const MicroMetric = ({
    label,
    value,
    unit,
    sparkData,
    color = 'text-slate-300',
}: {
    label: string;
    value: string;
    unit?: string;
    sparkData?: number[];
    color?: string;
}) => (
    <div className="flex items-center gap-2 min-w-0">
        <span className="text-[9px] text-slate-500 uppercase tracking-wider shrink-0">{label}</span>
        <span className={clsx('text-[11px] font-mono tabular-nums shrink-0', color)}>
            {value}{unit && <span className="text-slate-600 ml-0.5">{unit}</span>}
        </span>
        {sparkData && sparkData.length >= 3 && (
            <MicroSparkline data={sparkData} color={color.includes('sky') ? '#38bdf8' : color.includes('amber') ? '#f59e0b' : '#94a3b8'} />
        )}
    </div>
);

/** Tiny inline sparkline for bottom metrics strip */
const MicroSparkline = ({ data, color }: { data: number[]; color: string }) => {
    const w = 40;
    const h = 10;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    const points = data.map((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - ((v - min) / range) * h;
        return `${x},${y}`;
    }).join(' ');

    return (
        <svg viewBox={`0 0 ${w} ${h}`} className="w-[40px] h-[10px] shrink-0 opacity-60">
            <polyline points={points} fill="none" stroke={color} strokeWidth={1} strokeLinecap="round" />
        </svg>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Panel
// ─────────────────────────────────────────────────────────────────────────────

interface FlowMetricsPanelProps {
    pollInterval?: number;
    compact?: boolean;
}

export function FlowMetricsPanel({ pollInterval = 1000, compact = false }: FlowMetricsPanelProps) {
    const [data, setData] = useState<FlowResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const historyRef = useRef<FlowHistoryEntry[]>([]);
    const [history, setHistory] = useState<FlowHistoryEntry[]>([]);

    const fetchFlow = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/flow');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: FlowResponse = await res.json();
            setData(json);
            setError(null);

            if (json.hasMetrics && json.regime?.current) {
                const entry: FlowHistoryEntry = {
                    ts: Date.now(),
                    regime: json.regime.current as FlowRegime,
                    imbalance: json.signals?.imbalance ?? 0,
                    midPrice: json.prices?.midPrice ?? 0,
                    vwap: json.prices?.vwap ?? null,
                    spreadBps: json.prices?.spreadBps ?? 0,
                };
                const next = [...historyRef.current, entry].slice(-MAX_HISTORY);
                historyRef.current = next;
                setHistory(next);
            }
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

    // Derived chart data
    const midPrices = useMemo(() => history.map(h => h.midPrice).filter(v => v > 0), [history]);
    const vwapPrices = useMemo(() => history.map(h => h.vwap ?? h.midPrice).filter(v => v > 0), [history]);
    const spreadHistory = useMemo(() => history.map(h => h.spreadBps), [history]);
    const imbalanceHistory = useMemo(() => history.map(h => Math.abs(h.imbalance) * 100), [history]);

    // ── Loading state ────────────────────────────────────────────────────
    if (loading && !data) {
        return (
            <div className="card p-3">
                <div className="flex items-center gap-1.5 text-slate-500 text-[10px]">
                    <Waves size={10} className="animate-pulse" />
                    <span>Loading flow metrics…</span>
                </div>
            </div>
        );
    }

    if (error && !data) {
        return (
            <div className="card p-3 border-danger/30">
                <div className="flex items-center gap-1.5 text-danger text-[10px]">
                    <AlertTriangle size={10} />
                    <span>{error}</span>
                </div>
            </div>
        );
    }

    // ── Empty state ──────────────────────────────────────────────────────
    if (!data?.hasMetrics) {
        return (
            <div className="card flex flex-col">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
                    <Waves size={12} className="text-slate-500" />
                    <span className="text-[11px] font-medium text-slate-300">Flow Sentiment</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center py-6 text-center">
                    <Activity size={18} className="text-slate-700 mb-1" />
                    <p className="text-[11px] text-slate-500">No flow data available</p>
                    <p className="text-[9px] text-slate-600 mt-0.5">Start the bot to begin collecting flow metrics</p>
                </div>
            </div>
        );
    }

    const regime = data?.regime.current as FlowRegime | null;

    // ── Compact mode ─────────────────────────────────────────────────────
    if (compact) {
        return (
            <div className="card p-3 flex items-center gap-3">
                <Waves size={14} className="text-slate-500" />
                <RegimePill regime={regime} />
                {data?.signals && (
                    <div className="flex-1 max-w-[100px]">
                        <div className="relative h-1 bg-white/5 rounded-full overflow-hidden">
                            <div
                                className={clsx(
                                    'absolute top-0 h-full rounded-full transition-all',
                                    data.signals.imbalance > 0.3 ? 'bg-sky-500' :
                                        data.signals.imbalance < -0.3 ? 'bg-amber-500' : 'bg-slate-400'
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

    // ── Full panel — institutional quant terminal layout ─────────────────
    return (
        <div className="card overflow-hidden flex flex-col h-full" style={{ background: 'linear-gradient(180deg, #121933 0%, #0e1528 100%)' }}>
            {/* ─── HEADER ────────────────────────────────────────────────── */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06] shrink-0">
                {/* Left: icon + title + regime pill */}
                <div className="flex items-center gap-2.5 min-w-0">
                    <Waves size={15} className="text-slate-500 shrink-0" />
                    <span className="text-xs font-medium text-slate-200 shrink-0">Flow Sentiment</span>
                    <RegimePill regime={regime} />
                    <span className="text-[10px] text-slate-500 truncate hidden xl:inline">{data?.regime.description}</span>
                </div>

                {/* Right: mode badges + timestamp */}
                <div className="flex items-center gap-2 shrink-0">
                    <span className={clsx(
                        'text-[9px] px-2 py-0.5 rounded border font-medium',
                        data?.regime.safeForMM
                            ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-400'
                            : 'bg-red-500/8 border-red-500/20 text-red-400'
                    )}>
                        MM {data?.regime.safeForMM ? '✓' : '✗'}
                    </span>
                    <span className={clsx(
                        'text-[9px] px-2 py-0.5 rounded border font-medium',
                        data?.regime.safeForArb
                            ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-400'
                            : 'bg-red-500/8 border-red-500/20 text-red-400'
                    )}>
                        Arb {data?.regime.safeForArb ? '✓' : '✗'}
                    </span>
                    <span className="text-[9px] text-slate-600 hidden sm:inline font-mono tabular-nums">
                        {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : ''}
                    </span>
                </div>
            </div>

            {/* ─── BODY ──────────────────────────────────────────────────── */}
            <div className="flex flex-col lg:flex-row flex-1 min-h-0">
                {/* LEFT COLUMN — Metrics Stack (~30%) */}
                <div className="lg:w-[280px] xl:w-[300px] shrink-0 px-4 py-3 flex flex-col gap-3 border-r border-white/[0.04]">
                    {/* Trade Flow */}
                    {data?.signals && (
                        <FlowGauge value={data.signals.imbalance} label="Trade Flow" />
                    )}

                    {/* Depth Bias */}
                    {data?.signals && (
                        <FlowGauge value={data.signals.depthImbalance} label="Depth Bias" leftLabel="Ask" rightLabel="Bid" />
                    )}

                    {/* Book Depth */}
                    {data?.depth && (
                        <DepthBar bidDepth={data.depth.bidDepthBase} askDepth={data.depth.askDepthBase} />
                    )}

                    {/* Signal Strength */}
                    {data?.signals && (
                        <SignalBlocks strength={data.signals.signalStrength} />
                    )}
                </div>

                {/* RIGHT COLUMN — Chart Zone (~70%) */}
                <div className="flex-1 min-w-0 flex flex-col px-3 py-2">
                    {/* Regime timeline strip */}
                    <div className="shrink-0 mb-1">
                        <RegimeStrip history={history} />
                    </div>

                    {/* Chart area — fills remaining height */}
                    <div className="flex-1 min-h-[80px] relative">
                        {history.length >= 3 ? (
                            <>
                                {/* Chart legend */}
                                <div className="absolute top-0 right-0 z-10 flex items-center gap-3 text-[9px]">
                                    <span className="flex items-center gap-1 text-slate-500">
                                        <span className="w-3 h-[2px] bg-sky-400 inline-block rounded" /> Mid
                                    </span>
                                    <span className="flex items-center gap-1 text-slate-500">
                                        <span className="w-3 h-[2px] bg-amber-400 inline-block rounded opacity-70" style={{ borderBottom: '1px dashed #f59e0b' }} /> VWAP
                                    </span>
                                </div>

                                {/* Price labels */}
                                {data?.prices && (
                                    <div className="absolute top-0 left-0 z-10 flex flex-col gap-0.5">
                                        <span className="text-[10px] font-mono tabular-nums text-sky-400/80">
                                            {data.prices.midPrice.toFixed(6)}
                                        </span>
                                        {data.prices.vwap && (
                                            <span className="text-[10px] font-mono tabular-nums text-amber-400/60">
                                                {data.prices.vwap.toFixed(6)}
                                            </span>
                                        )}
                                    </div>
                                )}

                                <PriceChart midPrices={midPrices} vwapPrices={vwapPrices} />
                            </>
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-600">
                                Collecting data…
                            </div>
                        )}
                    </div>

                    {/* Prices row (mobile fallback) */}
                    {data?.prices && (
                        <div className="shrink-0 flex items-center justify-between text-[10px] py-1 lg:hidden border-t border-white/[0.04]">
                            <span className="font-mono text-teal-400">{data.prices.bestBid.toFixed(6)}</span>
                            <span className="text-slate-500">Spread: {data.prices.spreadBps.toFixed(1)} bps</span>
                            <span className="font-mono text-red-400">{data.prices.bestAsk.toFixed(6)}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ─── BOTTOM MICRO-METRICS STRIP ────────────────────────────── */}
            <div className="shrink-0 flex items-center gap-6 px-4 py-1.5 border-t border-white/[0.06] bg-white/[0.015] overflow-x-auto">
                {data?.prices && (
                    <>
                        <MicroMetric
                            label="Spread"
                            value={data.prices.spreadBps.toFixed(1)}
                            unit="bps"
                            sparkData={spreadHistory}
                            color="text-slate-300"
                        />
                        <MicroMetric
                            label="Bid"
                            value={data.prices.bestBid.toFixed(6)}
                            color="text-teal-400"
                        />
                        <MicroMetric
                            label="Ask"
                            value={data.prices.bestAsk.toFixed(6)}
                            color="text-red-400/80"
                        />
                    </>
                )}
                {data?.signals && (
                    <MicroMetric
                        label="Imbalance"
                        value={`${(Math.abs(data.signals.imbalance) * 100).toFixed(1)}`}
                        unit="%"
                        sparkData={imbalanceHistory}
                        color={data.signals.imbalance > 0.15 ? 'text-sky-400' : data.signals.imbalance < -0.15 ? 'text-amber-400' : 'text-slate-300'}
                    />
                )}
                {data?.prices?.vwap && (
                    <MicroMetric
                        label="VWAP Δ"
                        value={`${data.prices.vwapDeviationBps >= 0 ? '+' : ''}${data.prices.vwapDeviationBps.toFixed(1)}`}
                        unit="bps"
                        color={data.prices.vwapDeviationBps > 20 ? 'text-sky-400' : data.prices.vwapDeviationBps < -20 ? 'text-amber-400' : 'text-slate-300'}
                    />
                )}
                {data?.signals && (
                    <MicroMetric
                        label="Signal"
                        value={`${(data.signals.signalStrength * 100).toFixed(0)}`}
                        unit="%"
                        color={data.signals.signalStrength > 0.6 ? 'text-amber-400' : 'text-slate-300'}
                    />
                )}
            </div>
        </div>
    );
}

export default FlowMetricsPanel;
