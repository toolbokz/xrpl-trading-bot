"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TRADING_PAIRS, TradingPair, findPair } from '../lib/tradingPairs';

// Layout components
import { AppShell } from '../components/layout/AppShell';
import { TerminalHeader } from '../components/TerminalHeader';

// Panel components
import { OrderBookPanel } from '../components/OrderBookPanel';
import { MarketStatsPanel } from '../components/MarketStatsPanel';
import { ChartPanel } from '../components/ChartPanel';
import { ControlsPanel } from '../components/ControlsPanel';
import { TradeTapePanel } from '../components/TradeTapePanel';
import { LogsPanel } from '../components/LogsPanel';
import { FlowMetricsPanel } from '../components/FlowMetricsPanel';
import { AnalyticsPanel } from '../components/AnalyticsPanel';
import { AdaptivePanel } from '../components/AdaptivePanel';
import { GovernancePanel } from '../components/GovernancePanel';
import { RegimeHeatmapPanel } from '../components/RegimeHeatmapPanel';
import { MarketDataHealthPanel } from '../components/MarketDataHealthPanel';

// Mobile layout
import { MobileDashboard, MobileSection } from '../components/layout/MobileDashboard';

// Data hooks (real data fetching)
import { useOrderBook } from '../lib/hooks/useOrderBook';
import { useCandles } from '../lib/hooks/useCandles';

// Mock data warning
import { MockDataBanner } from '../components/MockDataBanner';

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
    usdRate: number | null;
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
    usdRate: null,
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
    const [connected, setConnected] = useState<boolean>(false);

    const currentPair = useMemo(() => findPair(selectedPairKey), [selectedPairKey]);

    // ─────────────────────────────────────────────────────────────────────────
    // Real Data Hooks (NO MOCK DATA)
    // ─────────────────────────────────────────────────────────────────────────

    // Order book from real XRPL data via /api/pairs/[key]/orderbook
    const {
        data: orderBookData,
        loading: orderBookLoading,
        error: orderBookError,
    } = useOrderBook(selectedPairKey, {
        pollInterval: 3000,
        depth: 15,
        enabled: !!selectedPairKey,
    });

    // Candles from real trade data via /api/pairs/[key]/candles
    const {
        candles: candleData,
        loading: candlesLoading,
        error: candlesError,
    } = useCandles(selectedPairKey, {
        interval: '1m',
        limit: 120,
        pollInterval: 10000,
        enabled: !!selectedPairKey,
    });

    // Derived values from order book
    const currentPrice = orderBookData.midPrice ?? 0;
    const midPrice = orderBookData.midPrice;
    const orderBookBids = orderBookData.bids;
    const orderBookAsks = orderBookData.asks;

    // ─────────────────────────────────────────────────────────────────────────
    // Data Fetching (non-mock)
    // ─────────────────────────────────────────────────────────────────────────

    // Update spread and connected status when order book data arrives
    useEffect(() => {
        if (orderBookData.spreadBps !== null) {
            setBot((prev) => ({ ...prev, spreadBps: orderBookData.spreadBps ?? prev.spreadBps }));
        }
        if (!orderBookLoading && !orderBookError && selectedPairKey) {
            setConnected(true);
        }
    }, [orderBookData.spreadBps, orderBookLoading, orderBookError, selectedPairKey]);

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
                    usdRate: data.usdRate ?? null,
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

    // Initial fetch
    useEffect(() => {
        fetchStatus();
        fetchRiskStatus();
        fetchTrades();
        const deferredFetch = setTimeout(() => {
            fetchWalletInfo(currentPair);
        }, 500);
        return () => clearTimeout(deferredFetch);
    }, [fetchStatus, fetchRiskStatus, fetchTrades, fetchWalletInfo, currentPair]);

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
        const previousPairKey = selectedPairKey;
        try {
            const res = await fetch('/api/bot/trading-pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pairKey }),
            });
            if (res.ok) {
                setSelectedPairKey(pairKey);
                const pair = findPair(pairKey);
                if (pair) {
                    setBot((prev) => ({
                        ...prev,
                        liquidity: pair.liquidity === 'high' ? 'High' : pair.liquidity === 'medium' ? 'Medium' : 'Low',
                    }));
                    // Immediately refresh balances for the new pair
                    fetchWalletInfo(pair);
                }
            } else {
                setSelectedPairKey(previousPairKey);
            }
        } catch (err) {
            setSelectedPairKey(previousPairKey);
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
    // Detect mobile viewport
    // ─────────────────────────────────────────────────────────────────────────
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // Header component
    // ─────────────────────────────────────────────────────────────────────────
    const headerComponent = (
        <TerminalHeader
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
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Mobile Layout
    // ─────────────────────────────────────────────────────────────────────────
    if (isMobile) {
        return (
            <MobileDashboard
                header={headerComponent}
                flowMetrics={<FlowMetricsPanel pollInterval={2000} compact />}
                overviewContent={
                    <MobileSection>
                        <ChartPanel
                            data={candleData}
                            pairKey={currentPair?.key || 'Select Pair'}
                            currentPrice={currentPrice}
                            quoteCurrency={bot.quoteCurrency}
                            spreadBps={orderBookData.spreadBps ?? bot.spreadBps}
                            loading={candlesLoading}
                            error={candlesError}
                        />
                        <MarketStatsPanel
                            totalPnl={bot.pnlTotal}
                            todayPnl={bot.pnlToday}
                            winRate={bot.winRate}
                            position={bot.openPosition}
                            xrpBalance={bot.xrpBalance}
                            quoteBalance={bot.quoteBalance}
                            quoteCurrency={bot.quoteCurrency}
                            usdRate={bot.usdRate}
                        />
                        <MarketDataHealthPanel />
                    </MobileSection>
                }
                marketContent={
                    <MobileSection>
                        <OrderBookPanel
                            bids={orderBookBids}
                            asks={orderBookAsks}
                            midPrice={midPrice}
                            spreadBps={orderBookData.spreadBps ?? bot.spreadBps}
                            loading={orderBookLoading}
                            error={orderBookError}
                        />
                        <TradeTapePanel pairKey={selectedPairKey || undefined} maxRows={50} />
                    </MobileSection>
                }
                tradingContent={
                    <MobileSection>
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
                        <LogsPanel maxRows={50} />
                    </MobileSection>
                }
                analyticsContent={
                    <MobileSection>
                        <RegimeHeatmapPanel />
                        <AnalyticsPanel pollInterval={5000} />
                        <AdaptivePanel pollInterval={5000} />
                    </MobileSection>
                }
                governanceContent={
                    <MobileSection>
                        <GovernancePanel />
                    </MobileSection>
                }
            />
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Desktop Layout - Full-screen professional grid
    // ─────────────────────────────────────────────────────────────────────────

    return (
        <AppShell header={headerComponent}>
            <div className="h-full w-full grid gap-2 overflow-hidden
                grid-cols-[180px_240px_1fr_240px_200px]
                grid-rows-[minmax(0,0.45fr)_minmax(0,0.55fr)]
                lg:grid-cols-[200px_260px_1fr_260px_220px]
                xl:grid-cols-[200px_280px_1fr_300px_260px]
                2xl:grid-cols-[220px_300px_1fr_320px_280px]"
            >
                {/* Left sidebar: Market Stats + Data Health + Flow Metrics (spans 2 rows) */}
                <div className="row-span-2 min-h-0 overflow-hidden flex flex-col gap-2">
                    <div className="shrink-0">
                        <MarketStatsPanel
                            totalPnl={bot.pnlTotal}
                            todayPnl={bot.pnlToday}
                            winRate={bot.winRate}
                            position={bot.openPosition}
                            xrpBalance={bot.xrpBalance}
                            quoteBalance={bot.quoteBalance}
                            quoteCurrency={bot.quoteCurrency}
                            usdRate={bot.usdRate}
                        />
                    </div>
                    <div className="shrink-0">
                        <MarketDataHealthPanel />
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <FlowMetricsPanel pollInterval={2000} />
                    </div>
                </div>

                {/* Trade Tape + Order Book (spans 2 rows, col 2) */}
                <div className="row-span-2 min-h-0 overflow-hidden flex flex-col gap-2">
                    <div className="h-[45%] min-h-0 overflow-hidden">
                        <TradeTapePanel pairKey={selectedPairKey || undefined} maxRows={100} />
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <OrderBookPanel
                            bids={orderBookBids}
                            asks={orderBookAsks}
                            midPrice={midPrice}
                            spreadBps={orderBookData.spreadBps ?? bot.spreadBps}
                            loading={orderBookLoading}
                            error={orderBookError}
                        />
                    </div>
                </div>

                {/* Chart (row 1, col 3) */}
                <div className="min-h-0 overflow-hidden">
                    <ChartPanel
                        data={candleData}
                        pairKey={currentPair?.key || 'Select Pair'}
                        currentPrice={currentPrice}
                        quoteCurrency={bot.quoteCurrency}
                        spreadBps={orderBookData.spreadBps ?? bot.spreadBps}
                        loading={candlesLoading}
                        error={candlesError}
                    />
                </div>

                {/* Controls column (row-span-2, col 4): Governance, Logs */}
                <div className="row-span-2 min-h-0 overflow-hidden flex flex-col gap-2">
                    <div className="shrink-0">
                        <GovernancePanel />
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <LogsPanel maxRows={50} />
                    </div>
                </div>

                {/* Analytics sidebar (row 1+2, col 5): Analytics, Adaptive */}
                <div className="row-span-2 min-h-0 overflow-hidden flex flex-col gap-2">
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <AnalyticsPanel pollInterval={5000} />
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <AdaptivePanel pollInterval={5000} />
                    </div>
                </div>

                {/* Below chart (row 2, col 3): RegimeHeatmap + Controls stacked */}
                <div className="min-h-0 overflow-hidden flex flex-col gap-2">
                    <div className="shrink-0">
                        <RegimeHeatmapPanel />
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
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
                    </div>
                </div>
            </div>
        </AppShell>
    );
}
