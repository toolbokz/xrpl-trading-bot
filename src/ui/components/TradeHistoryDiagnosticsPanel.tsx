'use client';

/**
 * TradeHistoryDiagnosticsPanel — Diagnostics → Trade History sub-tab
 *
 * Displays the last 10 trades with computed post-trade diagnostics.
 * Auto-refreshes via polling (default 10s) and also re-fetches when
 * ORDER_FILLED runtime events arrive (wired in page.tsx via the
 * existing hasOrderFilledEvent mechanism).
 *
 * Data flow:
 * - Polls GET /api/analytics/trade-diagnostics?limit=10
 * - Diagnostics are derived on read by the API (no separate storage)
 * - The underlying trade_history.json is written by OfferExecutor;
 *   WebTradeHistoryService mtime-checks for cache invalidation
 */

import { useCallback, useEffect, useMemo, useState, Fragment } from 'react';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { Panel, PanelBadge } from './Panel';

/* ────── types (mirrored from postTradeDiagnostic.ts, kept minimal) ────── */

interface PostTradeDiagnostic {
    tradeId: string;
    pair: string;
    side: string;
    status: string;
    timestamp: number;
    eventBucket: string;
    primaryCause: string;
    spreadRegime: string | null;
    baselineBestBid: number | null;
    baselineBestAsk: number | null;
    baselineMid: number | null;
    baselineSpreadBps: number | null;
    requiredBase: number | null;
    minRequiredBase: number | null;
    predFillableBase: number | null;
    predFillRatio: number | null;
    predictedVwap: number | null;
    predictedWorstPrice: number | null;
    precheckHasDepth: boolean | null;
    filledBase: number | null;
    filledQuote: number | null;
    actualFillRatio: number | null;
    avgFillPriceQpb: number | null;
    fee: number | null;
    slippageBpsLogged: number | null;
    priceVsArrivalBps: number | null;
    distanceFromMidBps: number | null;
    fillVsPredVwapBps: number | null;
    predictedVsActualFillRatioGap: number | null;
    engineResult: string | null;
    engineResultCode: number | null;
    engineResultMessage: string | null;
    ackStatus: string | null;
    outcome: string | null;
    outcomeReason: string | null;
    txHash: string | null;
    sequence: number | null;
    retryCount: number;
    repriceDecision: string | null;
    repricedPrice: number | null;
    requiredRepriceBps: number | null;
    decisionToSubmitMs: number | null;
    submitToAckMs: number | null;
    ackToValidatedMs: number | null;
    decisionToValidatedMs: number | null;
    markout60sStatus: string | null;
    markout60sBps: number | null;
    markout300sStatus: string | null;
    markout300sBps: number | null;
    notes: string[];
}

/* ────── formatting helpers ────── */

function fmtBps(v: number | null): string {
    if (v == null) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

function fmtPct(v: number | null): string {
    if (v == null) return '—';
    return `${(v * 100).toFixed(1)}%`;
}

function fmtPrice(v: number | null): string {
    if (v == null) return '—';
    return v.toFixed(6);
}

function fmtMs(v: number | null): string {
    if (v == null) return '—';
    return `${v.toFixed(0)}ms`;
}

function fmtTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
}

/* ────── status / bucket colours ────── */

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
    switch (status.toUpperCase()) {
        case 'FILLED': return 'success';
        case 'PARTIAL': return 'warning';
        case 'REJECTED': return 'danger';
        default: return 'neutral';
    }
}

function bucketLabel(bucket: string): string {
    switch (bucket) {
        case 'PRE_SUBMIT_REJECT': return 'Pre-Submit';
        case 'XRPL_NO_FILL': return 'No Fill';
        case 'XRPL_PARTIAL': return 'Partial';
        case 'XRPL_FILLED': return 'Filled';
        default: return bucket;
    }
}

function causeLabel(cause: string): string {
    switch (cause) {
        case 'BOT_MIN_SIZE': return 'Min Size';
        case 'IOC_NO_MATCH_AT_LIMIT': return 'IOC Killed';
        case 'PARTIAL_LIQUIDITY': return 'Partial Liq';
        case 'CLEAN_SPREAD_CROSS': return 'Clean Cross';
        default: return 'Other';
    }
}

const statusColorMap: Record<string, string> = {
    success: 'text-emerald-400',
    warning: 'text-amber-400',
    danger: 'text-red-400',
    neutral: 'text-slate-400',
};

const statusBgMap: Record<string, string> = {
    success: 'bg-emerald-500/10',
    warning: 'bg-amber-500/10',
    danger: 'bg-red-500/10',
    neutral: 'bg-white/5',
};

/* ────── component ────── */

export interface TradeHistoryDiagnosticsPanelProps {
    pollInterval?: number;
    enabled?: boolean;
    /** Bump this number to force a re-fetch (e.g. on ORDER_FILLED event) */
    refreshSeq?: number;
}

export function TradeHistoryDiagnosticsPanel({
    pollInterval = 10_000,
    enabled = true,
    refreshSeq = 0,
}: TradeHistoryDiagnosticsPanelProps) {
    const [diagnostics, setDiagnostics] = useState<PostTradeDiagnostic[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const fetchDiagnostics = useCallback(async () => {
        try {
            const res = await fetch('/api/analytics/trade-diagnostics?limit=25', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data?.diagnostics) {
                setDiagnostics(data.diagnostics);
            }
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load diagnostics');
        } finally {
            setLoading(false);
        }
    }, []);

    // Initial fetch + polling
    useEffect(() => {
        if (!enabled) return;
        void fetchDiagnostics();
        const iv = setInterval(() => void fetchDiagnostics(), Math.max(2000, pollInterval));
        return () => clearInterval(iv);
    }, [enabled, fetchDiagnostics, pollInterval]);

    // Re-fetch on external trigger (ORDER_FILLED events)
    useEffect(() => {
        if (refreshSeq > 0) {
            void fetchDiagnostics();
        }
    }, [refreshSeq, fetchDiagnostics]);

    const panelTone = useMemo<'neutral' | 'success' | 'danger'>(() => {
        if (diagnostics.length === 0) return 'neutral';
        const latest = diagnostics[0];
        if (!latest) return 'neutral';
        if (latest.status === 'FILLED') return 'success';
        if (latest.status === 'REJECTED') return 'danger';
        return 'neutral';
    }, [diagnostics]);

    const toggleExpand = (id: string) => {
        setExpandedId(prev => prev === id ? null : id);
    };

    if (!enabled) return null;

    return (
        <Panel
            title="Trade History"
            icon={Activity}
            dense
            scrollable
            fillHeight
            actions={
                <PanelBadge tone={panelTone}>
                    {diagnostics.length} trade{diagnostics.length !== 1 ? 's' : ''}
                </PanelBadge>
            }
        >
            {loading && diagnostics.length === 0 && (
                <div className="flex items-center justify-center py-8 text-xs text-slate-500">
                    Loading trade diagnostics…
                </div>
            )}

            {error && (
                <div className="rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
                    {error}
                </div>
            )}

            {!loading && !error && diagnostics.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8 text-xs text-slate-500">
                    <Activity size={20} className="mb-2 opacity-40" />
                    No trades recorded yet
                </div>
            )}

            {diagnostics.length > 0 && (
                <div className="space-y-0.5">
                    {/* Header row */}
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)] gap-x-1.5 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                        <span>Time</span>
                        <span>Pair</span>
                        <span>Side</span>
                        <span>Status</span>
                        <span>Bucket</span>
                        <span>Cause</span>
                        <span>Spread</span>
                        <span>Pred Fill</span>
                        <span>Act Fill</span>
                        <span>Avg Price</span>
                        <span>vs Arrival</span>
                        <span>Retry</span>
                    </div>

                    {diagnostics.map((d) => {
                        const tone = statusTone(d.status);
                        const isExpanded = expandedId === d.tradeId;

                        return (
                            <Fragment key={d.tradeId}>
                                {/* Summary row */}
                                <button
                                    onClick={() => toggleExpand(d.tradeId)}
                                    className={clsx(
                                        'grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)] gap-x-1.5 rounded px-1 py-1 text-left text-[10px] transition-colors',
                                        isExpanded ? 'bg-sky-500/10' : `hover:${statusBgMap[tone]}`,
                                        statusBgMap[tone],
                                    )}
                                >
                                    <span className="text-slate-400 truncate" title={fmtDate(d.timestamp)}>
                                        {fmtTime(d.timestamp)}
                                    </span>
                                    <span className="text-slate-300 truncate">{d.pair || '—'}</span>
                                    <span className={d.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>
                                        {d.side}
                                    </span>
                                    <span className={statusColorMap[tone]}>
                                        {d.status}
                                    </span>
                                    <span className="text-slate-300 truncate">{bucketLabel(d.eventBucket)}</span>
                                    <span className="text-slate-400 truncate" title={d.primaryCause}>{causeLabel(d.primaryCause)}</span>
                                    <span className="text-slate-300">{d.baselineSpreadBps != null ? `${d.baselineSpreadBps.toFixed(1)}` : '—'}</span>
                                    <span className="text-slate-300">{fmtPct(d.predFillRatio)}</span>
                                    <span className={clsx(
                                        d.actualFillRatio != null && d.actualFillRatio >= 1 ? 'text-emerald-400'
                                            : d.actualFillRatio != null && d.actualFillRatio > 0 ? 'text-amber-400'
                                                : 'text-slate-400'
                                    )}>
                                        {fmtPct(d.actualFillRatio)}
                                    </span>
                                    <span className="text-slate-300 truncate">{fmtPrice(d.avgFillPriceQpb)}</span>
                                    <span className={clsx(
                                        'tabular-nums',
                                        d.priceVsArrivalBps != null && d.priceVsArrivalBps <= 0 ? 'text-emerald-400'
                                            : d.priceVsArrivalBps != null && d.priceVsArrivalBps > 3 ? 'text-red-400'
                                                : 'text-slate-300'
                                    )}>
                                        {fmtBps(d.priceVsArrivalBps)}
                                    </span>
                                    <span className="flex items-center gap-0.5 text-slate-400">
                                        {d.retryCount}
                                        {isExpanded
                                            ? <ChevronDown size={10} className="shrink-0" />
                                            : <ChevronRight size={10} className="shrink-0" />}
                                    </span>
                                </button>

                                {/* Expanded detail */}
                                {isExpanded && (
                                    <div className="mb-1 ml-2 rounded border border-white/5 bg-card/60 px-3 py-2 text-[10px] text-slate-300">
                                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3 lg:grid-cols-4">
                                            {/* Timing */}
                                            <DetailSection title="Timing">
                                                <DetailRow label="Decision→Submit" value={fmtMs(d.decisionToSubmitMs)} />
                                                <DetailRow label="Submit→Ack" value={fmtMs(d.submitToAckMs)} />
                                                <DetailRow label="Ack→Validated" value={fmtMs(d.ackToValidatedMs)} />
                                                <DetailRow label="Total" value={fmtMs(d.decisionToValidatedMs)} />
                                            </DetailSection>

                                            {/* Execution quality */}
                                            <DetailSection title="Quality">
                                                <DetailRow label="vs Arrival" value={`${fmtBps(d.priceVsArrivalBps)} bps`} />
                                                <DetailRow label="vs Mid" value={`${fmtBps(d.distanceFromMidBps)} bps`} />
                                                <DetailRow label="vs Pred VWAP" value={`${fmtBps(d.fillVsPredVwapBps)} bps`} />
                                                <DetailRow label="Fill Gap" value={d.predictedVsActualFillRatioGap != null ? d.predictedVsActualFillRatioGap.toFixed(3) : '—'} />
                                                <DetailRow label="Slippage (logged)" value={d.slippageBpsLogged != null ? `${d.slippageBpsLogged.toFixed(1)} bps` : '—'} />
                                            </DetailSection>

                                            {/* Reprice */}
                                            <DetailSection title="Reprice">
                                                <DetailRow label="Decision" value={d.repriceDecision ?? '—'} />
                                                <DetailRow label="Repriced Price" value={fmtPrice(d.repricedPrice)} />
                                                <DetailRow label="Required bps" value={d.requiredRepriceBps != null ? d.requiredRepriceBps.toFixed(1) : '—'} />
                                                <DetailRow label="Regime" value={d.spreadRegime ?? '—'} />
                                            </DetailSection>

                                            {/* XRPL */}
                                            <DetailSection title="XRPL Result">
                                                <DetailRow label="Engine" value={d.engineResult ?? '—'} />
                                                <DetailRow label="Message" value={d.engineResultMessage ?? '—'} />
                                                <DetailRow label="Outcome" value={d.outcome ?? '—'} />
                                                {d.txHash && (
                                                    <DetailRow label="TX" value={
                                                        <a
                                                            href={`https://livenet.xrpl.org/transactions/${d.txHash}`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="text-sky-400 hover:underline truncate max-w-[120px] inline-block"
                                                            title={d.txHash}
                                                        >
                                                            {d.txHash.slice(0, 8)}…
                                                        </a>
                                                    } />
                                                )}
                                            </DetailSection>

                                            {/* Markouts */}
                                            {(d.markout60sBps != null || d.markout300sBps != null) && (
                                                <DetailSection title="Markouts">
                                                    <DetailRow label="60s" value={d.markout60sBps != null ? `${fmtBps(d.markout60sBps)} bps (${d.markout60sStatus})` : '—'} />
                                                    <DetailRow label="300s" value={d.markout300sBps != null ? `${fmtBps(d.markout300sBps)} bps (${d.markout300sStatus})` : '—'} />
                                                </DetailSection>
                                            )}

                                            {/* Precheck */}
                                            <DetailSection title="Precheck">
                                                <DetailRow label="Required" value={d.requiredBase != null ? d.requiredBase.toFixed(4) : '—'} />
                                                <DetailRow label="Pred Fillable" value={d.predFillableBase != null ? d.predFillableBase.toFixed(4) : '—'} />
                                                <DetailRow label="Has Depth" value={d.precheckHasDepth != null ? (d.precheckHasDepth ? 'Yes' : 'No') : '—'} />
                                                <DetailRow label="Pred VWAP" value={fmtPrice(d.predictedVwap)} />
                                            </DetailSection>
                                        </div>

                                        {/* Notes */}
                                        {d.notes.length > 0 && (
                                            <div className="mt-2 border-t border-white/5 pt-1.5">
                                                <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Notes</span>
                                                <ul className="mt-0.5 space-y-0.5">
                                                    {d.notes.map((note, i) => (
                                                        <li key={i} className="text-slate-400">• {note}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </Fragment>
                        );
                    })}
                </div>
            )}
        </Panel>
    );
}

/* ────── detail sub-components ────── */

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">{title}</div>
            <div className="space-y-0.5">{children}</div>
        </div>
    );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-slate-500 shrink-0">{label}</span>
            <span className="text-right truncate">{value}</span>
        </div>
    );
}
