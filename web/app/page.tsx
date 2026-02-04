"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CandlestickData, UTCTimestamp } from 'lightweight-charts';
import { TRADING_PAIRS, TradingPair, findPair } from '../lib/tradingPairs';

// Layout components
import { DashboardLayout } from '../components/DashboardLayout';
import { TerminalHeader } from '../components/TerminalHeader';
import { CompactPairSelector } from '../components/CompactPairSelector';

// Panel components
import { Panel } from '../components/Panel';
import { OrderBookPanel } from '../components/OrderBookPanel';
import { MarketStatsPanel } from '../components/MarketStatsPanel';
import { ChartPanel } from '../components/ChartPanel';
import { ControlsPanel } from '../components/ControlsPanel';
import { TradeTapePanel } from '../components/TradeTapePanel';
import { LogsPanel } from '../components/LogsPanel';
import { FlowMetricsPanel } from '../components/FlowMetricsPanel';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type BotStatus = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';

interface BotState {
    status: BotStatus;
    network: 'MAINNET' | 'TESTNET';
    paper: boolean;
    wallet: string;
    xrpBalance: number;
    nzdRate: number;
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

interface OrderBookEntry {
    price: number;
    size: number;
    total: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial State
// ─────────────────────────────────────────────────────────────────────────────

const createInitialBotState = (): BotState => ({
    status: 'STOPPED',
    network: 'TESTNET',
    paper: true,
    wallet: 'rABC...1234',
    xrpBalance: 0,
    nzdRate: 0.85,
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

// ─────────────────────────────────────────────────────────────────────────────
// Main Page Component
// ─────────────────────────────────────────────────────────────────────────────

export default function Page() {
    // Core state
    const [bot, setBot] = useState<BotState>(createInitialBotState);
    const [actionMessage, setActionMessage] = useState<string>('');
    const [actionLoading, setActionLoading] = useState<boolean>(false);
    const [positionSize, setPositionSize] = useState<number>(2);
    const [positionSizeMessage, setPositionSizeMessage] = useState<string>('');
    const [selectedPairKey, setSelectedPairKey] = useState<string>('');
    const [currentPrice, setCurrentPrice] = useState<number>(0);
    const [connected, setConnected] = useState<boolean>(false);

    // Order book state
    const [orderBookBids, setOrderBookBids] = useState<OrderBookEntry[]>([]);
    const [orderBookAsks, setOrderBookAsks] = useState<OrderBookEntry[]>([]);
    const [midPrice, setMidPrice] = useState<number | null>(null);

    // Chart state
    const [candleData, setCandleData] = useState<CandlestickData[]>([]);

    const currentPair = useMemo(() => findPair(selectedPairKey), [selectedPairKey]);

    // ─────────────────────────────────────────────────────────────────────────
    // Data Fetching
    // ─────────────────────────────────────────────────────────────────────────

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

    const buildInitialCandles = useCallback((basePrice: number): CandlestickData[] => {
        const start = Math.floor(Date.now() / 1000) - 60 * 30;
        let lastClose = basePrice || 1.0;
        const volatility = basePrice * 0.002;
        const candles: CandlestickData[] = [];
        for (let i = 0; i < 60; i += 1) {
            const open = lastClose;
            const drift = (Math.random() - 0.5) * volatility;
            const close = Math.max(0.01, open + drift);
            const high = Math.max(open, close) + Math.random() * (volatility * 0.5);
            const low = Math.min(open, close) - Math.random() * (volatility * 0.5);
            candles.push({ time: (start + i * 30) as UTCTimestamp, open, high, low, close });
            lastClose = close;
        }
        return candles;
    }, []);

    // Fetch price and update chart when pair changes
    useEffect(() => {
        if (!selectedPairKey) return;
        let cancelled = false;

        const initChart = async () => {
            const priceData = await fetchPrice(selectedPairKey);
            if (cancelled || !priceData) return;
            setCurrentPrice(priceData.midPrice);
            setMidPrice(priceData.midPrice);
            setCandleData(buildInitialCandles(priceData.midPrice));
            setBot((prev) => ({ ...prev, spreadBps: priceData.spreadBps }));
            setConnected(true);
        };

        initChart();

        const priceInterval = setInterval(async () => {
            const priceData = await fetchPrice(selectedPairKey);
            if (cancelled || !priceData) return;
            setCurrentPrice(priceData.midPrice);
            setMidPrice(priceData.midPrice);
            setBot((prev) => ({ ...prev, spreadBps: priceData.spreadBps }));

            setCandleData((prev) => {
                const last = prev[prev.length - 1];
                if (!last) return prev;
                const lastTime = typeof last.time === 'number' ? last.time : Number(last.time);
                const now = Math.floor(Date.now() / 1000);

                if (now - lastTime < 30) {
                    const updated = [...prev];
                    const current = updated[updated.length - 1];
                    if (!current) return prev;
                    const newCandle: CandlestickData<UTCTimestamp> = {
                        time: (typeof current.time === 'number' ? current.time : Number(current.time)) as UTCTimestamp,
                        open: current.open,
                        high: Math.max(current.high, priceData.midPrice),
                        low: Math.min(current.low, priceData.midPrice),
                        close: priceData.midPrice,
                    };
                    updated[updated.length - 1] = newCandle;
                    return updated;
                }

                const nextTime = (lastTime + 30) as UTCTimestamp;
                const volatility = priceData.midPrice * 0.001;
                const open = last.close ?? priceData.midPrice;
                const close = priceData.midPrice;
                const high = Math.max(open, close) + Math.random() * volatility;
                const low = Math.min(open, close) - Math.random() * volatility;
                return [...prev.slice(-120), { time: nextTime, open, high, low, close }];
            });
        }, 10000);

        return () => {
            cancelled = true;
            clearInterval(priceInterval);
        };
    }, [selectedPairKey, fetchPrice, buildInitialCandles]);

    const updateStatus = useCallback((status: BotStatus, message?: string) => {
        setBot((prev) => ({ ...prev, status }));
        if (message) setActionMessage(message);
    }, []);

    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/status');
            const data = await res.json();
            if (data?.state) {
                updateStatus((data.state as BotStatus) || 'STOPPED', data.message);
            }
        } catch {
            setActionMessage('Unable to fetch bot status');
        }
    }, [updateStatus]);

    const fetchRiskStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/risk');
            if (!res.ok) return;
            const data = await res.json();
            if (data) {
                setBot((prev) => ({
                    ...prev,
                    risk: {
                        maxExposure: data.maxExposure ?? prev.risk.maxExposure,
                        currentExposure: data.currentExposure ?? prev.risk.currentExposure,
                        dailyLossLimit: data.dailyLossLimit ?? prev.risk.dailyLossLimit,
                        killSwitch: data.killSwitch ?? prev.risk.killSwitch,
                    },
                }));
                if (typeof data.positionSize === 'number') {
                    setPositionSize(data.positionSize);
                }
            }
        } catch (err) {
            console.error('Failed to fetch risk status:', err);
        }
    }, []);

    const fetchWalletInfo = useCallback(async (pair?: TradingPair) => {
        try {
            const params = new URLSearchParams();
            if (pair) {
                params.set('base', pair.base.currency);
                params.set('quote', pair.quote.currency);
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
                    baseCurrency: data.tradingPair?.base || pair?.base.currency || 'XRP',
                    quoteCurrency: data.tradingPair?.quote || pair?.quote.currency || data.quoteCurrency || '',
                    baseBalance: data.baseBalance ?? data.balance ?? 0,
                    quoteBalance: data.quoteBalance ?? 0,
                }));
            }
        } catch (err) {
            console.error('Failed to fetch wallet info:', err);
        }
    }, []);

    const fetchTrades = useCallback(async () => {
        try {
            const res = await fetch('/api/bot/trades?limit=50');
            const data = await res.json();
            if (data?.stats) {
                setBot((prev) => ({
                    ...prev,
                    pnlTotal: data.stats.totalPnl || 0,
                    pnlToday: data.stats.todayPnl || 0,
                    winRate: data.stats.winRate || 0,
                }));
            }
        } catch (err) {
            console.error('Failed to fetch trades:', err);
        }
    }, []);

    // Generate mock order book based on mid price
    useEffect(() => {
        if (!midPrice || midPrice <= 0) {
            setOrderBookBids([]);
            setOrderBookAsks([]);
            return;
        }

        const spread = midPrice * 0.001; // 0.1% spread
        const bids: OrderBookEntry[] = [];
        const asks: OrderBookEntry[] = [];
        let bidTotal = 0;
        let askTotal = 0;

        for (let i = 0; i < 15; i++) {
            const bidPrice = midPrice - spread * (i + 1);
            const bidSize = Math.random() * 1000 + 100;
            bidTotal += bidSize;
            bids.push({ price: bidPrice, size: bidSize, total: bidTotal });

            const askPrice = midPrice + spread * (i + 1);
            const askSize = Math.random() * 1000 + 100;
            askTotal += askSize;
            asks.push({ price: askPrice, size: askSize, total: askTotal });
        }

        setOrderBookBids(bids);
        setOrderBookAsks(asks);
    }, [midPrice]);

    // Initial fetch
    useEffect(() => {
        fetchStatus();
        fetchRiskStatus();
        fetchTrades();
        const deferredFetch = setTimeout(() => {
            fetchWalletInfo(currentPair);
        }, 500);
        return () => clearTimeout(deferredFetch);
    }, []);

    // Polling intervals
    useEffect(() => {
        const riskInterval = setInterval(fetchRiskStatus, 30_000);
        const walletInterval = setInterval(() => fetchWalletInfo(currentPair), 60_000);
        const tradesInterval = setInterval(fetchTrades, 30_000);
        return () => {
            clearInterval(riskInterval);
            clearInterval(walletInterval);
            clearInterval(tradesInterval);
        };
    }, [fetchRiskStatus, fetchWalletInfo, fetchTrades, currentPair]);

    // ─────────────────────────────────────────────────────────────────────────
    // Actions
    // ─────────────────────────────────────────────────────────────────────────

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
                const errorMsg = data?.error || `Unable to ${action} bot`;
                setActionMessage(`⚠️ ${errorMsg}`);
                if (action === 'run') updateStatus('ERROR', errorMsg);
            }
        } catch (err: any) {
            const errorMsg = err?.message || `Unable to ${action} bot`;
            setActionMessage(`⚠️ ${errorMsg}`);
            if (action === 'run') updateStatus('ERROR', errorMsg);
        } finally {
            setActionLoading(false);
        }
    };

    const updatePositionSize = async () => {
        setPositionSizeMessage('');
        if (positionSize > bot.risk.maxExposure) {
            setPositionSizeMessage(`⚠️ Exceeds max exposure (${bot.risk.maxExposure})`);
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
                setPositionSizeMessage(`Set to ${positionSize} XRP`);
            } else {
                setPositionSizeMessage(data?.error || 'Failed');
            }
        } catch (err: any) {
            setPositionSizeMessage(err?.message || 'Failed');
        }
    };

    const applyTradingPair = async (pairKey: string) => {
        setSelectedPairKey(pairKey);
        try {
            const res = await fetch('/api/bot/trading-pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pairKey }),
            });
            if (res.ok) {
                const pair = findPair(pairKey);
                if (pair) {
                    setBot((prev) => ({
                        ...prev,
                        liquidity: pair.liquidity === 'high' ? 'High' : pair.liquidity === 'medium' ? 'Medium' : 'Low',
                    }));
                }
            }
        } catch (err) {
            console.error('Failed to set trading pair:', err);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Pair selector for Controls panel
    // ─────────────────────────────────────────────────────────────────────────

    const pairSelectorElement = (
        <select
            value={selectedPairKey}
            onChange={(e) => applyTradingPair(e.target.value)}
            className="w-full rounded-lg bg-slate-900 border border-white/10 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-500"
        >
            <option value="" disabled>Select pair...</option>
            {TRADING_PAIRS.map((pair) => (
                <option key={pair.key} value={pair.key}>{pair.key}</option>
            ))}
        </select>
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────────────────

    return (
        <DashboardLayout
            header={
                <TerminalHeader
                    pairSelector={
                        <CompactPairSelector
                            pairs={TRADING_PAIRS}
                            selectedKey={selectedPairKey}
                            onChange={applyTradingPair}
                        />
                    }
                    status={bot.status}
                    paper={bot.paper}
                    network={bot.network}
                    connected={connected}
                    loading={actionLoading}
                    onRun={() => callAction('run')}
                    onPause={() => callAction('pause')}
                    onKill={() => callAction('kill')}
                    message={actionMessage}
                />
            }
            flowSidebar={
                <FlowMetricsPanel pollInterval={2000} />
            }
            leftTop={
                <OrderBookPanel
                    bids={orderBookBids}
                    asks={orderBookAsks}
                    midPrice={midPrice}
                    spreadBps={bot.spreadBps}
                />
            }
            leftBottom={
                <MarketStatsPanel
                    totalPnl={bot.pnlTotal}
                    todayPnl={bot.pnlToday}
                    winRate={bot.winRate}
                    position={bot.openPosition}
                    xrpBalance={bot.xrpBalance}
                    quoteBalance={bot.quoteBalance}
                    quoteCurrency={bot.quoteCurrency}
                    nzdRate={bot.nzdRate}
                />
            }
            centerTop={
                <ChartPanel
                    data={candleData}
                    pairKey={currentPair?.key || 'Select Pair'}
                    currentPrice={currentPrice}
                    quoteCurrency={bot.quoteCurrency}
                    spreadBps={bot.spreadBps}
                />
            }
            centerBottom={
                <ControlsPanel
                    pairSelector={pairSelectorElement}
                    strategy={bot.strategy}
                    lastLedger={bot.lastLedger}
                    liquidity={bot.liquidity}
                    slippageBps={bot.slippageBps}
                    positionSize={positionSize}
                    maxExposure={bot.risk.maxExposure}
                    currentExposure={bot.risk.currentExposure}
                    dailyLossLimit={bot.risk.dailyLossLimit}
                    killSwitch={bot.risk.killSwitch}
                    onPositionSizeChange={setPositionSize}
                    onApplyPositionSize={updatePositionSize}
                    loading={actionLoading}
                    message={positionSizeMessage}
                />
            }
            rightTop={
                <TradeTapePanel pairKey={selectedPairKey || undefined} maxRows={100} />
            }
            rightBottom={
                <LogsPanel maxRows={100} />
            }
        />
    );
}
