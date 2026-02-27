import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../index';
import {
    __resetStartupValidationForTests,
    enforceStartupConfigValidation,
    validateStartupConfig,
} from '../startupValidation';

function createBaseConfig(): AppConfig {
    return {
        xrpl: {
            endpoint: 'wss://xrplcluster.com',
            network: 'mainnet',
            maxReconnects: 10,
            initialReconnectDelayMs: 1_000,
            maxReconnectDelayMs: 30_000,
            subscribeLedger: true,
            subscribeTransactions: true,
            minLiquidityUsd: 50_000,
            minVolumeUsd: 10_000,
        },
        tradingPair: {
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        },
        tradingPairs: [{
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        }],
        walletSeed: undefined,
        walletSecretNumbers: undefined,
        enableTestnetFaucet: false,
        paperTrading: true,
        risk: {
            maxExposurePerIssuer: 5_000,
            maxTradeSize: 1_000,
            maxDailyLoss: 500,
            consecutiveFailureKillSwitch: 5,
            issuerBlacklist: new Set<string>(),
            emergencyShutdown: false,
            reserveFloorXRP: 25,
        },
        strategy: {
            minSpreadBps: 10,
            maxSpreadBps: 12,
            maxExitSpreadBps: 15,
            positionSize: 5,
            stopLossBps: 50,
            cooldownMs: 60_000,
            ammArbMinProfitBps: 15,
            pathArbMinProfitBps: 20,
            maxSlippageBps: 50,
            orderBookStaleMs: 5_000,
            entryCrossBps: 12,
            exitCrossBps: 12,
            volatilityStop: {
                enabled: false,
                warmupMs: 60_000,
                minSamples: 50,
                alpha: 0.2,
                multiplier: 2.0,
                minBps: 50,
                maxBps: 250,
                useForEnhanced: true,
            },
        },
        flow: {
            flowWindowMs: 60_000,
            aggressionWindowMs: 10_000,
            depthLevels: 10,
            trendingThreshold: 0.3,
            chaoticSpreadBps: 200,
            minTradesForLiquidity: 3,
            minDepthForLiquidity: 100,
            quietThreshold: 0.1,
            enableRegimeFilter: true,
            enableAdverseSelectionProtection: true,
            maxQuoteSkewBps: 10,
        },
        backgroundScanner: {
            enabled: true,
            maxMarkets: 30,
            maxRps: 2,
            tier1IntervalMs: 3_000,
            tier2IntervalMs: 15_000,
            maxStalenessMs: 20_000,
        },
        analytics: {
            logLevel: 'info',
            csvExportPath: 'pnl.csv',
        },
        features: {
            xrplDiscoveryEnabled: false,
            tradeToastsEnabled: false,
        },
        historyMode: 'none',
    };
}

describe('startupValidation', () => {
    beforeEach(() => {
        __resetStartupValidationForTests();
    });

    it('flags non-XRP pairs without issuer as config errors', () => {
        const cfg = createBaseConfig();
        cfg.tradingPair.quoteCurrency = 'RLUSD';
        cfg.tradingPair.quoteIssuer = undefined;
        cfg.tradingPairs[0]!.quoteCurrency = 'RLUSD';
        cfg.tradingPairs[0]!.quoteIssuer = undefined;

        const report = validateStartupConfig({ SINGLE_PROCESS_MODE: 'true' }, cfg);
        expect(report.ok).toBe(false);
        expect(report.issues.some((issue) => issue.code === 'QUOTE_ISSUER_REQUIRED')).toBe(true);
    });

    it('throws in development when strict config is enabled and errors exist', () => {
        const cfg = createBaseConfig();
        cfg.paperTrading = false;
        cfg.walletSeed = undefined;
        cfg.walletSecretNumbers = undefined;

        const env: NodeJS.ProcessEnv = {
            NODE_ENV: 'development',
            FEATURE_STRICT_CONFIG: '1',
            PAPER_TRADING: 'false',
            SINGLE_PROCESS_MODE: 'true',
        };

        expect(() => {
            enforceStartupConfigValidation(env, cfg, {
                info: vi.fn(),
                warn: vi.fn(),
            });
        }).toThrow(/Strict config validation failed/);
    });

    it('warns but does not throw in production with strict config enabled', () => {
        const cfg = createBaseConfig();
        cfg.paperTrading = false;

        const env: NodeJS.ProcessEnv = {
            NODE_ENV: 'production',
            FEATURE_STRICT_CONFIG: 'true',
            PAPER_TRADING: 'false',
            SINGLE_PROCESS_MODE: 'true',
        };

        const info = vi.fn();
        const warn = vi.fn();
        const report = enforceStartupConfigValidation(env, cfg, { info, warn });

        expect(report.strictEnabled).toBe(true);
        expect(report.failFast).toBe(false);
        expect(report.ok).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('logs only once for identical issue signatures (idempotent reporting)', () => {
        const cfg = createBaseConfig();
        const env: NodeJS.ProcessEnv = {
            NODE_ENV: 'development',
            FEATURE_STRICT_CONFIG: '0',
            SINGLE_PROCESS_MODE: 'false',
        };

        const info = vi.fn();
        const warn = vi.fn();
        enforceStartupConfigValidation(env, cfg, { info, warn });
        enforceStartupConfigValidation(env, cfg, { info, warn });

        expect(info).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
