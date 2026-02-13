/**
 * Adaptive Panel Component
 *
 * Compact panel showing adaptive learning status and current tunings.
 * Designed to fit in existing dashboard grid without adding scrolling.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Brain, Power, RefreshCw, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';

interface AdaptiveTuning {
    sizeMultiplier: number;
    quoteSkewBps: number;
    maxSlippageBps: number;
    minEdgeBpsToTrade: number;
    coolDownMs: number;
    disabledRegimes: FlowRegime[];
    updatedAt: number;
    reason: string;
}

interface AdaptiveStateResponse {
    requestId: string;
    timestamp: string;
    enabled: boolean;
    state: {
        updatedAt: number;
        tunings: Record<string, Record<string, Partial<Record<FlowRegime, AdaptiveTuning>>>>;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const REGIME_LABELS: Record<FlowRegime, string> = {
    quiet: 'Quiet',
    normal: 'Normal',
    trendingUp: 'Up',
    trendingDown: 'Down',
    chaotic: 'Chaotic',
    illiquid: 'Illiquid',
};

function formatTime(ts: number): string {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleTimeString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

interface AdaptivePanelProps {
    /** Current trading pair key */
    pairKey?: string;
    /** Current strategy name */
    strategy?: string;
    /** Current flow regime */
    regime?: FlowRegime | null;
    /** Polling interval in ms (default: 10000) */
    pollInterval?: number;
    /** Toggle polling while panel is hidden */
    enabled?: boolean;
}

export function AdaptivePanel({
    pairKey,
    strategy,
    regime,
    pollInterval = 10000,
    enabled: pollingEnabled = true,
}: AdaptivePanelProps) {
    const [data, setData] = useState<AdaptiveStateResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [recomputing, setRecomputing] = useState(false);
    const [toggling, setToggling] = useState(false);

    const fetchState = useCallback(async () => {
        try {
            const res = await fetch('/api/analytics/adaptive/state');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: AdaptiveStateResponse = await res.json();
            setData(json);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch');
        } finally {
            setLoading(false);
        }
    }, []);

    const handleRecompute = async () => {
        setRecomputing(true);
        try {
            const res = await fetch('/api/analytics/adaptive/recompute', { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // Refresh state after recompute
            await fetchState();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Recompute failed');
        } finally {
            setRecomputing(false);
        }
    };

    const handleToggle = async () => {
        if (!data) return;
        setToggling(true);
        try {
            const res = await fetch('/api/analytics/adaptive/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !data.enabled }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // Refresh state after toggle
            await fetchState();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Toggle failed');
        } finally {
            setToggling(false);
        }
    };

    useEffect(() => {
        if (!pollingEnabled) return () => undefined;
        fetchState();
        const interval = setInterval(fetchState, pollInterval);
        return () => clearInterval(interval);
    }, [fetchState, pollInterval, pollingEnabled]);

    // Get current tuning if we have context
    const currentTuning: AdaptiveTuning | null = (() => {
        if (!data || !pairKey || !strategy || !regime) return null;
        const byPair = data.state.tunings[pairKey];
        if (!byPair) return null;
        const byStrat = byPair[strategy];
        if (!byStrat) return null;
        return byStrat[regime] ?? byStrat['normal'] ?? null;
    })();

    const isRegimeDisabled = currentTuning?.disabledRegimes.includes(regime as FlowRegime) ?? false;

    // Loading state
    if (loading && !data) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-1.5 p-2 border-b border-white/5">
                    <Brain size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-200">Adaptive</span>
                </div>
                <div className="flex-1 flex items-center justify-center p-2">
                    <RefreshCw size={12} className="animate-spin text-slate-500" />
                </div>
            </div>
        );
    }

    // Error state
    if (error && !data) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-1.5 p-2 border-b border-white/5">
                    <Brain size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-200">Adaptive</span>
                </div>
                <div className="flex-1 flex items-center justify-center p-2">
                    <AlertTriangle size={10} className="text-red-400 mr-1" />
                    <span className="text-[10px] text-red-400">{error}</span>
                </div>
            </div>
        );
    }

    const enabled = data?.enabled ?? false;

    return (
        <div className="card h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-white/5 shrink-0">
                <div className="flex items-center gap-1.5">
                    <Brain size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium text-slate-200">Adaptive</span>
                </div>
                {/* Status Badge */}
                <button
                    onClick={handleToggle}
                    disabled={toggling}
                    className={clsx(
                        'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors',
                        enabled
                            ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                            : 'bg-slate-500/20 text-slate-400 hover:bg-slate-500/30'
                    )}
                >
                    <Power size={10} />
                    {toggling ? '...' : enabled ? 'ON' : 'OFF'}
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 px-2.5 py-2 space-y-1.5 overflow-hidden">
                {/* Current Regime */}
                {regime && (
                    <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-500">Regime</span>
                        <span className={clsx(
                            'font-medium',
                            regime === 'chaotic' && 'text-red-400',
                            regime === 'illiquid' && 'text-red-400',
                            regime === 'trendingUp' && 'text-blue-400',
                            regime === 'trendingDown' && 'text-amber-400',
                            regime === 'normal' && 'text-emerald-400',
                            regime === 'quiet' && 'text-slate-400'
                        )}>
                            {REGIME_LABELS[regime]}
                            {isRegimeDisabled && (
                                <span className="ml-1 text-red-400">(disabled)</span>
                            )}
                        </span>
                    </div>
                )}

                {/* Current Tuning */}
                {enabled && currentTuning ? (
                    <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="text-slate-500">Size ×</span>
                            <span className={clsx(
                                'font-mono',
                                currentTuning.sizeMultiplier < 0.8 && 'text-amber-400',
                                currentTuning.sizeMultiplier > 1 && 'text-emerald-400',
                                currentTuning.sizeMultiplier >= 0.8 && currentTuning.sizeMultiplier <= 1 && 'text-slate-300'
                            )}>
                                {currentTuning.sizeMultiplier.toFixed(2)}
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="text-slate-500">Max Slip</span>
                            <span className="font-mono text-slate-300">
                                {currentTuning.maxSlippageBps} bps
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="text-slate-500">Min Edge</span>
                            <span className="font-mono text-slate-300">
                                {currentTuning.minEdgeBpsToTrade} bps
                            </span>
                        </div>
                        {currentTuning.coolDownMs > 0 && (
                            <div className="flex items-center justify-between text-[11px]">
                                <span className="text-slate-500">Cooldown</span>
                                <span className="font-mono text-amber-400">
                                    {(currentTuning.coolDownMs / 1000).toFixed(1)}s
                                </span>
                            </div>
                        )}
                    </div>
                ) : enabled ? (
                    <div className="text-[10px] text-slate-500 text-center py-1.5">
                        No tuning for current context
                    </div>
                ) : (
                    <div className="text-[10px] text-slate-500 text-center py-1.5">
                        Adaptive learning disabled
                    </div>
                )}

                {/* Reason (truncated) */}
                {enabled && currentTuning?.reason && (
                    <div className="text-[9px] text-slate-600 truncate" title={currentTuning.reason}>
                        {currentTuning.reason}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-white/5 shrink-0">
                <span className="text-[9px] text-slate-600">
                    {data?.state.updatedAt ? formatTime(data.state.updatedAt) : '—'}
                </span>
                <button
                    onClick={handleRecompute}
                    disabled={recomputing || !enabled}
                    className={clsx(
                        'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                        enabled
                            ? 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                            : 'text-slate-600 cursor-not-allowed'
                    )}
                >
                    <RefreshCw size={10} className={recomputing ? 'animate-spin' : ''} />
                    Recompute
                </button>
            </div>
        </div>
    );
}

export default AdaptivePanel;
