import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from project root (handles running from web/ subdirectory)
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config(); // Also try CWD as fallback

type Network = 'mainnet' | 'testnet' | 'devnet' | string;

type EnvBool = 'true' | 'false' | undefined;

type EnvNumber = string | undefined;

export interface TradingPair {
    baseCurrency: string; // e.g., XRP
    baseIssuer?: string; // r-address for issued currency (base)
    quoteCurrency: string; // e.g., USD
    quoteIssuer?: string; // r-address for issued currency (quote)
    issuer?: string; // legacy single-issuer fallback
    description?: string;
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
}

export interface AppConfig {
    xrpl: XRPLConfig;
    tradingPair: TradingPair;
    tradingPairs?: TradingPair[];
    walletSeed?: string;
    walletSecretNumbers?: string;
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
        walletSeed: process.env.XRPL_SEED || process.env.WALLET_SEED,
        walletSecretNumbers: process.env.XRPL_SECRET_NUMBERS,
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
