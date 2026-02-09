'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TapeTrade {
    id: string;
    ts: number;
    pairKey: string;
    price: number;
    sizeBase: number;
    sizeQuote: number;
    side: 'buy' | 'sell';
    txHash: string;
    ledgerIndex: number;
}

export interface TradeAggression {
    buyVolumeBase: number;
    sellVolumeBase: number;
    buyCount: number;
    sellCount: number;
}

interface TradeTapeProps {
    pairKey?: string | undefined;
    maxRows?: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time Window Options
// ─────────────────────────────────────────────────────────────────────────────

const TIME_WINDOWS = [
    { label: '1m', value: 60_000 },
    { label: '5m', value: 300_000 },
    { label: '15m', value: 900_000 },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Trade Tape Component
// ─────────────────────────────────────────────────────────────────────────────

export function TradeTape({ pairKey, maxRows = 300 }: TradeTapeProps) {
    const [trades, setTrades] = useState<TapeTrade[]>([]);
    const [stats, setStats] = useState<TradeAggression>({
        buyVolumeBase: 0,
        sellVolumeBase: 0,
        buyCount: 0,
        sellCount: 0,
    });
    const [vwap, setVwap] = useState<number | null>(null);
    const [windowMs, setWindowMs] = useState<number>(60_000);
    const [autoScroll, setAutoScroll] = useState(true);
    const [connected, setConnected] = useState(false);
    const [newTradeIds, setNewTradeIds] = useState<Set<string>>(new Set());

    const containerRef = useRef<HTMLDivElement>(null);
    const eventSourceRef = useRef<EventSource | null>(null);

    // Fetch initial trades via REST
    const fetchInitialTrades = useCallback(async () => {
        try {
            const params = new URLSearchParams({
                windowMs: windowMs.toString(),
                limit: maxRows.toString(),
            });
            if (pairKey) params.set('pair', pairKey);

            const res = await fetch(`/api/trades/tape?${params}`);
            if (!res.ok) return;

            const data = await res.json();
            setTrades(data.trades ?? []);
            setStats(data.stats ?? { buyVolumeBase: 0, sellVolumeBase: 0, buyCount: 0, sellCount: 0 });
            setVwap(data.vwap);
        } catch (err) {
            console.error('Failed to fetch trade tape:', err);
        }
    }, [windowMs, maxRows, pairKey]);

    // Connect to SSE stream
    const connectStream = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const params = new URLSearchParams();
        if (pairKey) params.set('pair', pairKey);

        const es = new EventSource(`/api/trades/stream?${params}`);
        eventSourceRef.current = es;

        es.addEventListener('connected', () => {
            setConnected(true);
        });

        es.addEventListener('trade', (event) => {
            try {
                const trade = JSON.parse(event.data) as TapeTrade;

                // Add to trades list
                setTrades((prev) => {
                    // Skip if we already have this trade
                    if (prev.some(t => t.id === trade.id)) return prev;

                    // Add new trade and trim to max rows
                    const next = [trade, ...prev].slice(0, maxRows);
                    return next;
                });

                // Mark as new for flash animation
                setNewTradeIds((prev) => {
                    const next = new Set(prev);
                    next.add(trade.id);
                    return next;
                });

                // Clear flash after animation
                setTimeout(() => {
                    setNewTradeIds((prev) => {
                        const next = new Set(prev);
                        next.delete(trade.id);
                        return next;
                    });
                }, 1000);

                // Update stats (simplified - refetch periodically for accuracy)
                setStats((prev) => ({
                    buyVolumeBase: prev.buyVolumeBase + (trade.side === 'buy' ? trade.sizeBase : 0),
                    sellVolumeBase: prev.sellVolumeBase + (trade.side === 'sell' ? trade.sizeBase : 0),
                    buyCount: prev.buyCount + (trade.side === 'buy' ? 1 : 0),
                    sellCount: prev.sellCount + (trade.side === 'sell' ? 1 : 0),
                }));
            } catch (err) {
                console.error('Failed to parse trade event:', err);
            }
        });

        es.addEventListener('ping', () => {
            // Keepalive received
        });

        es.onerror = () => {
            setConnected(false);
            // Reconnect after 5 seconds
            setTimeout(() => {
                connectStream();
            }, 5000);
        };
    }, [pairKey, maxRows]);

    // Fetch initial data and connect stream
    useEffect(() => {
        fetchInitialTrades();
        connectStream();

        // Refresh stats periodically (30s - SSE handles real-time updates)
        const statsInterval = setInterval(() => {
            fetchInitialTrades();
        }, 30_000);

        return () => {
            clearInterval(statsInterval);
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
        };
    }, [fetchInitialTrades, connectStream]);

    // Auto-scroll to top when new trades arrive
    useEffect(() => {
        if (autoScroll && containerRef.current && trades.length > 0) {
            containerRef.current.scrollTop = 0;
        }
    }, [trades.length, autoScroll]);

    // Format time as HH:MM:SS
    const formatTime = (ts: number): string => {
        const d = new Date(ts);
        return d.toLocaleTimeString('en-US', { hour12: false });
    };

    // Format price with appropriate precision
    const formatPrice = (price: number): string => {
        if (price >= 1) return price.toFixed(4);
        if (price >= 0.001) return price.toFixed(6);
        return price.toFixed(8);
    };

    // Calculate buy/sell ratio
    const buyRatio = useMemo(() => {
        const total = stats.buyVolumeBase + stats.sellVolumeBase;
        if (total === 0) return 50;
        return (stats.buyVolumeBase / total) * 100;
    }, [stats]);

    return (
        <div className="card p-6 space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="panel-header">Trade Tape</div>
                    <div className={clsx(
                        'w-2 h-2 rounded-full',
                        connected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                    )} />
                </div>
                <div className="flex items-center gap-3">
                    {/* Time window selector */}
                    <div className="flex rounded-lg bg-white/5 p-1">
                        {TIME_WINDOWS.map((tw) => (
                            <button
                                key={tw.value}
                                onClick={() => setWindowMs(tw.value)}
                                className={clsx(
                                    'px-2.5 py-1 text-xs rounded-md transition-colors',
                                    windowMs === tw.value
                                        ? 'bg-sky-500/30 text-sky-300'
                                        : 'text-slate-400 hover:text-slate-200'
                                )}
                            >
                                {tw.label}
                            </button>
                        ))}
                    </div>
                    {/* Auto-scroll toggle */}
                    <button
                        onClick={() => setAutoScroll(!autoScroll)}
                        className={clsx(
                            'px-2.5 py-1 text-xs rounded-lg transition-colors',
                            autoScroll ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-slate-400'
                        )}
                        title="Auto-scroll"
                    >
                        ↓
                    </button>
                </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-xl bg-white/5 px-4 py-2.5">
                    <div className="text-xs text-slate-400 uppercase tracking-wide">VWAP</div>
                    <div className="text-slate-100 font-mono mt-0.5">
                        {vwap !== null ? formatPrice(vwap) : '—'}
                    </div>
                </div>
                <div className="rounded-xl bg-white/5 px-4 py-2.5">
                    <div className="text-xs text-slate-400 uppercase tracking-wide">Buy Vol</div>
                    <div className="text-emerald-400 font-mono mt-0.5">
                        {stats.buyVolumeBase.toFixed(2)}
                    </div>
                </div>
                <div className="rounded-xl bg-white/5 px-4 py-2.5">
                    <div className="text-xs text-slate-400 uppercase tracking-wide">Sell Vol</div>
                    <div className="text-red-400 font-mono mt-0.5">
                        {stats.sellVolumeBase.toFixed(2)}
                    </div>
                </div>
            </div>

            {/* Buy/Sell ratio bar */}
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden flex">
                <div
                    className="bg-emerald-500 transition-all duration-500"
                    style={{ width: `${buyRatio}%` }}
                />
                <div
                    className="bg-red-500 transition-all duration-500"
                    style={{ width: `${100 - buyRatio}%` }}
                />
            </div>

            {/* Trade list header */}
            <div className="grid grid-cols-[60px_50px_1fr_1fr_1fr] gap-3 px-3 text-xs text-slate-500 uppercase tracking-wider">
                <div>Time</div>
                <div>Side</div>
                <div className="text-right">Price</div>
                <div className="text-right">Size</div>
                <div className="text-right">Value</div>
            </div>

            {/* Trade list */}
            <div
                ref={containerRef}
                className="space-y-1.5 max-h-[320px] overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
            >
                {trades.length === 0 ? (
                    <div className="text-center text-slate-500 py-8">
                        No trades yet
                    </div>
                ) : (
                    trades.map((t) => (
                        <div
                            key={t.id}
                            className={clsx(
                                'grid grid-cols-[60px_50px_1fr_1fr_1fr] gap-3 px-3 py-2 rounded-lg text-sm font-mono transition-colors',
                                newTradeIds.has(t.id) && 'animate-flash',
                                t.side === 'buy' ? 'bg-emerald-500/10' : 'bg-red-500/10'
                            )}
                        >
                            <div className="text-slate-400 text-xs">
                                {formatTime(t.ts)}
                            </div>
                            <div className={clsx(
                                'text-xs font-semibold',
                                t.side === 'buy' ? 'text-emerald-400' : 'text-red-400'
                            )}>
                                {t.side.toUpperCase()}
                            </div>
                            <div className="text-right text-slate-200">
                                {formatPrice(t.price)}
                            </div>
                            <div className="text-right text-slate-300">
                                {t.sizeBase.toFixed(2)}
                            </div>
                            <div className="text-right text-slate-400">
                                {t.sizeQuote.toFixed(2)}
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-white/5">
                <span>{trades.length} trades</span>
                <a
                    href={trades[0]?.txHash ? `https://${process.env.NEXT_PUBLIC_XRPL_NETWORK === 'testnet' ? 'testnet' : 'livenet'}.xrpl.org/transactions/${trades[0].txHash}` : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-slate-300 transition-colors"
                >
                    View on XRPL Explorer →
                </a>
            </div>
        </div>
    );
}
