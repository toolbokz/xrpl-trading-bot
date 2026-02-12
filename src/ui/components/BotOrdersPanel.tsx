'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ListOrdered, RefreshCw, Loader2, X, AlertCircle } from 'lucide-react';
import { Panel, PanelAction, PanelBadge } from './Panel';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Active (on-ledger) offer from GET /api/bot/orders */
interface ActiveOffer {
    sequence: number;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    createdAt: number;
    age: number; // seconds
}

/** Executed / cancelled trade from GET /api/bot/trades */
interface HistoricalTrade {
    id: string;
    timestamp: number;
    pair: string;
    side: 'BUY' | 'SELL';
    price: number;
    amount: number;
    filled: number;
    fee: number;
    pnl: number;
    hash?: string;
    paper: boolean;
    status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'PENDING';
}

/** Merged row displayed in the table */
interface OrderRow {
    key: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    filled: number;
    status: 'ACTIVE' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';
    age: string;       // human-readable
    timestamp: number;  // for sorting
    sequence?: number | undefined;  // only for active offers (cancel target)
    hash?: string | undefined;
    paper?: boolean | undefined;
    pnl?: number | undefined;
}

type TabFilter = 'all' | 'active' | 'executed' | 'cancelled' | 'live';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatAge(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
}

function formatTimeAgo(ts: number): string {
    const diff = (Date.now() - ts) / 1000;
    return formatAge(diff);
}

function formatPrice(p: number | null | undefined): string {
    if (p == null) return '—';
    return p >= 1 ? p.toFixed(4) : p.toFixed(6);
}

function formatSize(s: number | null | undefined): string {
    if (s == null) return '—';
    return s >= 1000 ? s.toFixed(0) : s.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status badge
// ─────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: OrderRow['status'] }) {
    const styles: Record<OrderRow['status'], string> = {
        ACTIVE: 'bg-sky-500/20 text-sky-400',
        FILLED: 'bg-emerald-500/20 text-emerald-400',
        PARTIAL: 'bg-amber-500/20 text-amber-400',
        CANCELLED: 'bg-slate-500/20 text-slate-400',
        REJECTED: 'bg-red-500/20 text-red-400',
    };

    return (
        <span className={clsx('px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase', styles[status])}>
            {status}
        </span>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export interface BotOrdersPanelProps {
    pollInterval?: number;
}

export function BotOrdersPanel({ pollInterval = 5000 }: BotOrdersPanelProps) {
    const [activeOffers, setActiveOffers] = useState<ActiveOffer[]>([]);
    const [trades, setTrades] = useState<HistoricalTrade[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [cancellingSeq, setCancellingSeq] = useState<number | null>(null);
    const [tab, setTab] = useState<TabFilter>('live');
    const mountedRef = useRef(true);

    // ── Fetch active offers ──
    const fetchOrders = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/orders');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (mountedRef.current) {
                setActiveOffers(data.orders ?? []);
            }
        } catch {
            // non-critical — keep previous state
        }
    }, []);

    // ── Fetch executed trades ──
    const fetchTrades = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/trades?limit=100');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (mountedRef.current) {
                setTrades(data.trades ?? []);
            }
        } catch {
            // non-critical
        }
    }, []);

    // ── Combined initial fetch ──
    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            await Promise.all([fetchOrders(), fetchTrades()]);
        } catch (err: unknown) {
            if (mountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to fetch orders');
            }
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, [fetchOrders, fetchTrades]);

    useEffect(() => {
        mountedRef.current = true;
        refresh();
        const iv = setInterval(refresh, pollInterval);
        return () => {
            mountedRef.current = false;
            clearInterval(iv);
        };
    }, [refresh, pollInterval]);

    // ── Cancel an active offer ──
    const cancelOffer = useCallback(async (sequence: number) => {
        setCancellingSeq(sequence);
        try {
            const res = await fetch('/api/bot/orders', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sequence }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            // Immediately refresh after cancel
            await refresh();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Cancel failed');
        } finally {
            setCancellingSeq(null);
        }
    }, [refresh]);

    // ── Merge active offers + historical trades into unified rows ──
    const rows: OrderRow[] = useMemo(() => {
        const result: OrderRow[] = [];

        // Active on-ledger offers
        for (const o of activeOffers) {
            result.push({
                key: `active-${o.sequence}`,
                side: o.side,
                price: o.price,
                size: o.size,
                filled: 0,
                status: 'ACTIVE',
                age: formatAge(o.age),
                timestamp: Date.now() - o.age * 1000,
                sequence: o.sequence,
            });
        }

        // Historical trades
        for (const t of trades) {
            let status: OrderRow['status'];
            if (t.status === 'FILLED') status = 'FILLED';
            else if (t.status === 'PARTIAL') status = 'PARTIAL';
            else if (t.status === 'REJECTED') status = 'CANCELLED';
            else status = 'FILLED'; // PENDING → treat as filled for display

            result.push({
                key: `trade-${t.id}`,
                side: t.side,
                price: t.price,
                size: t.amount,
                filled: t.filled,
                status,
                age: formatTimeAgo(t.timestamp),
                timestamp: t.timestamp,
                hash: t.hash,
                paper: t.paper,
                pnl: t.pnl,
            });
        }

        // Sort: active first, then most recent
        result.sort((a, b) => {
            if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
            if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
            return b.timestamp - a.timestamp;
        });

        return result;
    }, [activeOffers, trades]);

    // ── Filter by tab ──
    const filtered = useMemo(() => {
        switch (tab) {
            case 'active':
                return rows.filter((r) => r.status === 'ACTIVE');
            case 'executed':
                return rows.filter((r) => r.status === 'FILLED' || r.status === 'PARTIAL');
            case 'cancelled':
                return rows.filter((r) => r.status === 'CANCELLED' || r.status === 'REJECTED');
            case 'live':
                return rows.filter((r) => !r.paper);
            default:
                return rows;
        }
    }, [rows, tab]);

    const activeCount = activeOffers.length;
    const filledCount = trades.filter((t) => t.status === 'FILLED' || t.status === 'PARTIAL').length;
    const liveCount = rows.filter((r) => !r.paper).length;
    const isEmpty = rows.length === 0;

    // ── Tab buttons ──
    const tabs: { key: TabFilter; label: string; count?: number }[] = [
        { key: 'live', label: 'Live', count: liveCount },
        { key: 'active', label: 'Active', count: activeCount },
        { key: 'executed', label: 'Executed', count: filledCount },
        { key: 'cancelled', label: 'Cancelled' },
        { key: 'all', label: 'All', count: rows.length },
    ];

    return (
        <Panel
            title="Bot Orders"
            icon={ListOrdered}
            fillHeight
            compact
            actions={
                <>
                    {activeCount > 0 && (
                        <PanelBadge tone="success">{activeCount} open</PanelBadge>
                    )}
                    <PanelAction icon={RefreshCw} onClick={refresh} label="Refresh" active={loading} />
                </>
            }
            bodyClassName="p-0 flex flex-col"
        >
            {/* ── Tab bar ── */}
            <div className="flex items-center gap-0.5 px-2 py-1 border-b border-white/5 shrink-0">
                {tabs.map((t) => (
                    <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        className={clsx(
                            'px-2 py-0.5 text-[10px] font-medium rounded transition-colors',
                            tab === t.key
                                ? 'bg-white/10 text-slate-200'
                                : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                        )}
                    >
                        {t.label}
                        {t.count !== undefined && t.count > 0 && (
                            <span className="ml-1 text-[9px] opacity-60">{t.count}</span>
                        )}
                    </button>
                ))}
            </div>

            {/* ── Loading overlay ── */}
            {loading && isEmpty && (
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex items-center gap-1.5 text-slate-400">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span className="text-[11px]">Loading orders…</span>
                    </div>
                </div>
            )}

            {/* ── Error state ── */}
            {error && (
                <div className="px-2.5 py-1.5 text-[10px] text-red-400 bg-red-500/10 flex items-center gap-1.5">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    <span className="truncate">{error}</span>
                </div>
            )}

            {/* ── Empty state ── */}
            {!loading && !error && isEmpty && (
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center text-slate-500">
                        <ListOrdered className="w-5 h-5 mx-auto mb-1 opacity-50" />
                        <p className="text-[11px]">No orders yet</p>
                        <p className="text-[9px] mt-0.5">Orders will appear when the bot trades</p>
                    </div>
                </div>
            )}

            {/* ── Column headers ── */}
            {filtered.length > 0 && (
                <div className="grid grid-cols-[52px_1fr_1fr_1fr_56px_28px] gap-1 px-2.5 py-1 text-[9px] text-slate-500 uppercase tracking-wider border-b border-white/5 shrink-0">
                    <div>Side</div>
                    <div className="text-right">Price</div>
                    <div className="text-right">Size</div>
                    <div className="text-right">Age</div>
                    <div className="text-center">Status</div>
                    <div />
                </div>
            )}

            {/* ── Order rows ── */}
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {filtered.map((row) => (
                    <div
                        key={row.key}
                        className={clsx(
                            'grid grid-cols-[52px_1fr_1fr_1fr_56px_28px] gap-1 px-2.5 py-1 text-[11px] font-mono items-center',
                            'border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors'
                        )}
                    >
                        {/* Side */}
                        <div
                            className={clsx(
                                'font-semibold text-[10px]',
                                row.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'
                            )}
                        >
                            {row.side}
                        </div>

                        {/* Price */}
                        <div className="text-right text-slate-300">{formatPrice(row.price)}</div>

                        {/* Size */}
                        <div className="text-right text-slate-300">
                            {formatSize(row.size)}
                            {row.status === 'PARTIAL' && row.filled > 0 && (
                                <span className="text-slate-500 text-[9px] ml-0.5">
                                    ({formatSize(row.filled)})
                                </span>
                            )}
                        </div>

                        {/* Age */}
                        <div className="text-right text-slate-500">{row.age}</div>

                        {/* Status badge */}
                        <div className="text-center">
                            <StatusBadge status={row.status} />
                        </div>

                        {/* Cancel button (active offers only) */}
                        <div className="flex justify-center">
                            {row.status === 'ACTIVE' && row.sequence != null && (
                                <button
                                    onClick={() => cancelOffer(row.sequence!)}
                                    disabled={cancellingSeq === row.sequence}
                                    title="Cancel offer"
                                    className={clsx(
                                        'p-0.5 rounded transition-colors',
                                        cancellingSeq === row.sequence
                                            ? 'text-slate-600 cursor-wait'
                                            : 'text-slate-500 hover:text-red-400 hover:bg-red-500/10'
                                    )}
                                >
                                    {cancellingSeq === row.sequence ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                        <X className="w-3 h-3" />
                                    )}
                                </button>
                            )}
                        </div>

                        {/* PnL row detail (executed trades with non-zero PnL) */}
                        {/* PnL + paper badge row */}
                        {(row.pnl != null && row.pnl !== 0) || row.paper ? (
                            <div className="col-span-6 text-[9px] pl-[52px] -mt-0.5 mb-0.5">
                                {row.pnl != null && row.pnl !== 0 && (
                                    <span className={row.pnl > 0 ? 'text-emerald-500' : 'text-red-500'}>
                                        PnL: {row.pnl > 0 ? '+' : ''}{row.pnl.toFixed(6)}
                                    </span>
                                )}
                                {row.paper && (
                                    <span className="ml-1.5 px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[8px] font-semibold">PAPER</span>
                                )}
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>
        </Panel>
    );
}
