/**
 * Cost Realism Panel Component
 * 
 * Displays cost realism metrics for trade execution analysis:
 * - Slippage vs intent and mid price
 * - Edge (quoting skill)
 * - Spread paid (execution cost)
 * - Net edge (what you actually keep)
 * - Transaction fees
 * - Partial fill statistics
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { DollarSign, TrendingUp, TrendingDown, Activity, AlertTriangle, Percent, Layers } from 'lucide-react';
import clsx from 'clsx';

// ─────────────────────────────────────────────────────────────────────────────
// Types (matching API response)
// ─────────────────────────────────────────────────────────────────────────────

interface CostSummary {
    fills: number;
    avgSlippageBpsVsIntent: number | null;
    avgSlippageBpsVsMid: number | null;
    avgSpreadPaidBps: number | null;
    avgEdgeBpsVsMid: number | null;
    avgNetEdgeBpsVsMid: number | null;
    avgTxFeeXrp: number | null;
    totalTxFeeXrp: number | null;
    partialFillRatio: number;
    avgFillRatio: number | null;
}

interface CostRealismApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        strategy: string | null;
        sinceMs: number | null;
    };
    costs: CostSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Components
// ─────────────────────────────────────────────────────────────────────────────

function CostMetric({
    label,
    value,
    suffix = '',
    positive,
    icon: Icon,
    description,
}: {
    label: string;
    value: number | string | null;
    suffix?: string;
    positive?: boolean | null;
    icon?: typeof Activity;
    description?: string;
}) {
    const displayValue = value === null ? '—' : typeof value === 'number' ? value.toFixed(1) : value;

    return (
        <div className="bg-white/5 rounded-lg p-2.5 border border-white/5" title={description}>
            <div className="flex items-center gap-1.5 mb-1">
                {Icon && <Icon size={12} className="text-slate-500" />}
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
            </div>
            <div className={clsx(
                'text-sm font-mono font-medium',
                positive === true && 'text-emerald-400',
                positive === false && 'text-red-400',
                positive === null && 'text-slate-300'
            )}>
                {displayValue}{value !== null ? suffix : ''}
            </div>
        </div>
    );
}

function formatBps(bps: number | null): { value: string; positive: boolean | null } {
    if (bps === null) return { value: '—', positive: null };
    const sign = bps >= 0 ? '+' : '';
    return {
        value: `${sign}${bps.toFixed(1)}`,
        positive: bps > 0 ? true : bps < 0 ? false : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

interface CostRealismPanelProps {
    /** Polling interval in ms (default: 15000) */
    pollInterval?: number;
    /** Trading pair to filter (optional) */
    pairKey?: string;
    /** Strategy to filter (optional) */
    strategy?: string;
}

export function CostRealismPanel({ pollInterval = 15000, pairKey, strategy }: CostRealismPanelProps) {
    const [data, setData] = useState<CostRealismApiResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchCosts = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (pairKey) params.set('pair', pairKey);
            if (strategy) params.set('strategy', strategy);

            const url = `/api/analytics/costs${params.toString() ? `?${params}` : ''}`;
            const res = await fetch(url);

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const json: CostRealismApiResponse = await res.json();
            setData(json);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch cost data');
        } finally {
            setLoading(false);
        }
    }, [pairKey, strategy]);

    useEffect(() => {
        fetchCosts();
        const interval = setInterval(fetchCosts, pollInterval);
        return () => clearInterval(interval);
    }, [fetchCosts, pollInterval]);

    // Loading state
    if (loading && !data) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-2 p-3 border-b border-white/5">
                    <DollarSign size={14} className="text-slate-400" />
                    <span className="text-xs font-medium text-slate-200">Cost Realism</span>
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex items-center gap-2 text-slate-400">
                        <Activity size={16} className="animate-pulse" />
                        <span className="text-sm">Loading costs...</span>
                    </div>
                </div>
            </div>
        );
    }

    // Error state
    if (error && !data) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-2 p-3 border-b border-white/5">
                    <DollarSign size={14} className="text-slate-400" />
                    <span className="text-xs font-medium text-slate-200">Cost Realism</span>
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex items-center gap-2 text-red-400">
                        <AlertTriangle size={16} />
                        <span className="text-sm">{error}</span>
                    </div>
                </div>
            </div>
        );
    }

    // No data state
    if (!data || data.costs.fills === 0) {
        return (
            <div className="card h-full flex flex-col">
                <div className="flex items-center gap-2 p-3 border-b border-white/5">
                    <DollarSign size={14} className="text-slate-400" />
                    <span className="text-xs font-medium text-slate-200">Cost Realism</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
                    <DollarSign size={28} className="text-slate-600 mb-2" />
                    <p className="text-sm text-slate-400">No cost data yet</p>
                    <p className="text-xs text-slate-500">Cost metrics appear after fills execute</p>
                </div>
            </div>
        );
    }

    const { costs } = data;

    // Format metrics with color coding
    const slippageIntent = formatBps(costs.avgSlippageBpsVsIntent);
    const slippageMid = formatBps(costs.avgSlippageBpsVsMid);
    const edge = costs.avgEdgeBpsVsMid !== null
        ? { value: `${costs.avgEdgeBpsVsMid >= 0 ? '+' : ''}${costs.avgEdgeBpsVsMid.toFixed(1)}`, positive: costs.avgEdgeBpsVsMid > 0 }
        : { value: '—', positive: null };
    const netEdge = costs.avgNetEdgeBpsVsMid !== null
        ? { value: `${costs.avgNetEdgeBpsVsMid >= 0 ? '+' : ''}${costs.avgNetEdgeBpsVsMid.toFixed(1)}`, positive: costs.avgNetEdgeBpsVsMid > 0 }
        : { value: '—', positive: null };

    return (
        <div className="card h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-white/5 shrink-0">
                <div className="flex items-center gap-2">
                    <DollarSign size={14} className="text-slate-400" />
                    <span className="text-xs font-medium text-slate-200">Cost Realism</span>
                </div>
                <span className="text-[10px] text-slate-500">
                    {costs.fills} fills
                </span>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {/* Slippage Metrics */}
                <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Slippage</div>
                    <div className="grid grid-cols-2 gap-2">
                        <CostMetric
                            label="vs Intent"
                            value={slippageIntent.value}
                            suffix=" bps"
                            positive={costs.avgSlippageBpsVsIntent !== null ? costs.avgSlippageBpsVsIntent <= 0 : null}
                            icon={Activity}
                            description="Slippage vs your limit price (negative = better)"
                        />
                        <CostMetric
                            label="vs Mid"
                            value={slippageMid.value}
                            suffix=" bps"
                            positive={costs.avgSlippageBpsVsMid !== null ? costs.avgSlippageBpsVsMid <= 0 : null}
                            icon={Activity}
                            description="Slippage vs mid price (negative = better)"
                        />
                    </div>
                </div>

                {/* Edge Metrics */}
                <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Edge & Costs</div>
                    <div className="grid grid-cols-2 gap-2">
                        <CostMetric
                            label="Edge"
                            value={edge.value}
                            suffix=" bps"
                            positive={edge.positive}
                            icon={TrendingUp}
                            description="Quoting skill (intent vs mid)"
                        />
                        <CostMetric
                            label="Spread Paid"
                            value={costs.avgSpreadPaidBps}
                            suffix=" bps"
                            positive={costs.avgSpreadPaidBps !== null ? costs.avgSpreadPaidBps < 10 : null}
                            icon={Layers}
                            description="Execution cost (fill vs mid)"
                        />
                    </div>
                </div>

                {/* Net Edge - Highlighted */}
                <div className="bg-white/5 rounded-lg p-3 border border-white/10">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">Net Edge</div>
                            <div className="text-[9px] text-slate-600">edge − spread − fees</div>
                        </div>
                        <div className={clsx(
                            'text-lg font-mono font-bold',
                            netEdge.positive === true && 'text-emerald-400',
                            netEdge.positive === false && 'text-red-400',
                            netEdge.positive === null && 'text-slate-300'
                        )}>
                            {netEdge.value}{costs.avgNetEdgeBpsVsMid !== null ? ' bps' : ''}
                        </div>
                    </div>
                </div>

                {/* Fees & Fill Stats */}
                <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Fees & Fills</div>
                    <div className="grid grid-cols-2 gap-2">
                        <CostMetric
                            label="Total Tx Fees"
                            value={costs.totalTxFeeXrp !== null ? costs.totalTxFeeXrp.toFixed(6) : null}
                            suffix=" XRP"
                            positive={null}
                            icon={DollarSign}
                        />
                        <CostMetric
                            label="Avg Fill Ratio"
                            value={costs.avgFillRatio !== null ? (costs.avgFillRatio * 100).toFixed(0) : null}
                            suffix="%"
                            positive={costs.avgFillRatio !== null ? costs.avgFillRatio > 0.9 : null}
                            icon={Percent}
                        />
                    </div>
                </div>

                {/* Partial Fill Warning */}
                {costs.partialFillRatio > 0.1 && (
                    <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2 text-xs text-amber-400">
                        <AlertTriangle size={14} />
                        <span>{(costs.partialFillRatio * 100).toFixed(0)}% partial fills</span>
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

export default CostRealismPanel;
