'use client';

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ChevronLeft,
    ChevronRight,
    ListOrdered,
    Logs,
} from 'lucide-react';
import clsx from 'clsx';
import { findInstrument as findPair, getInstruments, type Instrument } from '../lib/instruments';
import { AppShell } from '../components/layout/AppShell';
import { TerminalHeader } from '../components/TerminalHeader';
import { OrderBookPanel } from '../components/OrderBookPanel';
import { TradeTapePanel } from '../components/TradeTapePanel';
import { LogsPanel } from '../components/LogsPanel';
import { FlowMetricsPanel } from '../components/FlowMetricsPanel';
import { GovernancePanel } from '../components/GovernancePanel';
import { RegimeHeatmapPanel } from '../components/RegimeHeatmapPanel';
import { AdaptivePanel } from '../components/AdaptivePanel';
import { VolatilityStopPanel } from '../components/VolatilityStopPanel';
import { ScannerPanel } from '../components/ScannerPanel';
import { RiskStressPanel } from '../components/RiskStressPanel';
import { ExecutionQualityPanel } from '../components/ExecutionQualityPanel';
import { EdgeAttributionPanel } from '../components/EdgeAttributionPanel';
import { LatencyImpactPanel } from '../components/LatencyImpactPanel';
import { SlippageRealismPanel } from '../components/SlippageRealismPanel';
import { AttributionCompletenessPanel } from '../components/AttributionCompletenessPanel';
import { TradeHistoryDiagnosticsPanel } from '../components/TradeHistoryDiagnosticsPanel';
import { useOrderBook } from '../lib/hooks/useOrderBook';
import { RuntimeCacheProvider, useRuntimeCache } from '../lib/hooks/useRuntimeCache';
import { RuntimeEventsProvider, useRuntimeEvents } from '../lib/hooks/useRuntimeEvents';
import { useMarketHealth } from '../lib/hooks/useMarketHealth';
import { toBackgroundView } from '../components/backgroundScannerViewModel';
import { hasOrderFilledEvent } from '../lib/runtimeEvents';
import { useRiskStress } from '../lib/hooks/useRiskStress';
import { useSpreadModel } from '../lib/hooks/useSpreadModel';

type BotStatus = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';
type ToolTab = 'tape' | 'radar' | 'diagnostics';
type DrawerTab = 'logs';
type DiagnosticsTab = 'execution' | 'risk' | 'policy' | 'latency' | 'trades';

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
    pnlTotal: number;
    pnlToday: number;
    winRate: number;
    openPosition: string;
    spreadBps: number;
    risk: {
        maxExposure: number;
        currentExposure: number;
        dailyLossLimit: number;
        killSwitch: boolean;
    };
    tradeCount: number;
}

const createInitialBotState = (): BotState => ({
    status: 'STOPPED',
    network: (process.env.NEXT_PUBLIC_XRPL_NETWORK?.toUpperCase() === 'TESTNET' ? 'TESTNET' : 'MAINNET') as 'MAINNET' | 'TESTNET',
    paper: true,
    wallet: 'rABC...1234',
    xrpBalance: 0,
    usdRate: null,
    baseCurrency: 'XRP',
    quoteCurrency: '',
    baseBalance: 0,
    quoteBalance: 0,
    strategy: 'orderbook-scalper',
    pnlTotal: 0,
    pnlToday: 0,
    winRate: 0,
    openPosition: 'Flat',
    spreadBps: 0,
    risk: {
        maxExposure: 5000,
        currentExposure: 0,
        dailyLossLimit: 500,
        killSwitch: false,
    },
    tradeCount: 0,
});

function DashboardPageContent() {
    const tradeToastsEnabled = process.env.NEXT_PUBLIC_TRADE_TOASTS_ENABLED !== 'false';
    const [bot, setBot] = useState<BotState>(createInitialBotState);
    const [actionMessage, setActionMessage] = useState<string>('');
    const [actionLoading, setActionLoading] = useState<boolean>(false);
    const [selectedPairKey, setSelectedPairKey] = useState<string>('');
    const [connected, setConnected] = useState<boolean>(false);

    const [activeToolTab, setActiveToolTab] = useState<ToolTab>('tape');
    const [drawerTab, setDrawerTab] = useState<DrawerTab>('logs');
    const [activeDiagnosticsTab, setActiveDiagnosticsTab] = useState<DiagnosticsTab>('execution');
    const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

    const [viewportWidth, setViewportWidth] = useState<number>(1600);
    const isNarrow = viewportWidth <= 1200;
    const isCompact = viewportWidth <= 800;

    const [activePairPriceTrend, setActivePairPriceTrend] = useState<'up' | 'down' | 'neutral'>('neutral');
    const [tradeRefreshSeq, setTradeRefreshSeq] = useState(0);

    const currentPair = useMemo(() => findPair(selectedPairKey), [selectedPairKey]);
    const diagnosticsVisible = activeToolTab === 'diagnostics';

    // Live flow regime — polled from /api/bot/flow so AdaptivePanel shows the
    // tuning bucket that actually matches current market conditions.
    type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';
    const [liveRegime, setLiveRegime] = useState<FlowRegime | null>(null);
    useEffect(() => {
        if (!diagnosticsVisible) return;
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await fetch('/api/bot/flow');
                if (!res.ok) return;
                const json = await res.json();
                if (!cancelled && json?.regime?.current) {
                    setLiveRegime(json.regime.current as FlowRegime);
                }
            } catch { /* swallow */ }
        };
        poll();
        const id = setInterval(poll, 5_000);
        return () => { cancelled = true; clearInterval(id); };
    }, [diagnosticsVisible]);

    const {
        data: orderBookData,
        loading: orderBookLoading,
        error: orderBookError,
    } = useOrderBook(selectedPairKey, {
        pollInterval: 3000,
        depth: 15,
        enabled: !!selectedPairKey,
    });

    const runtimeCache = useRuntimeCache();
    const runtimeEvents = useRuntimeEvents({ enabled: true });
    const bgView = toBackgroundView(runtimeCache.data?.snapshot ?? null);
    const marketHealth = useMarketHealth(selectedPairKey || null, { pollInterval: 5000 });
    const spreadModel = useSpreadModel();
    const riskStress = useRiskStress({
        pollInterval: 10_000,
        enabled: diagnosticsVisible,
        pairKey: selectedPairKey || null,
    });

    const orderBookBids = orderBookData.bids;
    const orderBookAsks = orderBookData.asks;
    const midPrice = orderBookData.midPrice;

    useEffect(() => {
        const savedToolTab = window.localStorage.getItem('xrpl.toolTab') as ToolTab | null;
        if (savedToolTab && ['tape', 'radar', 'diagnostics'].includes(savedToolTab)) {
            setActiveToolTab(savedToolTab);
        }
        const savedDrawerTab = window.localStorage.getItem('xrpl.drawerTab') as DrawerTab | null;
        if (savedDrawerTab && ['logs'].includes(savedDrawerTab)) {
            setDrawerTab(savedDrawerTab);
        }
        const savedDiagnosticsTab = window.localStorage.getItem('xrpl.diagnosticsTab') as DiagnosticsTab | null;
        if (savedDiagnosticsTab && ['execution', 'risk', 'policy', 'latency', 'trades'].includes(savedDiagnosticsTab)) {
            setActiveDiagnosticsTab(savedDiagnosticsTab);
        }

        const onResize = () => setViewportWidth(window.innerWidth);
        onResize();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        window.localStorage.setItem('xrpl.toolTab', activeToolTab);
    }, [activeToolTab]);

    useEffect(() => {
        window.localStorage.setItem('xrpl.drawerTab', drawerTab);
    }, [drawerTab]);

    useEffect(() => {
        window.localStorage.setItem('xrpl.diagnosticsTab', activeDiagnosticsTab);
    }, [activeDiagnosticsTab]);

    useEffect(() => {
        if (!selectedPairKey) {
            (async () => {
                try {
                    const res = await fetch('/api/bot/wallet');
                    const data = await res.json();
                    const base = data?.baseCurrency || 'XRP';
                    const quote = data?.quoteCurrency;
                    if (quote) {
                        const envKey = `${base}/${quote}`;
                        if (findPair(envKey)) {
                            setSelectedPairKey(envKey);
                            return;
                        }
                    }
                } catch {
                    // ignore
                }
                const first = getInstruments()[0];
                if (first) setSelectedPairKey(first.key);
            })();
        }
    }, [selectedPairKey]);

    useEffect(() => {
        if (orderBookData.spreadBps !== null) {
            setBot((prev) => ({ ...prev, spreadBps: orderBookData.spreadBps ?? prev.spreadBps }));
        }
        if (!orderBookLoading && !orderBookError && selectedPairKey) {
            setConnected(true);
        }
    }, [orderBookData.spreadBps, orderBookLoading, orderBookError, selectedPairKey]);

    const prevMidPriceRef = useRef<number | null>(null);
    useEffect(() => {
        const current = midPrice;
        const prev = prevMidPriceRef.current;
        if (current != null && Number.isFinite(current) && prev != null && Number.isFinite(prev)) {
            if (current > prev) setActivePairPriceTrend('up');
            else if (current < prev) setActivePairPriceTrend('down');
            else setActivePairPriceTrend('neutral');
        }
        if (current != null && Number.isFinite(current)) {
            prevMidPriceRef.current = current;
        }
    }, [midPrice]);

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
            setBot((prev) => ({
                ...prev,
                risk: {
                    maxExposure: data.maxExposure ?? prev.risk.maxExposure,
                    currentExposure: data.currentExposure ?? prev.risk.currentExposure,
                    dailyLossLimit: data.dailyLossLimit ?? prev.risk.dailyLossLimit,
                    killSwitch: data.killSwitch ?? prev.risk.killSwitch,
                },
            }));
        } catch {
            // ignore
        }
    }, []);

    const fetchWalletInfo = useCallback(async (pair?: Instrument) => {
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
            setBot((prev) => ({
                ...prev,
                wallet: data.address ? `${data.address.slice(0, 6)}...${data.address.slice(-4)}` : prev.wallet,
                xrpBalance: data.balance ?? 0,
                usdRate: data.usdRate ?? null,
                network: (data.network === 'MAINNET' || data.network === 'TESTNET') ? data.network : prev.network,
                baseCurrency: data.baseCurrency || data.tradingPair?.base || pair?.base.currency || 'XRP',
                quoteCurrency: data.quoteCurrency || data.tradingPair?.quote || pair?.quote.currency || '',
                baseBalance: data.baseBalance ?? data.balance ?? 0,
                quoteBalance: data.quoteBalance ?? 0,
            }));
        } catch {
            // ignore
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
                    tradeCount: data.stats.totalTrades || 0,
                }));
            }
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        const events = runtimeEvents.data?.events ?? [];
        if (events.length === 0) return;
        if (hasOrderFilledEvent(events)) {
            void fetchTrades();
            setTradeRefreshSeq(s => s + 1);
        }
    }, [runtimeEvents.data?.seq, runtimeEvents.data?.events, fetchTrades]);

    useEffect(() => {
        fetchStatus();
        fetchRiskStatus();
        fetchTrades();
        const deferred = setTimeout(() => {
            fetchWalletInfo(currentPair);
        }, 500);
        return () => clearTimeout(deferred);
    }, [fetchStatus, fetchRiskStatus, fetchTrades, fetchWalletInfo, currentPair]);

    useEffect(() => {
        const riskIv = setInterval(fetchRiskStatus, 30_000);
        const walletIv = setInterval(() => fetchWalletInfo(currentPair), 60_000);
        const tradesIv = setInterval(fetchTrades, 30_000);
        return () => {
            clearInterval(riskIv);
            clearInterval(walletIv);
            clearInterval(tradesIv);
        };
    }, [fetchRiskStatus, fetchWalletInfo, fetchTrades, currentPair]);

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
                const msg = data?.error || `Unable to ${action} bot`;
                setActionMessage(`⚠️ ${msg}`);
                if (action === 'run') updateStatus('ERROR', msg);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : `Unable to ${action} bot`;
            setActionMessage(`⚠️ ${msg}`);
            if (action === 'run') updateStatus('ERROR', msg);
        } finally {
            setActionLoading(false);
        }
    };

    const stripWarnings = useMemo(() => {
        const warnings: string[] = [];
        if (marketHealth.data?.xrpl.connected === false) warnings.push('xrpl-down');
        if (!connected && !marketHealth.data) warnings.push('xrpl-unknown');
        if (marketHealth.data?.orderBook.stale) warnings.push('book-stale');
        if (marketHealth.data?.tradeTape.stale) warnings.push('tape-stale');
        if (bgView?.health.degraded) warnings.push('scanner-degraded');
        if ((bgView?.fairValue.sources.length ?? 0) < 1) warnings.push('low-samples');
        if (bot.risk.killSwitch) warnings.push('kill-switch');
        if (bot.status === 'ERROR') warnings.push('runtime-error');
        if (riskStress.data.hardRiskState === 'BLOCKED') warnings.push('hard-risk-blocked');
        if (riskStress.data.executionAllowed === false) warnings.push('execution-blocked');
        if (riskStress.data.consecutiveFailures >= 5) warnings.push('consec-failures');
        if (!marketHealth.data?.overall.healthy) warnings.push('market-unhealthy');
        return warnings;
    }, [connected, marketHealth.data, bgView?.health.degraded, bgView?.fairValue.sources.length, bot.risk.killSwitch, bot.status, riskStress.data.hardRiskState, riskStress.data.executionAllowed, riskStress.data.consecutiveFailures]);

    const severity = useMemo(() => {
        if (bot.status === 'ERROR') return 3;
        if (stripWarnings.length > 0) return 2;
        return 0;
    }, [bot.status, stripWarnings.length]);

    const previous = useRef({ severity: 0, tradeCount: 0 });
    useEffect(() => {
        const severityIncreased = severity > previous.current.severity;
        const newFill = bot.tradeCount > previous.current.tradeCount;
        if ((severityIncreased || newFill) && !isCompact) {
            setDrawerOpen(true);
        }
        previous.current = { severity, tradeCount: bot.tradeCount };
    }, [severity, bot.tradeCount, isCompact]);

    const statusChips = useMemo(() => {
        const exposurePct = bot.risk.maxExposure > 0
            ? Math.min(999, (bot.risk.currentExposure / bot.risk.maxExposure) * 100)
            : 0;
        const scannerState = !bgView ? 'OFF' : bgView.health.degraded ? 'ERR' : 'OK';
        const scannerTone = !bgView ? 'neutral' : bgView.health.degraded ? 'warn' : 'ok';
        const volatilityStop = runtimeCache.data?.snapshot?.volatilityStop ?? null;
        const volatilityReadyValue = !volatilityStop
            ? 'N/A'
            : !volatilityStop.enabled
                ? 'OFF'
                : (volatilityStop.volReady ? 'YES' : 'NO');
        const volatilityReadyTone: 'ok' | 'bad' | 'warn' | 'neutral' = !volatilityStop
            ? 'neutral'
            : !volatilityStop.enabled
                ? 'neutral'
                : (volatilityStop.volReady ? 'ok' : 'warn');
        const volatilityBpsValue = volatilityStop
            ? `${volatilityStop.volBps.toFixed(1)} bps`
            : 'N/A';
        const stopLossBpsValue = volatilityStop
            ? `${volatilityStop.stopLossBpsUsed.toFixed(1)} bps`
            : 'N/A';

        // Authoritative XRPL connection (from market health endpoint, not derived from orderbook fetch)
        const xrplConnected = marketHealth.data?.xrpl.connected ?? connected;
        const xrplReconnects = marketHealth.data?.xrpl.reconnects ?? 0;

        // Hard risk state
        const hardState = riskStress.data.hardRiskState;
        const hardRiskValue = hardState ?? '—';
        const hardRiskTone: 'ok' | 'bad' | 'warn' | 'neutral' = hardState === 'BLOCKED' ? 'bad'
            : hardState === 'WARNING' ? 'warn'
                : hardState === 'CLEAR' ? 'ok'
                    : 'neutral';

        // Execution gate
        const execAllowed = riskStress.data.executionAllowed;
        const gateTone: 'ok' | 'bad' | 'warn' | 'neutral' = execAllowed === true ? 'ok'
            : execAllowed === false ? 'bad'
                : 'neutral';

        // Daily loss
        const dailyLossCurrent = riskStress.data.dailyLossCurrent;
        const dailyLossLimit = riskStress.data.dailyLossLimit;
        const dailyLossPct = (dailyLossLimit != null && dailyLossLimit > 0 && dailyLossCurrent != null)
            ? (dailyLossCurrent / dailyLossLimit) * 100 : 0;
        const dailyLossValue = dailyLossCurrent != null
            ? `${dailyLossCurrent.toFixed(2)}${dailyLossLimit != null ? ` / ${dailyLossLimit.toFixed(0)}` : ''}`
            : '—';

        // Network
        const networkLabel = marketHealth.data?.network ?? bot.network?.toLowerCase() ?? '—';

        // Consecutive failures
        const consecFails = riskStress.data.consecutiveFailures;

        // Trade tape
        const tapeStale = marketHealth.data?.tradeTape.stale;

        // Feed health
        const feedHealthy = riskStress.data.feedHealthy;

        return [
            { key: 'state', label: 'Run', value: bot.status, tone: bot.status === 'RUNNING' ? 'ok' : bot.status === 'ERROR' ? 'bad' : 'warn' },
            { key: 'net', label: 'Net', value: networkLabel === 'testnet' ? 'TEST' : networkLabel === 'mainnet' ? 'MAIN' : networkLabel.toUpperCase(), tone: networkLabel === 'testnet' ? 'warn' : 'neutral' },
            { key: 'today', label: 'P&L Today', value: fmtSigned(bot.pnlToday, 6), tone: bot.pnlToday >= 0 ? 'ok' : 'bad' },
            { key: 'session', label: 'Session', value: fmtSigned(bot.pnlTotal, 6), tone: bot.pnlTotal >= 0 ? 'ok' : 'bad' },
            { key: 'win', label: 'Win', value: `${bot.winRate.toFixed(1)}%`, tone: bot.winRate >= 50 ? 'ok' : 'neutral' },
            { key: 'trades', label: 'Trades', value: String(bot.tradeCount), tone: 'neutral' },
            { key: 'position', label: 'Pos', value: `${bot.openPosition} ${bot.risk.currentExposure.toFixed(0)}`, tone: 'neutral' },
            {
                key: 'pair-balance',
                label: 'Pair Bal',
                value: `${bot.baseBalance.toFixed(2)} ${bot.baseCurrency} | ${bot.quoteBalance.toFixed(2)} ${bot.quoteCurrency || 'QUOTE'}`,
                tone: 'neutral',
            },
            { key: 'venue', label: 'XRPL', value: xrplConnected ? `UP${xrplReconnects > 0 ? ` (${xrplReconnects}r)` : ''}` : 'DOWN', tone: xrplConnected ? 'ok' : 'bad' },
            { key: 'gate', label: 'Gate', value: execAllowed === true ? 'OPEN' : execAllowed === false ? 'SHUT' : '—', tone: gateTone },
            { key: 'hard-risk', label: 'H-Risk', value: hardRiskValue, tone: hardRiskTone },
            { key: 'risk', label: 'Exposure', value: `${exposurePct.toFixed(0)}%`, tone: exposurePct >= 80 ? 'warn' : 'neutral' },
            { key: 'daily-loss', label: 'Day Loss', value: dailyLossValue, tone: dailyLossPct >= 80 ? 'bad' : dailyLossPct >= 50 ? 'warn' : 'neutral' },
            { key: 'capital', label: 'Capital', value: bot.risk.killSwitch ? 'PROTECT' : 'NORMAL', tone: bot.risk.killSwitch ? 'warn' : 'ok' },
            { key: 'consec-fail', label: 'Fails', value: String(consecFails), tone: consecFails >= 5 ? 'bad' : consecFails >= 3 ? 'warn' : 'neutral' },
            { key: 'feed', label: 'Feed', value: feedHealthy === true ? 'OK' : feedHealthy === false ? 'ERR' : '—', tone: feedHealthy === true ? 'ok' : feedHealthy === false ? 'bad' : 'neutral' },
            { key: 'book', label: 'Book', value: marketHealth.data?.orderBook.stale ? 'STALE' : 'FRESH', tone: marketHealth.data?.orderBook.stale ? 'warn' : 'ok' },
            { key: 'tape', label: 'Tape', value: tapeStale ? 'STALE' : 'FRESH', tone: tapeStale ? 'warn' : 'ok' },
            { key: 'vol-ready', label: 'Vol Ready', value: volatilityReadyValue, tone: volatilityReadyTone },
            { key: 'vol-bps', label: 'Vol', value: volatilityBpsValue, tone: volatilityReadyTone },
            { key: 'stop-bps', label: 'Stop Bps', value: stopLossBpsValue, tone: volatilityStop?.enabled ? 'warn' : 'neutral' },
            { key: 'scanner', label: 'Scanner', value: scannerState, tone: scannerTone },
            { key: 'samples', label: 'Samples', value: String(bgView?.fairValue.sources.length ?? 0), tone: (bgView?.fairValue.sources.length ?? 0) < 1 ? 'warn' : 'neutral' },
        ] as Array<{ key: string; label: string; value: string; tone: 'ok' | 'bad' | 'warn' | 'neutral' }>;
    }, [bot.status, bot.network, bot.pnlToday, bot.pnlTotal, bot.winRate, bot.tradeCount, bot.openPosition, bot.baseBalance, bot.baseCurrency, bot.quoteBalance, bot.quoteCurrency, bot.risk.currentExposure, bot.risk.maxExposure, bot.risk.killSwitch, connected, riskStress.data.hardRiskState, riskStress.data.executionAllowed, riskStress.data.dailyLossCurrent, riskStress.data.dailyLossLimit, riskStress.data.consecutiveFailures, riskStress.data.feedHealthy, bgView, marketHealth.data, runtimeCache.data?.snapshot?.volatilityStop]);

    const activePairPriceDisplay = useMemo(() => {
        const pairLabel = selectedPairKey || `${bot.baseCurrency}/${bot.quoteCurrency || 'QUOTE'}`;
        const price = midPrice;
        const priceText = price != null && Number.isFinite(price) ? price.toFixed(6) : '—';
        return `${pairLabel} ${priceText}`;
    }, [selectedPairKey, bot.baseCurrency, bot.quoteCurrency, midPrice]);

    const activePairMarket = useMemo(() => {
        const key = runtimeCache.data?.snapshot?.pairKey;
        if (!key) return null;
        return bgView?.markets.find((m) => m.pairKey === key) ?? null;
    }, [runtimeCache.data?.snapshot?.pairKey, bgView?.markets]);

    const toolTabs: Array<{ id: ToolTab; label: string }> = [
        { id: 'tape', label: 'Tape' },
        { id: 'radar', label: 'Scanner' },
        { id: 'diagnostics', label: 'Diagnostics' },
    ];

    const drawerTabs: Array<{ id: DrawerTab; label: string; icon: typeof ListOrdered }> = [
        { id: 'logs', label: 'Logs', icon: Logs },
    ];
    const diagnosticsTabs: Array<{ id: DiagnosticsTab; label: string }> = [
        { id: 'execution', label: 'Execution' },
        { id: 'risk', label: 'Risk Stress' },
        { id: 'policy', label: 'Policy' },
        { id: 'latency', label: 'Latency' },
        { id: 'trades', label: 'Trade History' },
    ];

    const onToolTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const nextIndex = (index + offset + toolTabs.length) % toolTabs.length;
        const nextTab = toolTabs[nextIndex];
        if (nextTab) {
            setActiveToolTab(nextTab.id);
        }
    };

    const onDrawerTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const nextIndex = (index + offset + drawerTabs.length) % drawerTabs.length;
        const nextTab = drawerTabs[nextIndex];
        if (nextTab) {
            setDrawerTab(nextTab.id);
        }
    };

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

    const marketQualityCard = (
        <div className="card min-h-[260px] p-4">
            <h3 className="mb-3 text-base font-semibold text-slate-100">Market Quality</h3>
            <div className="space-y-2">
                <MetricLine label="Spread now" value={`${fmtNum(orderBookData.spreadBps, 1)} bps`} />
                <MetricLine
                    label="Spread percentile"
                    value={spreadModel.data.lookback24h?.p75Bps != null ? `${spreadModel.data.lookback24h.p75Bps.toFixed(1)} p75` : '—'}
                />
                <MetricLine label="Depth (top)" value={fmtNum(activePairMarket?.depthTopNotional ?? null, 0)} />
                <MetricLine label="Staleness" value={fmtMs(activePairMarket?.stalenessMs ?? null)} />
                <MetricLine
                    label="Mid / Bid / Ask"
                    value={`${fmtNum(midPrice, 4)} / ${fmtNum(orderBookBids[0]?.price ?? null, 4)} / ${fmtNum(orderBookAsks[0]?.price ?? null, 4)}`}
                />
            </div>
        </div>
    );

    const diagnosticsPanel = (
        <div className="space-y-4">
            <section className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-2" role="tablist" aria-label="Diagnostics tabs">
                    {diagnosticsTabs.map((tab) => (
                        <button
                            key={tab.id}
                            role="tab"
                            aria-selected={activeDiagnosticsTab === tab.id}
                            onClick={() => setActiveDiagnosticsTab(tab.id)}
                            className={clsx(
                                'rounded-md border px-3 py-1.5 text-sm',
                                activeDiagnosticsTab === tab.id
                                    ? 'border-sky-500/30 bg-sky-500/20 text-sky-300'
                                    : 'border-white/10 text-slate-400 hover:text-slate-200',
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </section>

            {activeDiagnosticsTab === 'execution' && (
                <>
                    <section className="space-y-3">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Execution Quality</h3>
                        <div className="grid gap-4 lg:grid-cols-2">
                            <div className="min-h-[260px]">
                                <SlippageRealismPanel
                                    {...(selectedPairKey ? { pairKey: selectedPairKey } : {})}
                                    pollInterval={20_000}
                                    enabled={diagnosticsVisible}
                                />
                            </div>
                            <div className="min-h-[260px]">
                                <AttributionCompletenessPanel
                                    {...(selectedPairKey ? { pairKey: selectedPairKey } : {})}
                                    pollInterval={30_000}
                                    enabled={diagnosticsVisible}
                                />
                            </div>
                        </div>
                    </section>

                    <section className="space-y-3">
                        <ExecutionQualityPanel
                            {...(selectedPairKey ? { pairKey: selectedPairKey } : {})}
                            strategy={bot.strategy}
                            pollInterval={15_000}
                            enabled={diagnosticsVisible}
                        />
                        <EdgeAttributionPanel
                            {...(selectedPairKey ? { pairKey: selectedPairKey } : {})}
                            strategy={bot.strategy}
                            pollInterval={20_000}
                            enabled={diagnosticsVisible}
                        />
                    </section>
                </>
            )}

            {activeDiagnosticsTab === 'risk' && (
                <section className="space-y-3">
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="min-h-[260px]">
                            <RiskStressPanel
                                data={riskStress.data}
                                spread={spreadModel.data}
                                loading={riskStress.loading}
                                error={riskStress.error}
                            />
                        </div>
                        <div className="h-[260px] min-h-[260px] overflow-hidden">
                            {marketQualityCard}
                        </div>
                        <div className="h-[260px] min-h-[260px]">
                            <VolatilityStopPanel pollInterval={10_000} enabled={diagnosticsVisible} />
                        </div>
                    </div>
                </section>
            )}

            {activeDiagnosticsTab === 'policy' && (
                <section className="space-y-3">
                    {/* Policy context banner */}
                    <div className="flex flex-wrap items-center gap-2 text-[10px] px-1">
                        <span className={clsx(
                            'px-1.5 py-0.5 rounded font-medium',
                            bot.network === 'MAINNET' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'
                        )}>
                            {bot.network}
                        </span>
                        <span className={clsx(
                            'px-1.5 py-0.5 rounded font-medium',
                            bot.paper ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'
                        )}>
                            {bot.paper ? 'PAPER' : 'LIVE'}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-white/5 text-slate-300 font-mono">
                            {selectedPairKey ?? `${bot.baseCurrency}/${bot.quoteCurrency || '?'}`}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-white/5 text-slate-400">
                            {bot.strategy}
                        </span>
                        {liveRegime && (
                            <span className={clsx(
                                'px-1.5 py-0.5 rounded font-medium',
                                liveRegime === 'chaotic' || liveRegime === 'illiquid' ? 'bg-red-500/20 text-red-400'
                                    : liveRegime === 'trendingUp' || liveRegime === 'trendingDown' ? 'bg-blue-500/20 text-blue-400'
                                        : 'bg-white/5 text-slate-300'
                            )}>
                                regime: {liveRegime}
                            </span>
                        )}
                    </div>
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.75fr)_minmax(0,0.75fr)]">
                        <div className="min-h-[360px]">
                            <RegimeHeatmapPanel enabled={diagnosticsVisible} />
                        </div>
                        <div className="h-[360px] min-h-[360px]">
                            <AdaptivePanel
                                {...(selectedPairKey ? { pairKey: selectedPairKey } : {})}
                                strategy={bot.strategy}
                                regime={liveRegime ?? 'normal'}
                                pollInterval={15_000}
                                enabled={diagnosticsVisible}
                            />
                        </div>
                        <div className="h-[360px] min-h-[360px]">
                            <GovernancePanel compact enabled={diagnosticsVisible} />
                        </div>
                    </div>
                </section>
            )}

            {activeDiagnosticsTab === 'latency' && (
                <section className="space-y-3">
                    <div className="card min-h-[320px] overflow-hidden p-4">
                        <h3 className="mb-3 text-base font-semibold text-slate-100">Latency Impact</h3>
                        <div className="h-[calc(100%-2rem)] min-h-0 overflow-y-auto pr-1">
                            <LatencyImpactPanel
                                {...(selectedPairKey ? { pairKey: selectedPairKey } : {})}
                                pollInterval={15_000}
                                enabled={diagnosticsVisible}
                            />
                        </div>
                    </div>
                </section>
            )}

            {activeDiagnosticsTab === 'trades' && (
                <section className="space-y-3">
                    <div className="min-h-[360px]">
                        <TradeHistoryDiagnosticsPanel
                            pollInterval={10_000}
                            enabled={diagnosticsVisible && activeDiagnosticsTab === 'trades'}
                            refreshSeq={tradeRefreshSeq}
                        />
                    </div>
                </section>
            )}
        </div>
    );

    const drawerPanel = (
        <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-card">
            <div className="flex items-center gap-1 border-b border-white/10 p-2" role="tablist" aria-label="Activity drawer tabs">
                {drawerTabs.map((tab, index) => {
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.id}
                            role="tab"
                            aria-selected={drawerTab === tab.id}
                            aria-controls={`drawer-panel-${tab.id}`}
                            onClick={() => setDrawerTab(tab.id)}
                            onKeyDown={(event) => onDrawerTabKeyDown(event, index)}
                            className={clsx(
                                'flex items-center gap-1 rounded px-2 py-1 text-xs',
                                drawerTab === tab.id ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-200',
                            )}
                        >
                            <Icon size={12} /> {tab.label}
                        </button>
                    );
                })}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-2 pt-2 pb-0">
                {drawerTab === 'logs' && (
                    <div
                        id="drawer-panel-logs"
                        role="tabpanel"
                        className="h-full min-h-0 overflow-hidden"
                    >
                        <LogsPanel maxRows={120} pollInterval={2000} hiddenPollInterval={10000} active={drawerOpen && drawerTab === 'logs'} />
                    </div>
                )}
            </div>
        </aside>
    );

    const mainContent = (
        <div className="space-y-4">
            {/* Z1 STATUS STRIP */}
            <section className="card p-3">
                {(() => {
                    const sessionChip = statusChips.find(c => c.key === 'session');
                    const regularChips = statusChips.filter(c => c.key !== 'session');
                    const half = Math.ceil(regularChips.length / 2);
                    const topRow = regularChips.slice(0, half);
                    const bottomRow = regularChips.slice(half);
                    return (
                        <div className="flex items-stretch gap-2">
                            {/* Price chip spans both rows */}
                            <div
                                className={clsx(
                                    'flex flex-col items-center justify-center w-[14rem] rounded-md border shrink-0 font-mono overflow-hidden px-2',
                                    activePairPriceTrend === 'up' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
                                    activePairPriceTrend === 'down' && 'border-red-500/25 bg-red-500/10 text-red-300',
                                    activePairPriceTrend === 'neutral' && 'border-white/10 bg-white/5 text-slate-200',
                                )}
                                title="Live active-pair mid price"
                            >
                                <span className="text-[9px] uppercase tracking-wider opacity-70 leading-none">Price</span>
                                <span className="font-semibold whitespace-nowrap leading-snug text-base">{activePairPriceDisplay}</span>
                            </div>
                            {/* Two chip rows */}
                            <div className="flex flex-col justify-center gap-1.5 flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                    {topRow.map((chip) => (
                                        <StatusChip key={chip.key} label={chip.label} value={chip.value} tone={chip.tone} wide={chip.key === 'pair-balance'} />
                                    ))}
                                    {stripWarnings.length > 0 && (
                                        <details className="text-[11px] text-amber-300 shrink-0 relative">
                                            <summary className="cursor-pointer">⚠ {stripWarnings.length}</summary>
                                            <div className="absolute mt-1 text-[10px] text-slate-300 bg-slate-900 border border-white/10 rounded p-2 z-50 max-w-xs">{stripWarnings.join(', ')}</div>
                                        </details>
                                    )}
                                </div>
                                {bottomRow.length > 0 && (
                                    <div className="flex items-center gap-1.5">
                                        {bottomRow.map((chip) => (
                                            <StatusChip key={chip.key} label={chip.label} value={chip.value} tone={chip.tone} wide={chip.key === 'pair-balance'} />
                                        ))}
                                    </div>
                                )}
                            </div>
                            {/* Session P&L chip spans both rows (right end) */}
                            {sessionChip && (
                                <div
                                    className={clsx(
                                        'flex flex-col items-center justify-center w-[14rem] rounded-md border shrink-0 font-mono overflow-hidden px-2',
                                        sessionChip.tone === 'ok' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
                                        sessionChip.tone === 'bad' && 'border-red-500/25 bg-red-500/10 text-red-300',
                                    )}
                                    title="Session P&L"
                                >
                                    <span className="text-[9px] uppercase tracking-wider opacity-70 leading-none">Session</span>
                                    <span className="font-semibold whitespace-nowrap leading-snug text-base">{sessionChip.value}</span>
                                </div>
                            )}
                        </div>
                    );
                })()}
            </section>

            {/* Z2 + Z3 WITH DESKTOP ACTIVITY COLUMN */}
            {!isCompact && !isNarrow ? (
                <section
                    className={clsx(
                        'grid gap-3 items-stretch',
                        drawerOpen ? 'grid-cols-[minmax(0,1fr)_610px]' : 'grid-cols-[minmax(0,1fr)_56px]'
                    )}
                >
                    <div className="grid h-[716px] min-h-[716px] min-w-0 grid-rows-2 gap-4">
                        {/* Z2 PRIMARY DECISION PANEL (top half) */}
                        <section className="card min-h-0 p-4">
                            <div className="mb-3 flex items-center justify-between">
                                <h2 className="text-lg font-semibold text-slate-100">Flow Sentiment</h2>
                                <span className="text-xs text-slate-400">Primary Decision Panel</span>
                            </div>
                            <div className="h-[calc(100%-2rem)] min-h-0">
                                <FlowMetricsPanel pollInterval={2000} />
                            </div>
                        </section>

                        {/* Order book directly below flow in full layout */}
                        <section className="card min-h-0 overflow-hidden">
                            <div className="h-full min-h-0">
                                <OrderBookPanel
                                    bids={orderBookBids}
                                    asks={orderBookAsks}
                                    midPrice={midPrice}
                                    spreadBps={orderBookData.spreadBps ?? bot.spreadBps}
                                    loading={orderBookLoading}
                                    error={orderBookError}
                                    lastUpdated={orderBookData.lastUpdated}
                                    maxRows={7}
                                />
                            </div>
                        </section>
                    </div>

                    <div className="relative h-[716px] min-h-[716px] max-h-[716px] min-w-0 overflow-hidden">
                        {drawerOpen ? (
                            <div className="h-full min-h-0 overflow-hidden">{drawerPanel}</div>
                        ) : (
                            <div className="flex h-full min-h-0 flex-col items-center gap-2 overflow-hidden rounded-md border border-white/10 bg-card/80 py-3">
                                <button
                                    onClick={() => setDrawerOpen(true)}
                                    className="rounded-md p-2 text-slate-300 hover:bg-white/10"
                                    aria-label="Open activity drawer"
                                >
                                    <ChevronLeft size={16} />
                                </button>
                                <button onClick={() => { setDrawerOpen(true); setDrawerTab('logs'); }} className="p-2 text-slate-400 hover:text-slate-200" aria-label="Open logs">
                                    <Logs size={14} />
                                </button>
                                {severity > 0 && (
                                    <span className="mt-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">{severity}</span>
                                )}
                            </div>
                        )}
                        {drawerOpen && (
                            <button
                                onClick={() => setDrawerOpen(false)}
                                className="absolute left-2 top-2 rounded bg-white/10 p-1 text-slate-200 hover:bg-white/20"
                                aria-label="Collapse activity drawer"
                            >
                                <ChevronRight size={14} />
                            </button>
                        )}
                    </div>
                </section>
            ) : (
                <>
                    {/* Z2 PRIMARY DECISION PANEL */}
                    <section className="card p-4 min-h-[210px]">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="text-lg font-semibold text-slate-100">Flow Sentiment</h2>
                            <span className="text-xs text-slate-400">Primary Decision Panel</span>
                        </div>
                        <div className="h-[calc(100%-2rem)] min-h-0">
                            <FlowMetricsPanel pollInterval={2000} />
                        </div>
                    </section>

                    <section className="card min-h-[320px] overflow-hidden">
                        <div className="h-full min-h-0">
                            <OrderBookPanel
                                bids={orderBookBids}
                                asks={orderBookAsks}
                                midPrice={midPrice}
                                spreadBps={orderBookData.spreadBps ?? bot.spreadBps}
                                loading={orderBookLoading}
                                error={orderBookError}
                                lastUpdated={orderBookData.lastUpdated}
                                maxRows={7}
                            />
                        </div>
                    </section>

                </>
            )}

            {/* Z4 TOOL TABS (FULL WIDTH) */}
            <section className="card p-4 min-w-0">
                <div className="mb-3 flex items-center gap-2 border-b border-white/10 pb-2" role="tablist" aria-label="Tool tabs">
                    {toolTabs.map((tab, index) => (
                        <button
                            key={tab.id}
                            role="tab"
                            aria-selected={activeToolTab === tab.id}
                            aria-controls={`tool-panel-${tab.id}`}
                            onClick={() => setActiveToolTab(tab.id)}
                            onKeyDown={(event) => onToolTabKeyDown(event, index)}
                            className={clsx(
                                'rounded-md border px-3 py-1.5 text-sm',
                                activeToolTab === tab.id
                                    ? 'border-sky-500/30 bg-sky-500/20 text-sky-300'
                                    : 'border-white/10 text-slate-400 hover:text-slate-200',
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="min-h-[340px]">
                    {activeToolTab === 'tape' && (
                        <div id="tool-panel-tape" role="tabpanel">
                            <TradeTapePanel pairKey={selectedPairKey || undefined} maxRows={120} />
                        </div>
                    )}

                    {activeToolTab === 'radar' && (
                        <div id="tool-panel-radar" role="tabpanel">
                            <ScannerPanel />
                        </div>
                    )}

                    {activeToolTab === 'diagnostics' && (
                        <div id="tool-panel-diagnostics" role="tabpanel">
                            {diagnosticsPanel}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );

    return (
        <AppShell header={headerComponent} tradeToastsEnabled={tradeToastsEnabled} runtimeEvents={runtimeEvents.data}>
            {!isCompact && !isNarrow ? (
                <div>{mainContent}</div>
            ) : isCompact ? (
                <div className="space-y-4">{mainContent}</div>
            ) : (
                <div className="space-y-4">
                    <div className="flex justify-end">
                        <button
                            onClick={() => setDrawerOpen(true)}
                            className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10"
                        >
                            <ListOrdered size={12} /> Activity {severity > 0 ? `(${severity})` : ''}
                        </button>
                    </div>
                    {mainContent}
                    {drawerOpen && (
                        <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setDrawerOpen(false)}>
                            <div className="absolute bottom-0 right-0 h-[70vh] w-full max-w-[100vw] sm:top-0 sm:h-full sm:w-[610px] sm:max-w-[92vw]" onClick={(event) => event.stopPropagation()}>
                                {drawerPanel}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </AppShell>
    );
}

export default function Page() {
    return (
        <RuntimeCacheProvider pollInterval={4000} enabled>
            <RuntimeEventsProvider pollInterval={1200} enabled>
                <DashboardPageContent />
            </RuntimeEventsProvider>
        </RuntimeCacheProvider>
    );
}

function StatusChip({ label, value, tone, wide = false }: { label: string; value: string; tone: 'ok' | 'bad' | 'warn' | 'neutral'; wide?: boolean }) {
    return (
        <div className={clsx(
            'flex flex-col items-center justify-center h-[2.4rem] rounded-md border text-xs overflow-hidden',
            wide ? 'w-[11.5rem] shrink-0' : 'flex-1 min-w-0',
            tone === 'ok' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
            tone === 'bad' && 'border-red-500/25 bg-red-500/10 text-red-300',
            tone === 'warn' && 'border-amber-500/25 bg-amber-500/10 text-amber-300',
            tone === 'neutral' && 'border-white/10 bg-white/5 text-slate-300',
        )}>
            <span className="text-[9px] uppercase tracking-wider opacity-70 leading-none">{label}</span>
            <span className="font-semibold truncate max-w-full px-1 leading-tight text-[11px]" title={value}>{value}</span>
        </div>
    );
}

function MetricLine({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between border-b border-white/5 pb-1 text-sm">
            <span className="text-slate-500">{label}</span>
            <span className="font-medium text-slate-200" title={value}>{value}</span>
        </div>
    );
}

function fmtNum(value: number | null | undefined, decimals: number): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toFixed(decimals);
}

function fmtSigned(value: number, decimals: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}`;
}

function fmtMs(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60000) return `${Math.round(value / 1000)}s`;
    return `${Math.round(value / 60000)}m`;
}
