'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Activity, ArrowDown, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { Panel, PanelAction, PanelBadge } from './Panel';
import {
    ResponsiveContainer,
    ScatterChart,
    Scatter,
    XAxis,
    YAxis,
    ZAxis,
    Tooltip as RechartsTooltip,
    Cell,
} from 'recharts';

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

export interface TradeTapePanelProps {
    pairKey?: string | undefined;
    maxRows?: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time Windows
// ─────────────────────────────────────────────────────────────────────────────

const TIME_WINDOWS = [
    { label: '1m', value: 60_000 },
    { label: '5m', value: 300_000 },
    { label: '15m', value: 900_000 },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Trade Scatter Chart — price vs time, dot size by trade size
// ─────────────────────────────────────────────────────────────────────────────

function TradeScatterChart({ trades }: { trades: TapeTrade[] }) {
    if (trades.length < 2) return null;

    const scatterData = trades.map(t => ({
        ts: t.ts,
        price: t.price,
        size: Math.max(t.sizeBase, 0.1),
        side: t.side,
    }));

    const minPrice = Math.min(...scatterData.map(d => d.price));
    const maxPrice = Math.max(...scatterData.map(d => d.price));
    const pricePad = (maxPrice - minPrice) * 0.1 || 0.0001;

    return (
        <ResponsiveContainer width="100%" height={72}>
            <ScatterChart margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <XAxis
                    dataKey="ts"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tick={false}
                    axisLine={false}
                />
                <YAxis
                    dataKey="price"
                    type="number"
                    domain={[minPrice - pricePad, maxPrice + pricePad]}
                    tick={false}
                    axisLine={false}
                    width={0}
                />
                <ZAxis dataKey="size" range={[15, 80]} />
                <RechartsTooltip
                    content={({ active, payload }) => {
                        if (!active || !payload?.[0]) return null;
                        const d = payload[0].payload;
                        return (
                            <div className="bg-slate-900 border border-white/10 rounded px-2 py-1 text-[10px]">
                                <div className={d.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}>
                                    {d.side.toUpperCase()} {d.size.toFixed(2)} @ {d.price.toFixed(6)}
                                </div>
                                <div className="text-slate-500">
                                    {new Date(d.ts).toLocaleTimeString()}
                                </div>
                            </div>
                        );
                    }}
                />
                <Scatter data={scatterData} isAnimationActive={false}>
                    {scatterData.map((entry, i) => (
                        <Cell
                            key={i}
                            fill={entry.side === 'buy' ? '#22c55e' : '#ef4444'}
                            fillOpacity={0.7}
                        />
                    ))}
                </Scatter>
            </ScatterChart>
        </ResponsiveContainer>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function TradeTapePanel({ pairKey, maxRows = 100 }: TradeTapePanelProps) {
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
    const [showChart, setShowChart] = useState(true);

    const containerRef = useRef<HTMLDivElement>(null);
    const eventSourceRef = useRef<EventSource | null>(null);

    // Fetch initial trades
    const fetchInitialTrades = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (pairKey) params.set('pair', pairKey);

            const res = await fetch(`/api/trades/tape?${params}`);
            if (!res.ok) return;

            // API returns PairPayload<TapeData>: { pairKey, asOfMs, data: { trades, tradeCount, lastTradeAtMs } }
            const payload = await res.json();
            const tapeData = payload?.data;
            const rawTrades: TapeTrade[] = tapeData?.trades ?? [];

            // Apply client-side window filter + limit
            const cutoff = Date.now() - windowMs;
            const filtered = rawTrades
                .filter((t: TapeTrade) => t.ts >= cutoff)
                .slice(0, maxRows);

            setTrades(filtered);

            // Compute stats client-side from filtered trades
            const computedStats = filtered.reduce(
                (acc: TradeAggression, t: TapeTrade) => ({
                    buyVolumeBase: acc.buyVolumeBase + (t.side === 'buy' ? t.sizeBase : 0),
                    sellVolumeBase: acc.sellVolumeBase + (t.side === 'sell' ? t.sizeBase : 0),
                    buyCount: acc.buyCount + (t.side === 'buy' ? 1 : 0),
                    sellCount: acc.sellCount + (t.side === 'sell' ? 1 : 0),
                }),
                { buyVolumeBase: 0, sellVolumeBase: 0, buyCount: 0, sellCount: 0 },
            );
            setStats(computedStats);

            // Compute VWAP client-side
            const totalNotional = filtered.reduce((s: number, t: TapeTrade) => s + t.price * t.sizeBase, 0);
            const totalSize = filtered.reduce((s: number, t: TapeTrade) => s + t.sizeBase, 0);
            setVwap(totalSize > 0 ? totalNotional / totalSize : null);
        } catch (err) {
            console.error('Failed to fetch trade tape:', err);
        }
    }, [windowMs, maxRows, pairKey]);

    // SSE connection
    const connectStream = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const params = new URLSearchParams();
        if (pairKey) params.set('pair', pairKey);

        const es = new EventSource(`/api/trades/stream?${params}`);
        eventSourceRef.current = es;

        es.addEventListener('connected', () => setConnected(true));

        es.addEventListener('trade', (event) => {
            try {
                const trade = JSON.parse(event.data) as TapeTrade;

                setTrades((prev) => {
                    if (prev.some(t => t.id === trade.id)) return prev;
                    return [trade, ...prev].slice(0, maxRows);
                });

                setNewTradeIds((prev) => new Set(prev).add(trade.id));
                setTimeout(() => {
                    setNewTradeIds((prev) => {
                        const next = new Set(prev);
                        next.delete(trade.id);
                        return next;
                    });
                }, 1000);

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

        es.onerror = () => {
            setConnected(false);
            setTimeout(connectStream, 5000);
        };
    }, [pairKey, maxRows]);

    useEffect(() => {
        fetchInitialTrades();
        connectStream();

        const interval = setInterval(fetchInitialTrades, 30_000);

        return () => {
            clearInterval(interval);
            eventSourceRef.current?.close();
        };
    }, [fetchInitialTrades, connectStream]);

    useEffect(() => {
        if (autoScroll && containerRef.current && trades.length > 0) {
            containerRef.current.scrollTop = 0;
        }
    }, [trades.length, autoScroll]);

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });
    const formatPrice = (p?: number | null) => {
        if (p === null || p === undefined) return '—';
        if (!Number.isFinite(p)) return '—';

        const abs = Math.abs(p);
        return abs >= 1 ? p.toFixed(4) : abs >= 0.001 ? p.toFixed(6) : p.toFixed(8);
    };


    const buyRatio = useMemo(() => {
        const total = stats.buyVolumeBase + stats.sellVolumeBase;
        return total === 0 ? 50 : (stats.buyVolumeBase / total) * 100;
    }, [stats]);

    const latestTx = trades[0]?.txHash;

    return (
        <Panel
            title="Trade Tape"
            icon={Activity}
            fillHeight
            compact
            actions={
                <>
                    <div className={clsx(
                        'w-2 h-2 rounded-full',
                        connected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                    )} />
                    <div className="flex rounded-md bg-white/5 p-0.5">
                        {TIME_WINDOWS.map((tw) => (
                            <button
                                key={tw.value}
                                onClick={() => setWindowMs(tw.value)}
                                className={clsx(
                                    'px-2 py-0.5 text-[10px] rounded transition-colors',
                                    windowMs === tw.value
                                        ? 'bg-sky-500/30 text-sky-300'
                                        : 'text-slate-500 hover:text-slate-300'
                                )}
                            >
                                {tw.label}
                            </button>
                        ))}
                    </div>
                    <PanelAction
                        icon={ArrowDown}
                        onClick={() => setAutoScroll(!autoScroll)}
                        label="Auto-scroll"
                        active={autoScroll}
                    />
                    <PanelAction
                        icon={showChart ? ChevronUp : ChevronDown}
                        onClick={() => setShowChart(!showChart)}
                        label="Toggle chart"
                    />
                </>
            }
            bodyClassName="p-0 flex flex-col"
            footer={
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span>{trades.length} trades</span>
                    {latestTx && (
                        <a
                            href={`https://livenet.xrpl.org/transactions/${latestTx}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 hover:text-slate-300 transition-colors"
                        >
                            Explorer <ExternalLink size={10} />
                        </a>
                    )}
                </div>
            }
        >
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-2 p-3 border-b border-white/5">
                <StatCell label="VWAP" value={vwap !== null ? formatPrice(vwap) : '—'} />
                <StatCell label="Buy Vol" value={stats.buyVolumeBase.toFixed(1)} tone="buy" />
                <StatCell label="Sell Vol" value={stats.sellVolumeBase.toFixed(1)} tone="sell" />
            </div>

            {/* Buy/Sell ratio bar */}
            <div className="h-1.5 flex mx-3 my-2 rounded-full overflow-hidden bg-slate-800">
                <div className="bg-emerald-500/80 transition-all" style={{ width: `${buyRatio}%` }} />
                <div className="bg-red-500/80 transition-all" style={{ width: `${100 - buyRatio}%` }} />
            </div>

            {/* Trade scatter plot (collapsible) */}
            {showChart && trades.length >= 2 && (
                <div className="px-3 pb-1 border-b border-white/5">
                    <TradeScatterChart trades={trades} />
                </div>
            )}

            {/* Trade list header */}
            <div className="grid grid-cols-[50px_40px_1fr_1fr] gap-1 px-3 py-1 text-[9px] text-slate-500 uppercase tracking-wider">
                <div>Time</div>
                <div>Side</div>
                <div className="text-right">Price</div>
                <div className="text-right">Size</div>
            </div>

            {/* Trade list */}
            <div
                ref={containerRef}
                className="flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
            >
                {trades.length === 0 ? (
                    <div className="text-center text-slate-500 text-xs py-8">No trades</div>
                ) : (
                    trades.map((t) => (
                        <div
                            key={t.id}
                            className={clsx(
                                'grid grid-cols-[50px_40px_1fr_1fr] gap-1 px-3 py-1 text-xs font-mono transition-colors',
                                newTradeIds.has(t.id) && 'animate-flash',
                                t.side === 'buy' ? 'bg-emerald-500/5' : 'bg-red-500/5'
                            )}
                        >
                            <div className="text-slate-500 text-[10px]">{formatTime(t.ts).slice(-8)}</div>
                            <div className={clsx(
                                'text-[10px] font-semibold',
                                t.side === 'buy' ? 'text-emerald-400' : 'text-red-400'
                            )}>
                                {t.side.toUpperCase()}
                            </div>
                            <div className="text-right text-slate-200">{formatPrice(t.price)}</div>
                            <div className="text-right text-slate-400">{t.sizeBase.toFixed(2)}</div>
                        </div>
                    ))
                )}
            </div>
        </Panel>
    );
}

function StatCell({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone?: 'buy' | 'sell';
}) {
    return (
        <div className="text-center">
            <div className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</div>
            <div className={clsx(
                'text-xs font-mono font-medium',
                tone === 'buy' ? 'text-emerald-400' : tone === 'sell' ? 'text-red-400' : 'text-slate-200'
            )}>
                {value}
            </div>
        </div>
    );
}
