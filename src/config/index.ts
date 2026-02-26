import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from project root
// On Vercel, environment variables are already set via the dashboard
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(process.cwd(), '.env') }); // Also try CWD as fallback

type Network = 'mainnet' | 'testnet' | 'devnet' | string;

type EnvBool = 'true' | 'false' | undefined;

type EnvNumber = string | undefined;

export interface TradingPair {
    baseCurrency: string; // e.g., XRP
    baseIssuer?: string | undefined; // r-address for issued currency (base)
    quoteCurrency: string; // e.g., USD
    quoteIssuer?: string | undefined; // r-address for issued currency (quote)
    issuer?: string | undefined; // legacy single-issuer fallback
    description?: string | undefined;
}

export interface XRPLConfig {
    endpoint: string;
    network: Network;
    maxReconnects: number;
    initialReconnectDelayMs: number;
    maxReconnectDelayMs: number;
    subscribeLedger: boolean;
    subscribeTransactions: boolean;
    /** Discovery filter: minimum USD liquidity for pool inclusion. */
    minLiquidityUsd?: number | undefined;
    /** Discovery filter: minimum USD 24h volume for pool inclusion. */
    minVolumeUsd?: number | undefined;
}

export interface RiskConfig {
    maxExposurePerIssuer: number;
    maxTradeSize: number;
    maxDailyLoss: number;
    consecutiveFailureKillSwitch: number;
    issuerBlacklist: Set<string>;
    emergencyShutdown: boolean;
    reserveFloorXRP: number;
}

export interface FlowConfig {
    /** Time window for trade flow analysis in ms (default: 60000) */
    flowWindowMs: number;
    /** Time window for short-term aggression in ms (default: 10000) */
    aggressionWindowMs: number;
    /** Number of order book levels to consider for depth (default: 10) */
    depthLevels: number;
    /** Imbalance threshold to classify as trending (default: 0.3) */
    trendingThreshold: number;
    /** Spread threshold in bps to classify as chaotic (default: 200) */
    chaoticSpreadBps: number;
    /** Minimum trades in window to classify as not-illiquid (default: 3) */
    minTradesForLiquidity: number;
    /** Minimum total depth (bid+ask) in base to classify as not-illiquid (default: 100) */
    minDepthForLiquidity: number;
    /** Combined signal threshold for quiet regime (default: 0.1) */
    quietThreshold: number;
    /** Enable regime-based strategy filtering (default: true) */
    enableRegimeFilter: boolean;
    /** Enable adverse selection protection (default: true) */
    enableAdverseSelectionProtection: boolean;
    /** Maximum quote skew in bps based on imbalance (default: 10) */
    maxQuoteSkewBps: number;

    // ── Mid-price trend detection ────────────────────────────────────────
    /** Enable mid-price trend detection for entry gating (default: true) */
    enableTrendDetection: boolean;
    /** Fast EMA half-life in ms for trend tracker (default: 60000) */
    trendFastHalfLifeMs: number;
    /** Slow EMA half-life in ms for trend tracker (default: 300000) */
    trendSlowHalfLifeMs: number;
    /** Trend magnitude threshold in bps to classify as trending (default: 5) */
    trendFlatThresholdBps: number;
    /** Minimum samples before trend tracker emits signal (default: 10) */
    trendMinSamples: number;
    /** Max staleness before trend signal is ignored (default: 30000) */
    trendStaleAfterMs: number;
    /** Block long entry when trend is down beyond this bps (default: 8) */
    trendEntryBlockBps: number;
}

export interface StrategyConfig {
    /**
     * Legacy: minimum spread in bps (kept for backward compatibility).
     * NOTE: IOC taker scalper should prefer maxSpreadBps gating instead.
     */
    minSpreadBps: number;

    /**
     * IOC taker scalper gate:
     * - Enter only when spread is <= maxSpreadBps (cheap enough to cross).
     */
    maxSpreadBps: number;

    /**
     * IOC taker scalper exit gate:
     * - Allow profit-taking exits only when spread is <= maxExitSpreadBps.
     * - Stop-loss exits can still proceed in strategy logic.
     */
    maxExitSpreadBps: number;

    positionSize: number;
    stopLossBps: number;
    cooldownMs: number;
    ammArbMinProfitBps: number;
    /** AMM arb: skip when book spread exceeds this (0 = disabled). */
    ammArbMaxSpreadBps: number;
    /** AMM arb: independent position size (0 = use shared positionSize). */
    ammArbPositionSize: number;
    /** AMM arb: independent stop-loss bps (0 = use shared stopLossBps). */
    ammArbStopLossBps: number;
    /** AMM arb: minimum ms between executions (0 = use shared cooldownMs). */
    ammArbCooldownMs: number;
    /** AMM arb: entry cross aggressiveness in bps (0 = use shared entryCrossBps). */
    ammArbEntryCrossBps: number;
    pathArbMinProfitBps: number;
    maxSlippageBps: number;

    /** Order book staleness threshold in milliseconds (default: 5000) */
    orderBookStaleMs: number;

    /**
     * Additional entry aggressiveness in bps (0 = passive reference price).
     * Higher value crosses more toward the opposite side for better fill odds.
     */
    entryCrossBps: number;

    /**
     * Additional exit aggressiveness in bps (0 = passive reference price).
     * Higher value crosses more toward the opposite side for better fill odds.
     */
    exitCrossBps: number;

    /**
     * Optional volatility-adaptive stop-loss configuration for scalper exits.
     * Defaults preserve legacy fixed-stop behavior (`enabled=false`).
     */
    volatilityStop?: VolatilityStopConfig | undefined;

    // ── Flow-Alpha Entry Filter ──────────────────────────────────────────

    /**
     * Enable flow-alpha directional filter for scalper BUY entries.
     * When enabled, the scalper only enters long when order-flow imbalance
     * and depth imbalance confirm buy-side pressure. (default: false)
     */
    flowAlphaEnabled: boolean;

    /**
     * Minimum flow imbalance (buyVol-sellVol)/(buyVol+sellVol) to allow entry.
     * Range [0, 1]. Higher = more selective. (default: 0.15)
     */
    flowAlphaMinImbalance: number;

    /**
     * Minimum combined signal (avg of flow + depth imbalance) to allow entry.
     * Range [0, 1]. Higher = more selective. (default: 0.10)
     */
    flowAlphaMinCombinedSignal: number;

    /**
     * Minimum VWAP deviation (in bps, negative = price below VWAP = oversold)
     * to allow entry. Set to a negative value to require "buy the dip".
     * (default: 0 = disabled)
     */
    flowAlphaMaxVwapDeviationBps: number;

    /**
     * Minimum profit in bps above entry price before a take-profit exit is allowed.
     * Prevents the scalper from exiting at a microscopic "profit" that doesn't
     * cover the cost of the round-trip spread + fees. (default: 2)
     */
    minTakeProfitBps: number;
}

export interface VolatilityStopConfig {
    enabled: boolean;
    warmupMs: number;
    minSamples: number;
    alpha: number;
    multiplier: number;
    minBps: number;
    maxBps: number;
    useForEnhanced: boolean;
}

/**
 * CPU Safety Configuration
 * Environment variables:
 * - BOT_LOOP_MIN_DELAY_MS: Minimum delay between loop iterations (default: 50, min: 25)
 * - STRATEGY_MAX_TPS: Max strategy ticks per second (default: 10)
 * - CPU_MAX_PERCENT: Max sustained CPU % before pausing (default: 50)
 * - CPU_MAX_DURATION_MS: Duration before CPU threshold triggers pause (default: 5000)
 * - LOG_MAX_PER_SEC: Max log messages per key per second (default: 10)
 */

export interface AppConfig {
    xrpl: XRPLConfig;
    tradingPair: TradingPair;
    tradingPairs: TradingPair[];
    walletSeed?: string | undefined;
    walletSecretNumbers?: string | undefined;
    enableTestnetFaucet: boolean;
    paperTrading: boolean;
    risk: RiskConfig;
    strategy: StrategyConfig;
    flow: FlowConfig;
    backgroundScanner: {
        enabled: boolean;
        maxMarkets: number;
        maxRps: number;
        tier1IntervalMs: number;
        tier2IntervalMs: number;
        maxStalenessMs: number;
    };
    analytics: {
        logLevel: 'info' | 'debug' | 'warn' | 'error';
        csvExportPath: string;
    };
    features?: {
        xrplDiscoveryEnabled?: boolean | undefined;
        tradeToastsEnabled?: boolean | undefined;
    } | undefined;
    /**
     * Controls how the bot treats historical data on startup.
     * - 'none' (default): start clean, only use data accumulated since boot.
     *   Strategies must warm up from live data before trading.
     * - 'backfill': attempt to backfill historical ledger data on startup.
     */
    historyMode: 'none' | 'backfill';
}

const toBool = (val: EnvBool, fallback: boolean): boolean => {
    if (val === undefined) return fallback;
    return val.toLowerCase() === 'true';
};

const toNumber = (val: EnvNumber, fallback: number): number => {
    if (val === undefined) return fallback;
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, value))
);

const issuerBlacklistFromEnv = (): Set<string> => {
    const raw = process.env.ISSUER_BLACKLIST;
    if (!raw) return new Set();
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
};

export const loadConfig = (): AppConfig => {
    const endpoint = process.env.XRPL_WSS_URL || process.env.XRPL_ENDPOINT || 'wss://s1.ripple.com';
    const network = (process.env.XRPL_NETWORK || 'mainnet') as Network;
    const paperTrading = toBool(process.env.PAPER_TRADING as EnvBool, true);
    const enableTestnetFaucet = toBool(process.env.ENABLE_TESTNET_FAUCET as EnvBool, false);

    // Network-specific wallet credentials
    // Accepts XRPL_SEED or XRPL_SECRET (family seed / secret key) — they are the same format (s...)
    const isTestnet = network.toLowerCase() === 'testnet';
    const walletSeed = isTestnet
        ? process.env.XRPL_SEED_TESTNET || process.env.XRPL_SECRET_TESTNET || process.env.XRPL_SEED || process.env.XRPL_SECRET || process.env.WALLET_SEED
        : process.env.XRPL_SEED_MAINNET || process.env.XRPL_SECRET_MAINNET || process.env.XRPL_SEED || process.env.XRPL_SECRET || process.env.WALLET_SEED;
    const walletSecretNumbers = isTestnet
        ? process.env.XRPL_SECRET_NUMBERS_TESTNET || process.env.XRPL_SECRET_NUMBERS
        : process.env.XRPL_SECRET_NUMBERS_MAINNET || process.env.XRPL_SECRET_NUMBERS;

    const baseCurrency = process.env.TRADE_BASE_CURRENCY || 'XRP';
    const quoteCurrency = process.env.TRADE_QUOTE_CURRENCY || 'NZD';
    const legacyIssuer = process.env.TRADE_ISSUER || '';

    // Per-asset issuers: TRADE_BASE_ISSUER / TRADE_QUOTE_ISSUER take precedence
    // over the legacy single TRADE_ISSUER value.
    const rawBaseIssuer = process.env.TRADE_BASE_ISSUER || legacyIssuer;
    const rawQuoteIssuer = process.env.TRADE_QUOTE_ISSUER || legacyIssuer;

    // XRP is native and should never have an issuer
    const isBaseXRP = baseCurrency.toUpperCase() === 'XRP';
    const isQuoteXRP = quoteCurrency.toUpperCase() === 'XRP';

    const tradingPair: TradingPair = {
        baseCurrency,
        quoteCurrency,
        baseIssuer: isBaseXRP ? undefined : rawBaseIssuer,
        quoteIssuer: isQuoteXRP ? undefined : rawQuoteIssuer,
        issuer: legacyIssuer, // Keep for backward compatibility
    };

    const risk: RiskConfig = {
        maxExposurePerIssuer: toNumber(process.env.MAX_EXPOSURE_PER_ISSUER, 5_000),
        maxTradeSize: toNumber(process.env.MAX_TRADE_SIZE, 1_000),
        maxDailyLoss: toNumber(process.env.MAX_DAILY_LOSS_XRP, 500),
        consecutiveFailureKillSwitch: toNumber(process.env.CONSECUTIVE_FAILURE_KILL_SWITCH, 5),
        issuerBlacklist: issuerBlacklistFromEnv(),
        emergencyShutdown: false,
        reserveFloorXRP: toNumber(process.env.RESERVE_FLOOR_XRP, 25),
    };

    // ── One-knob sizing: BASE_ORDER_SIZE_XRP takes precedence over POSITION_SIZE_XRP ──
    const baseOrderSizeXrp = (() => {
        const raw = process.env.BASE_ORDER_SIZE_XRP;
        if (raw !== undefined) return toNumber(raw, 5);
        return toNumber(process.env.POSITION_SIZE_XRP, 5);
    })();

    const strategy: StrategyConfig = {
        // Legacy (kept so other components/tests don't break immediately)
        minSpreadBps: toNumber(process.env.MIN_SPREAD_BPS, 10),

        // New: IOC taker scalper prefers max-spread gating
        maxSpreadBps: toNumber(process.env.SCALPER_MAX_SPREAD_BPS, 12),
        maxExitSpreadBps: toNumber(process.env.SCALPER_MAX_EXIT_SPREAD_BPS, 15),

        positionSize: baseOrderSizeXrp,
        stopLossBps: toNumber(process.env.STOP_LOSS_BPS, 50),
        cooldownMs: toNumber(process.env.COOLDOWN_MS, 60_000),
        ammArbMinProfitBps: toNumber(process.env.AMM_ARB_MIN_PROFIT_BPS, 15),
        ammArbMaxSpreadBps: toNumber(process.env.AMM_ARB_MAX_SPREAD_BPS, 0),
        ammArbPositionSize: toNumber(process.env.AMM_ARB_POSITION_SIZE, 0),
        ammArbStopLossBps: toNumber(process.env.AMM_ARB_STOP_LOSS_BPS, 0),
        ammArbCooldownMs: toNumber(process.env.AMM_ARB_COOLDOWN_MS, 0),
        ammArbEntryCrossBps: Math.max(0, toNumber(process.env.AMM_ARB_ENTRY_CROSS_BPS, 0)),
        pathArbMinProfitBps: toNumber(process.env.PATH_ARB_MIN_PROFIT_BPS, 20),
        maxSlippageBps: toNumber(process.env.MAX_SLIPPAGE_BPS, 50),

        orderBookStaleMs: toNumber(process.env.ORDERBOOK_STALE_MS, 5_000), // Default 5 seconds

        // Instant-fill defaults (override via .env)
        entryCrossBps: Math.max(0, toNumber(process.env.SCALPER_ENTRY_CROSS_BPS, 12)),
        exitCrossBps: Math.max(0, toNumber(process.env.SCALPER_EXIT_CROSS_BPS, 12)),

        volatilityStop: {
            enabled: toBool(process.env.VOL_STOP_ENABLED as EnvBool, false),
            warmupMs: Math.max(0, toNumber(process.env.VOL_STOP_WARMUP_MS, 60_000)),
            minSamples: Math.max(1, Math.floor(toNumber(process.env.VOL_STOP_MIN_SAMPLES, 50))),
            alpha: clamp(toNumber(process.env.VOL_STOP_ALPHA, 0.2), 0.001, 1),
            multiplier: Math.max(0, toNumber(process.env.VOL_STOP_MULTIPLIER, 2.0)),
            minBps: Math.max(1, toNumber(process.env.VOL_STOP_MIN_BPS, 50)),
            maxBps: Math.max(1, toNumber(process.env.VOL_STOP_MAX_BPS, 250)),
            useForEnhanced: toBool(process.env.VOL_STOP_USE_FOR_ENHANCED as EnvBool, true),
        },

        // Flow-alpha directional entry filter
        flowAlphaEnabled: toBool(process.env.FLOW_ALPHA_ENABLED as EnvBool, false),
        flowAlphaMinImbalance: clamp(toNumber(process.env.FLOW_ALPHA_MIN_IMBALANCE, 0.15), 0, 1),
        flowAlphaMinCombinedSignal: clamp(toNumber(process.env.FLOW_ALPHA_MIN_COMBINED_SIGNAL, 0.10), 0, 1),
        flowAlphaMaxVwapDeviationBps: toNumber(process.env.FLOW_ALPHA_MAX_VWAP_DEVIATION_BPS, 0),

        // Minimum profit gate for take-profit exits
        minTakeProfitBps: clamp(toNumber(process.env.SCALPER_MIN_TAKE_PROFIT_BPS, 2), 0, 100),
    };

    const flow: FlowConfig = {
        flowWindowMs: toNumber(process.env.FLOW_WINDOW_MS, 60_000),
        aggressionWindowMs: toNumber(process.env.FLOW_AGGRESSION_WINDOW_MS, 10_000),
        depthLevels: toNumber(process.env.FLOW_DEPTH_LEVELS, 10),
        trendingThreshold: toNumber(process.env.FLOW_TRENDING_THRESHOLD, 0.3),
        chaoticSpreadBps: toNumber(process.env.FLOW_CHAOTIC_SPREAD_BPS, 200),
        minTradesForLiquidity: toNumber(process.env.FLOW_MIN_TRADES_LIQUIDITY, 3),
        minDepthForLiquidity: toNumber(process.env.FLOW_MIN_DEPTH_LIQUIDITY, 100),
        quietThreshold: toNumber(process.env.FLOW_QUIET_THRESHOLD, 0.1),
        enableRegimeFilter: toBool(process.env.FLOW_ENABLE_REGIME_FILTER as EnvBool, true),
        enableAdverseSelectionProtection: toBool(process.env.FLOW_ENABLE_ADVERSE_SELECTION as EnvBool, true),
        maxQuoteSkewBps: toNumber(process.env.FLOW_MAX_QUOTE_SKEW_BPS, 10),
        // Mid-price trend detection
        enableTrendDetection: toBool(process.env.TREND_DETECTION_ENABLED as EnvBool, true),
        trendFastHalfLifeMs: toNumber(process.env.TREND_FAST_HALF_LIFE_MS, 60_000),
        trendSlowHalfLifeMs: toNumber(process.env.TREND_SLOW_HALF_LIFE_MS, 300_000),
        trendFlatThresholdBps: toNumber(process.env.TREND_FLAT_THRESHOLD_BPS, 5),
        trendMinSamples: toNumber(process.env.TREND_MIN_SAMPLES, 10),
        trendStaleAfterMs: toNumber(process.env.TREND_STALE_AFTER_MS, 30_000),
        trendEntryBlockBps: toNumber(process.env.TREND_ENTRY_BLOCK_BPS, 8),
    };

    const xrpl: XRPLConfig = {
        endpoint,
        network,
        maxReconnects: toNumber(process.env.XRPL_MAX_RECONNECTS, 10),
        initialReconnectDelayMs: toNumber(process.env.XRPL_RECONNECT_DELAY_MS, 1_000),
        maxReconnectDelayMs: toNumber(process.env.XRPL_RECONNECT_MAX_DELAY_MS, 30_000),
        subscribeLedger: true,
        subscribeTransactions: true,
        minLiquidityUsd: toNumber(process.env.XRPL_DISCOVERY_MIN_LIQUIDITY_USD, 50_000),
        minVolumeUsd: toNumber(process.env.XRPL_DISCOVERY_MIN_VOLUME_USD, 10_000),
    };

    return {
        xrpl,
        tradingPair,
        tradingPairs: [tradingPair],
        walletSeed,
        walletSecretNumbers,
        enableTestnetFaucet,
        paperTrading,
        risk,
        strategy,
        flow,
        backgroundScanner: {
            enabled: toBool(process.env.SCANNER_ENABLED as EnvBool, true),
            maxMarkets: toNumber(process.env.SCANNER_MAX_MARKETS, 30),
            maxRps: toNumber(process.env.SCANNER_MAX_RPS, 2),
            tier1IntervalMs: toNumber(process.env.SCANNER_TIER1_INTERVAL_MS, 3_000),
            tier2IntervalMs: toNumber(process.env.SCANNER_TIER2_INTERVAL_MS, 15_000),
            maxStalenessMs: toNumber(process.env.SCANNER_MAX_STALENESS_MS, 20_000),
        },
        analytics: {
            logLevel: (process.env.LOG_LEVEL as AppConfig['analytics']['logLevel']) || 'info',
            csvExportPath: process.env.CSV_EXPORT_PATH || 'pnl.csv',
        },
        features: {
            xrplDiscoveryEnabled: toBool(process.env.FEATURE_XRPL_DISCOVERY_ENABLED as EnvBool, false),
            tradeToastsEnabled: toBool(process.env.FEATURE_TRADE_TOASTS_ENABLED as EnvBool, false),
        },
        historyMode: (process.env.HISTORY_MODE === 'backfill' ? 'backfill' : 'none') as 'none' | 'backfill',
    };
};