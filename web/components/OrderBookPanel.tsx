'use client';

import { useMemo } from 'react';
import clsx from 'clsx';
import { BookOpen, RefreshCw } from 'lucide-react';
import { Panel, PanelAction, PanelBadge } from './Panel';

interface OrderBookEntry {
    price: number;
    size: number;
    total: number;
}

interface OrderBookPanelProps {
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
    midPrice: number | null;
    spreadBps: number;
    loading?: boolean;
    onRefresh?: () => void;
    maxRows?: number;
}

export function OrderBookPanel({
    bids = [],
    asks = [],
    midPrice,
    spreadBps,
    loading,
    onRefresh,
    maxRows = 12,
}: OrderBookPanelProps) {
    // Limit rows displayed
    const displayBids = useMemo(() => bids.slice(0, maxRows), [bids, maxRows]);
    const displayAsks = useMemo(() => asks.slice(0, maxRows).reverse(), [asks, maxRows]);

    // Calculate max total for depth visualization
    const maxTotal = useMemo(() => {
        const allTotals = [...bids, ...asks].map((e) => e.total);
        return Math.max(...allTotals, 1);
    }, [bids, asks]);

    const formatPrice = (p: number) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
    const formatSize = (s: number) => s.toFixed(2);

    return (
        <Panel
            title="Order Book"
            icon={BookOpen}
            fillHeight
            compact
            actions={
                <>
                    <PanelBadge tone={spreadBps > 50 ? 'warning' : 'neutral'}>
                        {spreadBps.toFixed(1)} bps
                    </PanelBadge>
                    {onRefresh && (
                        <PanelAction
                            icon={RefreshCw}
                            onClick={onRefresh}
                            label="Refresh"
                            active={loading}
                        />
                    )}
                </>
            }
            bodyClassName="p-0 flex flex-col"
        >
            {/* Column headers */}
            <div className="grid grid-cols-3 gap-1 px-3 py-1.5 text-[10px] text-slate-500 uppercase tracking-wider border-b border-white/5">
                <div>Price</div>
                <div className="text-right">Size</div>
                <div className="text-right">Total</div>
            </div>

            {/* Asks (sells) - reversed so lowest ask is at bottom */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col justify-end">
                {displayAsks.map((entry, i) => (
                    <div
                        key={`ask-${i}`}
                        className="relative grid grid-cols-3 gap-1 px-3 py-1 text-xs font-mono"
                    >
                        {/* Depth bar */}
                        <div
                            className="absolute inset-y-0 right-0 bg-red-500/10"
                            style={{ width: `${(entry.total / maxTotal) * 100}%` }}
                        />
                        <div className="relative text-red-400">{formatPrice(entry.price)}</div>
                        <div className="relative text-right text-slate-300">{formatSize(entry.size)}</div>
                        <div className="relative text-right text-slate-500">{formatSize(entry.total)}</div>
                    </div>
                ))}
            </div>

            {/* Mid price / spread divider */}
            <div className="flex items-center justify-between px-3 py-2 bg-white/5 border-y border-white/5">
                <span className="text-sm font-semibold text-slate-100 font-mono">
                    {midPrice !== null ? formatPrice(midPrice) : '—'}
                </span>
                <span className="text-[10px] text-slate-500">
                    Spread: {spreadBps.toFixed(1)} bps
                </span>
            </div>

            {/* Bids (buys) */}
            <div className="flex-1 min-h-0 overflow-hidden">
                {displayBids.map((entry, i) => (
                    <div
                        key={`bid-${i}`}
                        className="relative grid grid-cols-3 gap-1 px-3 py-1 text-xs font-mono"
                    >
                        {/* Depth bar */}
                        <div
                            className="absolute inset-y-0 right-0 bg-emerald-500/10"
                            style={{ width: `${(entry.total / maxTotal) * 100}%` }}
                        />
                        <div className="relative text-emerald-400">{formatPrice(entry.price)}</div>
                        <div className="relative text-right text-slate-300">{formatSize(entry.size)}</div>
                        <div className="relative text-right text-slate-500">{formatSize(entry.total)}</div>
                    </div>
                ))}
            </div>
        </Panel>
    );
}
