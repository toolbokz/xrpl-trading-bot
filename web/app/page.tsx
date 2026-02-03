"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, AlertTriangle, Circle, Pause, Play, Shield, Zap, Wallet2 } from 'lucide-react';
import { Badge, Pill, StatCard } from '../components/ui';
import clsx from 'clsx';
import { TRADING_PAIRS, TradingPair, findPair } from '../lib/tradingPairs';
import { PairControl, PriceSummary } from '../components/PairSelector';
import { PairSummary, formatPrice, formatSpreadBps, getLiquidityColor, getNetworkColor } from '../lib/apiClient';
import { CandleChart } from '../components/CandleChart';
import { CandlestickData, UTCTimestamp } from 'lightweight-charts';

type BotStatus = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';

interface BotState {
    status: BotStatus;
    network: 'MAINNET' | 'TESTNET';
    paper: boolean;
    wallet: string;
    xrpBalance: number;
    nzdRate: number; // XRP price in NZD
    // Trading pair balances
    baseCurrency: string;
    quoteCurrency: string;
    baseBalance: number;
    quoteBalance: number;
    strategy: string;
    lastLedger: number;
    pnlTotal: number;
    pnlToday: number;
    winRate: number;
    openPosition: string;
    spreadBps: number;
    liquidity: string;
    slippageBps: number;
    risk: {
        maxExposure: number;
        currentExposure: number;
        dailyLossLimit: number;
        killSwitch: boolean;
    };
}

interface TradeRow {
    id: string;
    time: string;
    pair: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    result: number;
    status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'PENDING';
    paper: boolean;
}

interface TradeStats {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    todayPnl: number;
}

interface OrderRow {
    id: string;
    sequence: number;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    age: number; // seconds
    status: 'OPEN' | 'PARTIAL' | 'CANCELLED';
}

// Initial state factory functions for resetting on pair change
const createInitialBotState = (): BotState => ({
    status: 'STOPPED',
    network: 'TESTNET',
    paper: true,
    wallet: 'rABC...1234',
    xrpBalance: 0,
    nzdRate: 0.85, // Default XRP/NZD rate
    baseCurrency: 'XRP',
    quoteCurrency: '',
    baseBalance: 0,
    quoteBalance: 0,
    strategy: 'orderbook-scalper',
    lastLedger: 0,
    pnlTotal: 0,
    pnlToday: 0,
    winRate: 0,
    openPosition: 'Flat',
    spreadBps: 0,
    liquidity: 'Unknown',
    slippageBps: 0,
    risk: {
        maxExposure: 5000,
        currentExposure: 0,
        dailyLossLimit: 500,
        killSwitch: false,
    },
});

// TODO: Replace with backend WebSocket feed.
const useMockData = () => {
    const [bot, setBot] = useState<BotState>(createInitialBotState);
    const [trades, setTrades] = useState<TradeRow[]>([]);
    const [orders, setOrders] = useState<OrderRow[]>([]);
    const [chart, setChart] = useState(
        Array.from({ length: 40 }).map((_, i) => ({ t: i, p: 0.5 + Math.sin(i / 5) * 0.01 + Math.random() * 0.002 }))
    );

    useEffect(() => {
        const id = setInterval(() => {
            setChart((prev) => {
                const lastItem = prev[prev.length - 1];
                if (!lastItem) return prev;
                const next = [...prev.slice(1), { t: lastItem.t + 1, p: lastItem.p + (Math.random() - 0.5) * 0.002 }];
                return next;
            });
        }, 1500);
        return () => clearInterval(id);
    }, []);

    // Reset functions for pair/position changes
    const resetForPairChange = useCallback(() => {
        setTrades([]);
        setOrders([]);
        setBot((prev) => ({
            ...prev,
            openPosition: 'Flat',
            winRate: 0,
            spreadBps: 0,
            liquidity: 'Unknown',
            slippageBps: 0,
            risk: { ...prev.risk, currentExposure: 0 },
        }));
    }, []);

    const updateSlippageForSize = useCallback((size: number) => {
        // Estimated slippage increases with position size
        // This is a simplified model - real slippage depends on order book depth
        const baseSlippage = 2; // bps
        const sizeMultiplier = Math.log10(Math.max(size, 1)) * 1.5;
        setBot((prev) => ({
            ...prev,
            slippageBps: Math.round(baseSlippage + sizeMultiplier),
        }));
    }, []);

    // Generate pending orders based on current pair and position size
    const generatePendingOrders = useCallback((pairKey: string, size: number, midPrice: number): OrderRow[] => {
        if (!pairKey || size <= 0 || midPrice <= 0) return [];
        const spreadBps = 10; // 10 bps spread
        const spreadMultiplier = spreadBps / 10000;
        return [
            {
                id: `buy-${Date.now()}`,
                sequence: 0,
                side: 'BUY' as const,
                size: size,
                price: Number((midPrice * (1 - spreadMultiplier)).toFixed(6)),
                age: 0,
                status: 'OPEN' as const,
            },
            {
                id: `sell-${Date.now() + 1}`,
                sequence: 0,
                side: 'SELL' as const,
                size: size,
                price: Number((midPrice * (1 + spreadMultiplier)).toFixed(6)),
                age: 0,
                status: 'OPEN' as const,
            },
        ];
    }, []);

    return { bot, trades, orders, chart, setBot, setTrades, setOrders, resetForPairChange, updateSlippageForSize, generatePendingOrders };
};

const formatCurrency = (n: number) => `$${n.toFixed(2)}`;

export default function Page() {
    const { bot, trades, orders, chart, setBot, setTrades, setOrders, resetForPairChange, updateSlippageForSize, generatePendingOrders } = useMockData();
    const [actionMessage, setActionMessage] = useState<string>('');
    const [actionLoading, setActionLoading] = useState<boolean>(false);
    const [positionSize, setPositionSize] = useState<number>(5);
    const [positionSizeMessage, setPositionSizeMessage] = useState<string>('');
    const [selectedPairKey, setSelectedPairKey] = useState<string>('');
    const [pairMessage, setPairMessage] = useState<string>('');

    // Trade stats state
    const [tradeStats, setTradeStats] = useState<TradeStats>({
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnl: 0,
        todayPnl: 0,
    });

    // Auto-manage state
    const [autoManageEnabled, setAutoManageEnabled] = useState<boolean>(false);
    const [stalenessThreshold, setStalenessThreshold] = useState<number>(60);
    const [ordersLoading, setOrdersLoading] = useState<boolean>(false);
    const [currentPrice, setCurrentPrice] = useState<number>(0);

    // Fetch real price from API
    const fetchPrice = useCallback(async (pairKey: string): Promise<{ midPrice: number; spreadBps: number } | null> => {
        if (!pairKey) return null;
        try {
            const res = await fetch(`/api/bot/price?pair=${encodeURIComponent(pairKey)}`);
            if (!res.ok) return null;
            const data = await res.json();
            return { midPrice: data.midPrice || 0, spreadBps: data.spreadBps || 0 };
        } catch {
            return null;
        }
    }, []);

    // Build initial candles based on real price
    const buildInitialCandles = useCallback((basePrice: number): CandlestickData[] => {
        const start = Math.floor(Date.now() / 1000) - 60 * 30;
        let lastClose = basePrice || 1.0;
        const volatility = basePrice * 0.002; // 0.2% volatility
        const candles: CandlestickData[] = [];
        for (let i = 0; i < 60; i += 1) {
            const open = lastClose;
            const drift = (Math.random() - 0.5) * volatility;
            const close = Math.max(0.01, open + drift);
            const high = Math.max(open, close) + Math.random() * (volatility * 0.5);
            const low = Math.min(open, close) - Math.random() * (volatility * 0.5);
            candles.push({
                time: (start + i * 30) as UTCTimestamp,
                open,
                high,
                low,
                close,
            });
            lastClose = close;
        }
        return candles;
    }, []);

    const [candleData, setCandleData] = useState<CandlestickData[]>(() => buildInitialCandles(1.0));

    // Fetch price and update chart when pair changes
    useEffect(() => {
        if (!selectedPairKey) return;

        let cancelled = false;

        const initChart = async () => {
            const priceData = await fetchPrice(selectedPairKey);
            if (cancelled || !priceData) return;

            const price = priceData.midPrice;
            setCurrentPrice(price);
            setCandleData(buildInitialCandles(price));
            setBot((prev) => ({ ...prev, spreadBps: priceData.spreadBps }));
        };

        initChart();

        // Update price every 10 seconds (reduced from 5s to avoid rate limiting)
        const priceInterval = setInterval(async () => {
            const priceData = await fetchPrice(selectedPairKey);
            if (cancelled || !priceData) return;

            const price = priceData.midPrice;
            setCurrentPrice(price);
            setBot((prev) => ({ ...prev, spreadBps: priceData.spreadBps }));

            // Add new candle based on real price
            setCandleData((prev) => {
                const last = prev[prev.length - 1];
                if (!last) return prev;

                const lastTime = typeof last.time === 'number' ? last.time : Number(last.time);
                const now = Math.floor(Date.now() / 1000);

                // Only add new candle if 30 seconds have passed
                if (now - lastTime < 30) {
                    // Update current candle's close/high/low
                    const updated = [...prev];
                    const currentCandle = updated[updated.length - 1];
                    if (!currentCandle) return prev;
                    const current = { ...currentCandle };
                    current.close = price;
                    current.high = Math.max(current.high ?? price, price);
                    current.low = Math.min(current.low ?? price, price);
                    updated[updated.length - 1] = current;
                    return updated;
                }

                const nextTime = (lastTime + 30) as UTCTimestamp;
                const volatility = price * 0.001;
                const open = last.close ?? price;
                const close = price;
                const high = Math.max(open, close) + Math.random() * volatility;
                const low = Math.min(open, close) - Math.random() * volatility;
                return [...prev.slice(-120), { time: nextTime, open, high, low, close }];
            });
        }, 10000);

        return () => {
            cancelled = true;
            clearInterval(priceInterval);
        };
    }, [selectedPairKey, fetchPrice, buildInitialCandles, setBot]);

    const currentPair = useMemo<TradingPair | undefined>(() => findPair(selectedPairKey), [selectedPairKey]);

    const heartbeatClass = useMemo(
        () =>
            clsx('w-2 h-2 rounded-full', {
                'bg-success shadow-[0_0_0_6px_rgba(53,211,153,0.25)] animate-pulse': bot.status === 'RUNNING',
                'bg-danger shadow-[0_0_0_6px_rgba(248,113,113,0.25)]': bot.status === 'ERROR',
                'bg-slate-500': bot.status === 'PAUSED',
                'bg-slate-600': bot.status === 'STOPPED',
            }),
        [bot.status]
    );

    const updateStatus = useCallback((status: BotStatus, message?: string) => {
        setBot((prev) => ({ ...prev, status }));
        if (message) setActionMessage(message);
    }, [setBot]);

    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/status');
            const data = await res.json();
            if (data?.state) {
                updateStatus((data.state as BotStatus) || 'STOPPED', data.message);
            }
        } catch (err) {
            setActionMessage('Unable to fetch bot status');
        }
    }, [updateStatus]);

    const fetchWalletInfo = useCallback(async (pair?: TradingPair) => {
        try {
            // Build query params if pair is provided
            const params = new URLSearchParams();
            if (pair) {
                params.set('base', pair.base.currency);
                params.set('quote', pair.quote.currency);
                // Use quote issuer for the pair's issuer (or base issuer if quote is XRP)
                const issuer = pair.quote.issuer || pair.base.issuer;
                if (issuer) params.set('issuer', issuer);
            }
            const url = params.toString() ? `/api/bot/wallet?${params}` : '/api/bot/wallet';

            const res = await fetch(url);
            const data = await res.json();
            if (data) {
                setBot((prev) => ({
                    ...prev,
                    wallet: data.address ? `${data.address.slice(0, 6)}...${data.address.slice(-4)}` : prev.wallet,
                    xrpBalance: data.balance ?? 0,
                    nzdRate: data.nzdRate ?? 0.85,
                    network: (data.network === 'MAINNET' || data.network === 'TESTNET') ? data.network : prev.network,
                    // Trading pair balances
                    baseCurrency: data.tradingPair?.base || pair?.base.currency || 'XRP',
                    quoteCurrency: data.tradingPair?.quote || pair?.quote.currency || data.quoteCurrency || '',
                    baseBalance: data.baseBalance ?? data.balance ?? 0,
                    quoteBalance: data.quoteBalance ?? 0,
                }));
            }
        } catch (err) {
            console.error('Failed to fetch wallet info:', err);
        }
    }, [setBot]);

    // Fetch active orders from XRPL
    const fetchOrders = useCallback(async () => {
        setOrdersLoading(true);
        try {
            const res = await fetch('/api/bot/orders');
            const data = await res.json();
            if (data) {
                // Update auto-manage settings from server
                if (typeof data.autoManageEnabled === 'boolean') {
                    setAutoManageEnabled(data.autoManageEnabled);
                }
                if (typeof data.stalenessThresholdSec === 'number') {
                    setStalenessThreshold(data.stalenessThresholdSec);
                }
                // Update orders list
                if (Array.isArray(data.orders)) {
                    setOrders(data.orders.map((o: any) => ({
                        id: `offer-${o.sequence}`,
                        sequence: o.sequence,
                        side: o.side,
                        size: o.size,
                        price: o.price,
                        age: o.age,
                        status: 'OPEN' as const,
                    })));
                }
                // Log cancelled count if any
                if (data.cancelledCount > 0) {
                    console.log(`Auto-cancelled ${data.cancelledCount} stale orders`);
                }
            }
        } catch (err) {
            console.error('Failed to fetch orders:', err);
        } finally {
            setOrdersLoading(false);
        }
    }, [setOrders]);

    // Fetch trade history
    const fetchTrades = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/trades?limit=50');
            const data = await res.json();
            if (data) {
                // Update trade stats
                if (data.stats) {
                    setTradeStats({
                        totalTrades: data.stats.totalTrades || 0,
                        winningTrades: data.stats.winningTrades || 0,
                        losingTrades: data.stats.losingTrades || 0,
                        winRate: data.stats.winRate || 0,
                        totalPnl: data.stats.totalPnl || 0,
                        todayPnl: data.stats.todayPnl || 0,
                    });
                    // Update bot P&L display
                    setBot((prev) => ({
                        ...prev,
                        pnlTotal: data.stats.totalPnl || 0,
                        pnlToday: data.stats.todayPnl || 0,
                        winRate: data.stats.winRate || 0,
                    }));
                }
                // Update trades list
                if (Array.isArray(data.trades)) {
                    setTrades(data.trades.map((t: any) => ({
                        id: t.id,
                        time: new Date(t.timestamp).toLocaleTimeString(),
                        pair: t.pair,
                        side: t.side,
                        size: t.amount || t.filled,
                        price: t.price,
                        result: t.pnl,
                        status: t.status,
                        paper: t.paper,
                    })));
                }
            }
        } catch (err) {
            console.error('Failed to fetch trades:', err);
        }
    }, [setBot, setTrades]);

    // Update auto-manage settings on server
    const updateAutoManageSettings = useCallback(async (enabled: boolean, threshold: number) => {
        try {
            await fetch('/api/bot/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    autoManageEnabled: enabled,
                    stalenessThresholdSec: threshold,
                }),
            });
        } catch (err) {
            console.error('Failed to update auto-manage settings:', err);
        }
    }, []);

    // Cancel a specific order
    const cancelOrder = useCallback(async (sequence: number) => {
        try {
            const res = await fetch('/api/bot/orders', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sequence }),
            });
            const data = await res.json();
            if (data.success) {
                // Refresh orders after cancel
                fetchOrders();
            }
        } catch (err) {
            console.error('Failed to cancel order:', err);
        }
    }, [fetchOrders]);

    useEffect(() => {
        fetchStatus();
        fetchWalletInfo(currentPair);
        fetchOrders();
        fetchTrades();
        // Refresh wallet info every 30 seconds
        const walletInterval = setInterval(() => fetchWalletInfo(currentPair), 30_000);
        // Refresh orders every 15 seconds (more frequent for auto-manage)
        const ordersInterval = setInterval(fetchOrders, 15_000);
        // Refresh trades every 10 seconds
        const tradesInterval = setInterval(fetchTrades, 10_000);
        return () => {
            clearInterval(walletInterval);
            clearInterval(ordersInterval);
            clearInterval(tradesInterval);
        };
    }, [fetchStatus, fetchWalletInfo, fetchOrders, fetchTrades, currentPair]);

    const callAction = async (action: 'run' | 'pause' | 'kill') => {
        if (action === 'run' && !currentPair) {
            setActionMessage('Select a trading pair before starting the bot');
            return;
        }
        setActionLoading(true);
        setActionMessage('');
        try {
            const res = await fetch(`/api/bot/${action}`, { method: 'POST' });
            const data = await res.json();
            if (res.ok && data?.state) {
                updateStatus((data.state as BotStatus) || 'STOPPED', data.message || `Bot ${action}d`);
            } else {
                // Show error and set status to ERROR if it's a run failure
                const errorMsg = data?.error || `Unable to ${action} bot`;
                setActionMessage(`⚠️ ${errorMsg}`);
                if (action === 'run') {
                    updateStatus('ERROR', errorMsg);
                }
            }
        } catch (err: any) {
            const errorMsg = err?.message || `Unable to ${action} bot`;
            setActionMessage(`⚠️ ${errorMsg}`);
            if (action === 'run') {
                updateStatus('ERROR', errorMsg);
            }
        } finally {
            setActionLoading(false);
        }
    };

    const updatePositionSize = async () => {
        setPositionSizeMessage('');

        // Validate against risk limits
        if (positionSize > bot.risk.maxExposure) {
            setPositionSizeMessage(`⚠️ Position size exceeds max exposure (${bot.risk.maxExposure})`);
            return;
        }

        try {
            const res = await fetch('/api/bot/position-size', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ size: positionSize }),
            });
            const data = await res.json();
            if (res.ok) {
                setPositionSizeMessage(`Position size set to ${positionSize} XRP`);
                // Update estimated slippage based on new size
                updateSlippageForSize(positionSize);
                // Update pending orders with new size if pair is selected
                if (selectedPairKey) {
                    const midPrice = candleData[candleData.length - 1]?.close ?? 0.5;
                    setOrders(generatePendingOrders(selectedPairKey, positionSize, midPrice));
                }
            } else {
                setPositionSizeMessage(data?.error || 'Failed to update');
            }
        } catch (err: any) {
            setPositionSizeMessage(err?.message || 'Failed to update');
        }
    };

    const applyTradingPair = async (pairKey: string) => {
        setPairMessage('');
        setSelectedPairKey(pairKey);

        // Reset UI state for new pair
        resetForPairChange();

        try {
            const res = await fetch('/api/bot/trading-pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pairKey }),
            });
            const data = await res.json();
            if (res.ok) {
                setPairMessage(`Trading pair set to ${pairKey}`);
                // Update liquidity hint from selected pair
                const pair = findPair(pairKey);
                if (pair) {
                    setBot((prev) => ({
                        ...prev,
                        liquidity: pair.liquidity === 'high' ? 'High' : pair.liquidity === 'medium' ? 'Medium' : 'Low',
                    }));
                    // Generate pending orders for the selected pair
                    const midPrice = candleData[candleData.length - 1]?.close ?? 0.5;
                    setOrders(generatePendingOrders(pairKey, positionSize, midPrice));
                }
            } else {
                setPairMessage(data?.error || 'Failed to set trading pair');
            }
        } catch (err: any) {
            setPairMessage(err?.message || 'Failed to set trading pair');
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-[#05080f] via-[#0b1221] to-[#090c14] text-slate-100">
            <div className="max-w-6xl mx-auto px-6 py-10 space-y-8">
                {/* Wallet Balances Banner */}
                <div className="card bg-gradient-to-r from-slate-900/80 to-slate-800/50 border border-white/10 rounded-2xl p-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <Wallet2 size={20} className="text-sky-400" />
                            <span className="text-sm text-slate-400">{bot.wallet}</span>
                            <Badge tone={bot.network === 'MAINNET' ? 'danger' : 'neutral'}>{bot.network}</Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-6">
                            {/* XRP Balance - always shown */}
                            <div className="flex flex-col items-end">
                                <div className="text-xl font-semibold text-slate-100">
                                    {bot.xrpBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} <span className="text-sky-400">XRP</span>
                                </div>
                                {bot.nzdRate > 0 && (
                                    <div className="text-xs text-slate-400">
                                        ≈ ${(bot.xrpBalance * bot.nzdRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} NZD
                                    </div>
                                )}
                            </div>
                            {/* Quote Currency Balance - only when pair selected */}
                            {selectedPairKey && bot.quoteCurrency && (
                                <div className="flex flex-col items-end border-l border-white/10 pl-6">
                                    <div className="text-xl font-semibold text-slate-100">
                                        {bot.quoteBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} <span className="text-emerald-400">{bot.quoteCurrency}</span>
                                    </div>
                                    {bot.quoteCurrency === 'RLUSD' && (
                                        <div className="text-xs text-slate-400">
                                            ≈ ${(bot.quoteBalance * 1.62).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} NZD
                                        </div>
                                    )}
                                </div>
                            )}
                            {/* Total NZD Value */}
                            <div className="flex flex-col items-end border-l border-white/10 pl-6">
                                <div className="text-xs text-slate-500 uppercase tracking-wider">Total Value</div>
                                <div className="text-lg font-semibold text-amber-400">
                                    ${((bot.xrpBalance * bot.nzdRate) + (selectedPairKey && bot.quoteCurrency === 'RLUSD' ? bot.quoteBalance * 1.62 : 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} NZD
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-4">
                        <div className="h-11 w-11 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                            <div className={heartbeatClass}></div>
                        </div>
                        <div className="space-y-1">
                            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">XRPL Bot</div>
                            <div className="text-2xl font-semibold leading-tight">Quiet, steady, safety-first</div>
                            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
                                <Badge tone={bot.paper ? 'neutral' : 'success'}>{bot.paper ? 'PAPER' : 'LIVE'}</Badge>
                                <span className="flex items-center gap-2 text-success"><Circle size={10} />Heartbeat</span>
                                <Badge tone={bot.status === 'RUNNING' ? 'success' : bot.status === 'PAUSED' ? 'neutral' : 'danger'}>{bot.status}</Badge>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-3 text-sm items-center">
                        <button className="btn btn-run" onClick={() => callAction('run')} disabled={actionLoading}>
                            <Play size={16} /> Run
                        </button>
                        <button className="btn btn-pause" onClick={() => callAction('pause')} disabled={actionLoading}>
                            <Pause size={16} /> Pause
                        </button>
                        <button className="btn btn-kill" onClick={() => callAction('kill')} disabled={actionLoading}>
                            <AlertTriangle size={16} /> Kill Switch
                        </button>
                        {actionMessage && <span className="text-xs text-slate-400">{actionMessage}</span>}
                    </div>
                </header>

                <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard label="Total PnL" value={`${bot.pnlTotal >= 0 ? '+' : ''}${bot.pnlTotal.toFixed(2)} XRP ($${(bot.pnlTotal * bot.nzdRate).toFixed(2)} NZD)`} delta="+2.1%" positive={bot.pnlTotal >= 0} />
                    <StatCard label="Today" value={`${bot.pnlToday >= 0 ? '+' : ''}${bot.pnlToday.toFixed(2)} XRP ($${(bot.pnlToday * bot.nzdRate).toFixed(2)} NZD)`} delta="+0.6%" positive={bot.pnlToday >= 0} />
                    <StatCard label="Open Position" value={bot.openPosition} />
                    <StatCard label="Win Rate" value={`${bot.winRate}%`} />
                </section>

                <section className="grid lg:grid-cols-[1.7fr,1fr] gap-4 items-start">
                    <div className="card p-6 space-y-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="stat-label">XRP Price</div>
                                <div className="flex items-baseline gap-3">
                                    <span className="text-2xl font-semibold">{currentPair?.key || 'Select pair'}</span>
                                    {currentPrice > 0 && (
                                        <span className="text-xl text-emerald-400 font-mono">
                                            {currentPrice.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}
                                            <span className="text-sm text-slate-400 ml-1">{bot.quoteCurrency || 'RLUSD'}/XRP</span>
                                        </span>
                                    )}
                                </div>
                            </div>
                            <Pill icon={Activity} label={`Spread ${bot.spreadBps.toFixed(1)} bps`} tone="neutral" />
                        </div>
                        <div className="h-80">
                            <CandleChart data={candleData} height={320} />
                        </div>
                    </div>

                    <div className="card p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="stat-label">Bot Control</div>
                                <div className="text-lg font-semibold">Mode & guardrails</div>
                            </div>
                            <Pill icon={Shield} label={bot.paper ? 'PAPER' : 'LIVE'} tone={bot.paper ? 'neutral' : 'danger'} />
                        </div>
                        <div className="space-y-2 text-sm text-slate-300">
                            <div className="space-y-1 rounded-2xl bg-white/5 px-3 py-3">
                                <div className="flex items-center justify-between gap-3">
                                    <span>Trading Pair</span>
                                    {currentPair?.liquidity === 'low' && <Badge tone="danger">Low liquidity</Badge>}
                                    {currentPair?.liquidity === 'medium' && <Badge tone="neutral">Check depth</Badge>}
                                </div>
                                <select
                                    value={selectedPairKey}
                                    onChange={(e) => applyTradingPair(e.target.value)}
                                    className="w-full rounded-lg bg-slate-900 border border-white/10 px-3 py-2 text-slate-100 focus:outline-none focus:ring focus:ring-sky-500"
                                >
                                    <option value="" disabled>Select a predefined pair</option>
                                    {TRADING_PAIRS.map((pair) => (
                                        <option key={pair.key} value={pair.key}>
                                            {pair.key} — {pair.description}
                                        </option>
                                    ))}
                                </select>
                                {pairMessage && <div className="text-xs text-slate-400 pt-1">{pairMessage}</div>}
                                {/* Live price summary from API */}
                                {selectedPairKey && (
                                    <PriceSummary
                                        pairKey={selectedPairKey}
                                        refreshInterval={5000}
                                        className="mt-2 p-2 rounded-lg bg-slate-900/50"
                                    />
                                )}
                                {currentPair && (
                                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
                                        <div className="rounded-lg bg-slate-900/80 border border-white/5 px-2 py-2">
                                            <div className="text-slate-400">Base</div>
                                            <div className="text-slate-100 font-semibold">{currentPair.base.currency}</div>
                                            {currentPair.base.issuer && <div className="text-[11px] text-slate-400 break-all">{currentPair.base.issuer}</div>}
                                        </div>
                                        <div className="rounded-lg bg-slate-900/80 border border-white/5 px-2 py-2">
                                            <div className="text-slate-400">Quote</div>
                                            <div className="text-slate-100 font-semibold">{currentPair.quote.currency}</div>
                                            {currentPair.quote.issuer && <div className="text-[11px] text-slate-400 break-all">{currentPair.quote.issuer}</div>}
                                        </div>
                                        {/* Network and liquidity badges */}
                                        <div className="col-span-2 flex gap-2">
                                            <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', getLiquidityColor(currentPair.liquidity))}>
                                                {currentPair.liquidity} liquidity
                                            </span>
                                            <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', getNetworkColor(currentPair.network))}>
                                                {currentPair.network}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center justify-between rounded-2xl bg-white/5 px-3 py-3">
                                <span>Strategy</span>
                                <span className="text-slate-100 font-semibold">{bot.strategy}</span>
                            </div>
                            <div className="flex items-center justify-between rounded-2xl bg-white/5 px-3 py-3">
                                <span>Last Ledger</span>
                                <span className="text-slate-100 font-semibold">{bot.lastLedger}</span>
                            </div>
                            <div className="flex items-center justify-between rounded-2xl bg-white/5 px-3 py-3">
                                <span>Liquidity</span>
                                <span className="text-slate-100 font-semibold">{bot.liquidity}</span>
                            </div>
                            <div className="flex items-center justify-between rounded-2xl bg-white/5 px-3 py-3">
                                <span>Slippage</span>
                                <span className="text-slate-100 font-semibold">{bot.slippageBps} bps</span>
                            </div>
                            <div className="flex items-center justify-between rounded-2xl bg-white/5 px-3 py-3 gap-3">
                                <span>Position Size (XRP)</span>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={positionSize}
                                        onChange={(e) => setPositionSize(Number(e.target.value))}
                                        className="w-24 rounded-lg bg-slate-900 border border-white/10 px-2 py-1 text-right text-slate-100 focus:outline-none focus:ring focus:ring-sky-500"
                                    />
                                    <button className="btn btn-run" onClick={updatePositionSize} disabled={actionLoading}>Set</button>
                                </div>
                            </div>
                            {positionSizeMessage && <div className="text-xs text-slate-400 px-3">{positionSizeMessage}</div>}
                        </div>
                    </div>
                </section>

                <section className="grid lg:grid-cols-[1.4fr,1fr] gap-4">
                    <div className="card p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="text-lg font-semibold">Recent Trades</div>
                            <div className="flex items-center gap-2">
                                <Badge tone="neutral">{tradeStats.totalTrades} total</Badge>
                                {bot.paper && <Badge tone="warning">Paper</Badge>}
                            </div>
                        </div>
                        {/* Trade stats summary */}
                        <div className="grid grid-cols-3 gap-2 text-xs">
                            <div className="rounded-lg bg-white/5 px-3 py-2 text-center">
                                <div className="text-slate-400">Win Rate</div>
                                <div className={clsx('font-semibold', tradeStats.winRate >= 50 ? 'text-success' : 'text-danger')}>
                                    {tradeStats.winRate.toFixed(1)}%
                                </div>
                            </div>
                            <div className="rounded-lg bg-white/5 px-3 py-2 text-center">
                                <div className="text-slate-400">Today P&L</div>
                                <div className={clsx('font-semibold', tradeStats.todayPnl >= 0 ? 'text-success' : 'text-danger')}>
                                    {tradeStats.todayPnl >= 0 ? '+' : ''}{tradeStats.todayPnl.toFixed(4)} XRP
                                </div>
                            </div>
                            <div className="rounded-lg bg-white/5 px-3 py-2 text-center">
                                <div className="text-slate-400">Total P&L</div>
                                <div className={clsx('font-semibold', tradeStats.totalPnl >= 0 ? 'text-success' : 'text-danger')}>
                                    {tradeStats.totalPnl >= 0 ? '+' : ''}{tradeStats.totalPnl.toFixed(4)} XRP
                                </div>
                            </div>
                        </div>
                        <div className="space-y-3 max-h-80 overflow-y-auto">
                            {trades.length === 0 ? (
                                <div className="text-center text-slate-500 py-8">
                                    No trades yet. Start the bot to begin trading.
                                </div>
                            ) : trades.map((t) => (
                                <div key={t.id} className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3 text-sm">
                                    <div className="flex items-center gap-3">
                                        <Badge tone={t.side === 'BUY' ? 'success' : 'danger'}>{t.side}</Badge>
                                        <div className="text-slate-200">{t.pair}</div>
                                        {t.paper && <span className="text-xs text-amber-400/70">📝</span>}
                                        {t.status === 'REJECTED' && <Badge tone="danger">Rejected</Badge>}
                                    </div>
                                    <div className="flex items-center gap-6 text-slate-300">
                                        <span>{t.size.toFixed(2)}</span>
                                        <span>{t.price.toFixed(6)}</span>
                                        <span className={clsx(t.result >= 0 ? 'text-success' : 'text-danger')}>
                                            {t.result >= 0 ? '+' : ''}{t.result.toFixed(4)}
                                        </span>
                                        <span className="text-slate-500">{t.time}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="card p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="text-lg font-semibold">Active Orders</div>
                            <div className="flex items-center gap-2">
                                {ordersLoading && <span className="text-xs text-slate-500">Loading...</span>}
                                <button
                                    onClick={() => fetchOrders()}
                                    className="text-xs text-slate-400 hover:text-slate-200"
                                    title="Refresh orders"
                                >
                                    ↻
                                </button>
                            </div>
                        </div>

                        {/* Auto-manage controls */}
                        <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
                            <div className="flex items-center gap-2">
                                <Zap className="w-4 h-4 text-amber-400" />
                                <span className="text-sm text-slate-300">Auto-manage</span>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={autoManageEnabled}
                                    onChange={(e) => {
                                        setAutoManageEnabled(e.target.checked);
                                        updateAutoManageSettings(e.target.checked, stalenessThreshold);
                                    }}
                                    className="sr-only peer"
                                />
                                <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                            </label>
                        </div>

                        {autoManageEnabled && (
                            <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
                                <span className="text-sm text-slate-300">Cancel stale after</span>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="number"
                                        min={10}
                                        max={600}
                                        step={10}
                                        value={stalenessThreshold}
                                        onChange={(e) => {
                                            const val = Number(e.target.value);
                                            setStalenessThreshold(val);
                                            updateAutoManageSettings(autoManageEnabled, val);
                                        }}
                                        className="w-16 rounded-lg bg-slate-900 border border-white/10 px-2 py-1 text-right text-slate-100 text-sm focus:outline-none focus:ring focus:ring-sky-500"
                                    />
                                    <span className="text-sm text-slate-400">sec</span>
                                </div>
                            </div>
                        )}

                        <div className="space-y-3">
                            {orders.length === 0 ? (
                                <div className="text-center text-slate-500 py-4">No active orders</div>
                            ) : (
                                orders.map((o) => (
                                    <div key={o.id} className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3 text-sm">
                                        <div className="flex items-center gap-3">
                                            <Badge tone={o.side === 'BUY' ? 'success' : 'danger'}>{o.side}</Badge>
                                            <div className="text-slate-200">{o.size.toFixed(2)} @ {o.price.toFixed(6)}</div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className={clsx(
                                                'text-xs',
                                                o.age > stalenessThreshold ? 'text-amber-400' : 'text-slate-500'
                                            )}>
                                                {o.age}s
                                            </span>
                                            <button
                                                onClick={() => cancelOrder(o.sequence)}
                                                className="text-xs text-red-400 hover:text-red-300"
                                                title="Cancel order"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </section>

                <section className="grid lg:grid-cols-2 gap-4">
                    <div className="card p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="text-lg font-semibold">Risk Dashboard</div>
                            <Badge tone={bot.risk.killSwitch ? 'danger' : 'neutral'}>{bot.risk.killSwitch ? 'Kill-switch ON' : 'Nominal'}</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-sm text-slate-300">
                            <div className="rounded-2xl bg-white/5 px-3 py-3">Max Exposure <span className="block text-lg text-slate-100 font-semibold">{bot.risk.maxExposure}</span></div>
                            <div className="rounded-2xl bg-white/5 px-3 py-3">Current Exposure <span className="block text-lg text-slate-100 font-semibold">{bot.risk.currentExposure}</span></div>
                            <div className="rounded-2xl bg-white/5 px-3 py-3">Daily Loss Limit <span className="block text-lg text-slate-100 font-semibold">{bot.risk.dailyLossLimit}</span></div>
                            <div className="rounded-2xl bg-white/5 px-3 py-3">Kill Switch <span className="block text-lg text-slate-100 font-semibold">{bot.risk.killSwitch ? 'ENGAGED' : 'OFF'}</span></div>
                        </div>
                    </div>

                    <div className="card p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="text-lg font-semibold">Strategies</div>
                            <Badge tone="neutral">Read-only</Badge>
                        </div>
                        <div className="space-y-3 text-sm text-slate-300">
                            {[
                                { name: 'orderbook-scalper', enabled: true, params: 'spread>10bps, size 250 XRP' },
                                { name: 'amm-arb', enabled: false, params: 'profit>15bps, size 150 XRP' },
                            ].map((s) => (
                                <div key={s.name} className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
                                    <div>
                                        <div className="font-semibold text-slate-100">{s.name}</div>
                                        <div className="text-xs text-slate-400">{s.params}</div>
                                    </div>
                                    <Badge tone={s.enabled ? 'success' : 'danger'}>{s.enabled ? 'ENABLED' : 'DISABLED'}</Badge>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
