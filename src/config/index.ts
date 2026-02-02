import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from project root (handles running from web/ subdirectory)
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

export interface StrategyConfig {
    minSpreadBps: number;
    positionSize: number;
    stopLossBps: number;
    cooldownMs: number;
    ammArbMinProfitBps: number;
    pathArbMinProfitBps: number;
    maxSlippageBps: number;
    /** Order book staleness threshold in milliseconds (default: 5000) */
    orderBookStaleMs: number;
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
    analytics: {
        logLevel: 'info' | 'debug' | 'warn' | 'error';
        csvExportPath: string;
    };
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
    const isTestnet = network.toLowerCase() === 'testnet';
    const walletSeed = isTestnet
        ? process.env.XRPL_SEED_TESTNET || process.env.XRPL_SEED || process.env.WALLET_SEED
        : process.env.XRPL_SEED_MAINNET || process.env.XRPL_SEED || process.env.WALLET_SEED;
    const walletSecretNumbers = isTestnet
        ? process.env.XRPL_SECRET_NUMBERS_TESTNET || process.env.XRPL_SECRET_NUMBERS
        : process.env.XRPL_SECRET_NUMBERS_MAINNET || process.env.XRPL_SECRET_NUMBERS;

    const baseCurrency = process.env.TRADE_BASE_CURRENCY || 'XRP';
    const quoteCurrency = process.env.TRADE_QUOTE_CURRENCY || 'NZD';
    const legacyIssuer = process.env.TRADE_ISSUER || '';

    // XRP is native and should never have an issuer
    const isBaseXRP = baseCurrency.toUpperCase() === 'XRP';
    const isQuoteXRP = quoteCurrency.toUpperCase() === 'XRP';

    const tradingPair: TradingPair = {
        baseCurrency,
        quoteCurrency,
        baseIssuer: isBaseXRP ? undefined : legacyIssuer,
        quoteIssuer: isQuoteXRP ? undefined : legacyIssuer,
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

    const strategy: StrategyConfig = {
        minSpreadBps: toNumber(process.env.MIN_SPREAD_BPS, 10),
        positionSize: toNumber(process.env.POSITION_SIZE_XRP, 5),
        stopLossBps: toNumber(process.env.STOP_LOSS_BPS, 50),
        cooldownMs: toNumber(process.env.COOLDOWN_MS, 60_000),
        ammArbMinProfitBps: toNumber(process.env.AMM_ARB_MIN_PROFIT_BPS, 15),
        pathArbMinProfitBps: toNumber(process.env.PATH_ARB_MIN_PROFIT_BPS, 20),
        maxSlippageBps: toNumber(process.env.MAX_SLIPPAGE_BPS, 50),
        orderBookStaleMs: toNumber(process.env.ORDERBOOK_STALE_MS, 5_000), // Default 5 seconds
    };

    const xrpl: XRPLConfig = {
        endpoint,
        network,
        maxReconnects: toNumber(process.env.XRPL_MAX_RECONNECTS, 10),
        initialReconnectDelayMs: toNumber(process.env.XRPL_RECONNECT_DELAY_MS, 1_000),
        maxReconnectDelayMs: toNumber(process.env.XRPL_RECONNECT_MAX_DELAY_MS, 30_000),
        subscribeLedger: true,
        subscribeTransactions: true,
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
        analytics: {
            logLevel: (process.env.LOG_LEVEL as AppConfig['analytics']['logLevel']) || 'info',
            csvExportPath: process.env.CSV_EXPORT_PATH || 'pnl.csv',
        },
    };
};
