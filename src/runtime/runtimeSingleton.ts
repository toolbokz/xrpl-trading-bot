/**
 * Runtime Singleton Module
 * 
 * Provides a single TradingRuntime instance for single-process mode.
 * When SINGLE_PROCESS_MODE=true, Next.js API routes use this singleton
 * instead of creating their own XRPL connections.
 * 
 * This eliminates dual-process rate-limit amplification (429s) and
 * allows TradeTape/OrderBook/FlowMetrics to be shared with the dashboard.
 */

import { TradingRuntime } from './tradingRuntime';
import { loadConfig, TradingPair } from '../config';
import { logger } from '../analytics/logger';
import { OrderBookState } from '../utils/types';
import { FlowMetrics } from '../market/flowMetrics';
import { Trade } from '../market/tradeTape';
import { CapitalProtectionDecision, CapitalProtectionConfig } from '../risk/capitalProtection';
import { RegimePolicy } from '../analytics/regimePolicy';
import { getConnectionState, ConnectionState } from '../xrpl/sharedClient';

// =============================================================================
// Types
// =============================================================================

/**
 * Level in the order book (simplified for API consumption).
 */
export interface OrderBookLevel {
    price: number;
    quantity: number;
}

/**
 * Public state snapshot - safe to expose to API routes.
 * Does NOT contain secrets or internal implementation details.
 */
export interface RuntimePublicState {
    /** Whether the runtime is started and connected */
    connected: boolean;
    /** Current XRPL endpoint */
    endpoint: string | null;
    /** Current trading pair key (e.g., "XRP/RLUSD") */
    pair: string | null;
    /** Timestamp of last state update */
    lastUpdatedMs: number;
    /** Whether runtime is currently starting up */
    warmingUp: boolean;

    /** Connection state from sharedClient */
    connection: ConnectionState | null;

    /** Order book state */
    orderBook: {
        bids: OrderBookLevel[];
        asks: OrderBookLevel[];
        spreadBps: number;
        mid: number;
        lastUpdated: number;
    } | null;

    /** Flow metrics */
    flow: FlowMetrics | null;

    /** Trade tape summary */
    tape: {
        trades: Trade[];
        tradeCount: number;
        lastTradeAt: number | null;
    } | null;

    /** Wallet info (address only, no secrets) */
    wallet: {
        address: string;
    } | null;

    /** Risk engine status */
    risk: {
        maxExposure: number;
        currentExposure: number;
        dailyLossLimit: number;
        dailyLossCurrent: number;
        killSwitch: boolean;
        consecutiveFailures: number;
        maxTradeSize: number;
        reserveFloorXRP: number;
    } | null;

    /** Governance/Capital protection status */
    governance: {
        decision: CapitalProtectionDecision | null;
        config: CapitalProtectionConfig | null;
    } | null;

    /** Regime policy */
    regimePolicy: RegimePolicy | null;

    /** Trading pair config */
    tradingPairConfig: TradingPair | null;

    /** Network info */
    network: 'mainnet' | 'testnet';
}

// =============================================================================
// Singleton State (uses globalThis to survive Next.js module reloads)
// =============================================================================

// Type declaration for our globals
declare global {
    // eslint-disable-next-line no-var
    var __xrplTradingBotRuntime: TradingRuntime | null | undefined;
    // eslint-disable-next-line no-var
    var __xrplTradingBotStartPromise: Promise<void> | null | undefined;
    // eslint-disable-next-line no-var
    var __xrplTradingBotIsStarting: boolean | undefined;
}

// Initialize globalThis properties if they don't exist
if (typeof globalThis.__xrplTradingBotRuntime === 'undefined') {
    globalThis.__xrplTradingBotRuntime = null;
}
if (typeof globalThis.__xrplTradingBotStartPromise === 'undefined') {
    globalThis.__xrplTradingBotStartPromise = null;
}
if (typeof globalThis.__xrplTradingBotIsStarting === 'undefined') {
    globalThis.__xrplTradingBotIsStarting = false;
}

/**
 * Check if single-process mode is enabled.
 */
export function isSingleProcessMode(): boolean {
    return process.env.SINGLE_PROCESS_MODE === 'true';
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the runtime instance (may be null if not started).
 */
export function getRuntime(): TradingRuntime | null {
    return globalThis.__xrplTradingBotRuntime ?? null;
}

/**
 * Ensure the runtime is started.
 * Idempotent: multiple concurrent calls will share the same start promise.
 * 
 * @throws Error if runtime fails to start
 */
export async function ensureRuntimeStarted(): Promise<TradingRuntime> {
    // Already running
    if (globalThis.__xrplTradingBotRuntime?.isStarted()) {
        return globalThis.__xrplTradingBotRuntime;
    }

    // Wait for in-flight start
    if (globalThis.__xrplTradingBotStartPromise) {
        await globalThis.__xrplTradingBotStartPromise;
        if (!globalThis.__xrplTradingBotRuntime) {
            throw new Error('Runtime failed to start');
        }
        return globalThis.__xrplTradingBotRuntime;
    }

    // Start new runtime
    globalThis.__xrplTradingBotIsStarting = true;
    globalThis.__xrplTradingBotStartPromise = (async () => {
        try {
            logger.info('[RuntimeSingleton] Starting TradingRuntime in single-process mode...');

            const config = loadConfig();
            globalThis.__xrplTradingBotRuntime = new TradingRuntime(config);
            await globalThis.__xrplTradingBotRuntime.start();

            logger.info('[RuntimeSingleton] TradingRuntime started successfully');
        } catch (err) {
            logger.error({ err }, '[RuntimeSingleton] Failed to start TradingRuntime');
            globalThis.__xrplTradingBotRuntime = null;
            throw err;
        } finally {
            globalThis.__xrplTradingBotIsStarting = false;
            globalThis.__xrplTradingBotStartPromise = null;
        }
    })();

    await globalThis.__xrplTradingBotStartPromise;
    if (!globalThis.__xrplTradingBotRuntime) {
        throw new Error('Runtime failed to start');
    }
    return globalThis.__xrplTradingBotRuntime;
}

/**
 * Stop the runtime singleton.
 */
export async function stopRuntime(): Promise<void> {
    const runtime = globalThis.__xrplTradingBotRuntime;
    if (!runtime) {
        return;
    }

    logger.info('[RuntimeSingleton] Stopping TradingRuntime...');

    try {
        await runtime.shutdown();
    } catch (err) {
        logger.error({ err }, '[RuntimeSingleton] Error during shutdown');
    }

    globalThis.__xrplTradingBotRuntime = null;
    globalThis.__xrplTradingBotStartPromise = null;
    globalThis.__xrplTradingBotIsStarting = false;

    logger.info('[RuntimeSingleton] TradingRuntime stopped');
}

/**
 * Get a public state snapshot from the runtime.
 * Safe to return to API routes - contains no secrets.
 */
export function getRuntimeState(): RuntimePublicState {
    const config = loadConfig();
    const runtimeInstance = globalThis.__xrplTradingBotRuntime;
    const isStarting = globalThis.__xrplTradingBotIsStarting ?? false;

    const baseState: RuntimePublicState = {
        connected: false,
        endpoint: null,
        pair: null,
        lastUpdatedMs: Date.now(),
        warmingUp: isStarting,
        connection: null,
        orderBook: null,
        flow: null,
        tape: null,
        wallet: null,
        risk: null,
        governance: null,
        regimePolicy: null,
        tradingPairConfig: null,
        network: config.xrpl.network as 'mainnet' | 'testnet',
    };

    if (!runtimeInstance) {
        return baseState;
    }

    // Get connection state
    const connection = getConnectionState();
    const client = runtimeInstance.getClient();
    const isConnected = client?.isConnected() ?? false;

    // Get order book state from tracker (via runtime getter)
    let orderBookState: OrderBookState | null = null;
    try {
        orderBookState = runtimeInstance.getOrderBookState();
    } catch { /* ignore */ }

    // Get flow metrics
    const flowMetrics = runtimeInstance.getFlowMetrics();

    // Get trade tape
    const tradeTape = runtimeInstance.getTradeTape();
    let tapeData: RuntimePublicState['tape'] = null;
    if (tradeTape) {
        const trades = tradeTape.getAll(); // All trades in buffer for candle generation
        const lastTrade = trades[trades.length - 1];
        tapeData = {
            trades,
            tradeCount: trades.length,
            lastTradeAt: lastTrade?.ts ?? null,
        };
    }

    // Get wallet address
    const walletAddress = runtimeInstance.getWalletAddress();

    // Get risk status
    const riskStatus = runtimeInstance.getRiskStatus();

    // Get governance status
    const governanceStatus = runtimeInstance.getGovernanceStatus();

    // Get regime policy
    const regimePolicy = runtimeInstance.getRegimePolicy();

    // Get trading pair config
    const tradingPairConfig = runtimeInstance.getConfig().tradingPair;
    const pairKey = tradingPairConfig
        ? `${tradingPairConfig.baseCurrency}/${tradingPairConfig.quoteCurrency}`
        : null;

    // Build order book response
    let orderBookData: RuntimePublicState['orderBook'] = null;
    if (orderBookState && orderBookState.bids.length > 0) {
        const bids = orderBookState.bids.map(b => ({ price: b.price, quantity: b.quantity }));
        const asks = orderBookState.asks.map(a => ({ price: a.price, quantity: a.quantity }));
        const bestBid = bids[0]?.price ?? 0;
        const bestAsk = asks[0]?.price ?? 0;
        const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;

        orderBookData = {
            bids,
            asks,
            spreadBps: orderBookState.spread,
            mid,
            lastUpdated: orderBookState.lastUpdated,
        };
    }

    return {
        connected: isConnected,
        endpoint: connection.endpoint,
        pair: pairKey,
        lastUpdatedMs: Date.now(),
        warmingUp: isStarting,
        connection,
        orderBook: orderBookData,
        flow: flowMetrics,
        tape: tapeData,
        wallet: walletAddress ? { address: walletAddress } : null,
        risk: riskStatus,
        governance: governanceStatus,
        regimePolicy,
        tradingPairConfig,
        network: config.xrpl.network as 'mainnet' | 'testnet',
    };
}

/**
 * Check if runtime is ready (started and connected).
 */
export function isRuntimeReady(): boolean {
    const runtimeInstance = globalThis.__xrplTradingBotRuntime;
    if (!runtimeInstance) return false;
    if (!runtimeInstance.isStarted()) return false;
    const client = runtimeInstance.getClient();
    return client?.isConnected() ?? false;
}

/**
 * Check if runtime is warming up (starting but not ready).
 */
export function isRuntimeWarmingUp(): boolean {
    return globalThis.__xrplTradingBotIsStarting ?? false;
}

// =============================================================================
// Testing Utilities
// =============================================================================

/**
 * Reset singleton state (for testing only).
 */
export function __resetForTesting(): void {
    globalThis.__xrplTradingBotRuntime = null;
    globalThis.__xrplTradingBotStartPromise = null;
    globalThis.__xrplTradingBotIsStarting = false;
}
