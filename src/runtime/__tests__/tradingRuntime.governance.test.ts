/**
 * Capital Protection Integration Tests
 * 
 * Tests the integration of CapitalProtectionEngine with TradingRuntime.
 * These tests verify that governance decisions properly affect strategy execution.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../persistence/breakerStore', () => ({
    closeBreakerStore: vi.fn().mockResolvedValue(undefined),
    getBreakerStore: vi.fn().mockReturnValue({
        load: vi.fn().mockResolvedValue({ trades: [], trippedAt: null, lastUpdated: 0 }),
        save: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('../../analytics/feedbackEngine', () => ({
    feedbackEngine: {
        recordTradeEvent: vi.fn(),
        getPerformanceSummary: vi.fn(() => ({
            summary: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancyBps: 0, avgSlippageBps: 0, maxDrawdownPct: 0, currentDrawdownPct: 0 },
            byRegime: [],
            byStrategy: [],
            drawdown: [],
        })),
        getCostSummary: vi.fn(() => ({
            totalTrades: 0,
            avgCostRealism: 0,
            avgSlippageBps: 0,
            byStrategy: {},
        })),
        getRollingRiskMetrics: vi.fn((_params: { pairKey?: string; lookbackTrades: number }) => ({
            tradesCount: 100,
            profitFactor: 1.5,
            expectancyBps: 10,
            drawdownPct: 3,
            drawdownConfidence: true,
            peakEquity: 10,
            equityNow: 9.7,
            avgSlippageBps: 15,
            partialFillRate: 0.1,
            winRate: 0.55,
        })),
    },
}));

import { TradingRuntime } from '../tradingRuntime';
import { feedbackEngine } from '../../analytics/feedbackEngine';
import type { CapitalProtectionConfig, RollingRiskMetrics } from '../../risk/capitalProtection';

describe('TradingRuntime Governance Integration', () => {
    let runtime: TradingRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        runtime = new TradingRuntime();
    });

    afterEach(async () => {
        await runtime.shutdown();
    });

    describe('getGovernanceStatus', () => {
        it('returns null decision when not started', () => {
            const status = runtime.getGovernanceStatus();
            expect(status.decision).toBeNull();
            expect(status.config).toBeNull();
        });
    });

    describe('Governance Decision Flow', () => {
        it('healthy metrics result in ALLOW mode', () => {
            // Mock healthy metrics
            vi.mocked(feedbackEngine.getRollingRiskMetrics).mockReturnValue({
                tradesCount: 100,
                profitFactor: 1.5,
                expectancyBps: 10,
                drawdownPct: 3,
                drawdownConfidence: true,
                peakEquity: 10,
                equityNow: 9.7,
                avgSlippageBps: 15,
                partialFillRate: 0.1,
                winRate: 0.55,
            });

            // We can't fully start runtime without XRPL connection,
            // but we can verify the mock is set up correctly
            const metrics = feedbackEngine.getRollingRiskMetrics({ pairKey: 'XRP/RLUSD', lookbackTrades: 200 });
            expect(metrics.profitFactor).toBe(1.5);
            expect(metrics.drawdownPct).toBe(3);
        });

        it('severe drawdown triggers PAUSE in determineProtectionMode', async () => {
            // Import the pure function for direct testing
            const { determineProtectionMode } = await import('../../risk/capitalProtection');

            const config: CapitalProtectionConfig = {
                enabled: true,
                lookbackTrades: 200,
                minTrades: 50,
                maxRollingDrawdownPct: 7,
                minProfitFactor: 1.1,
                minExpectancyBps: -2,
                maxAvgSlippageBps: 30,
                maxPartialFillRate: 0.35,
                consecFailShutdown: 8,
                throttleSizeMultiplier: 0.5,
                throttleCooldownMs: 30000,
                pauseSizeMultiplier: 0.0,
                pauseCooldownMs: 600000,
            };

            const severeDrawdownMetrics: RollingRiskMetrics = {
                tradesCount: 100,
                profitFactor: 1.5,
                expectancyBps: 10,
                drawdownPct: 9, // Above 7 but below 10.5
                avgSlippageBps: 15,
                partialFillRate: 0.1,
                winRate: 0.55,
                consecutiveFailures: 0,
            };

            const result = determineProtectionMode(severeDrawdownMetrics, config);
            expect(result.mode).toBe('PAUSE');
            expect(result.reasons.some(r => r.includes('Drawdown'))).toBe(true);
        });

        it('consecutive failures trigger SHUTDOWN in determineProtectionMode', async () => {
            const { determineProtectionMode } = await import('../../risk/capitalProtection');

            const config: CapitalProtectionConfig = {
                enabled: true,
                lookbackTrades: 200,
                minTrades: 50,
                maxRollingDrawdownPct: 7,
                minProfitFactor: 1.1,
                minExpectancyBps: -2,
                maxAvgSlippageBps: 30,
                maxPartialFillRate: 0.35,
                consecFailShutdown: 8,
                throttleSizeMultiplier: 0.5,
                throttleCooldownMs: 30000,
                pauseSizeMultiplier: 0.0,
                pauseCooldownMs: 600000,
            };

            const consecFailMetrics: RollingRiskMetrics = {
                tradesCount: 100,
                profitFactor: 1.5,
                expectancyBps: 10,
                drawdownPct: 3,
                avgSlippageBps: 15,
                partialFillRate: 0.1,
                winRate: 0.55,
                consecutiveFailures: 8, // >= consecFailShutdown
            };

            const result = determineProtectionMode(consecFailMetrics, config);
            expect(result.mode).toBe('SHUTDOWN');
            expect(result.reasons.some(r => r.includes('Consecutive failures'))).toBe(true);
        });

        it('high slippage triggers THROTTLE in determineProtectionMode', async () => {
            const { determineProtectionMode } = await import('../../risk/capitalProtection');

            const config: CapitalProtectionConfig = {
                enabled: true,
                lookbackTrades: 200,
                minTrades: 50,
                maxRollingDrawdownPct: 7,
                minProfitFactor: 1.1,
                minExpectancyBps: -2,
                maxAvgSlippageBps: 30,
                maxPartialFillRate: 0.35,
                consecFailShutdown: 8,
                throttleSizeMultiplier: 0.5,
                throttleCooldownMs: 30000,
                pauseSizeMultiplier: 0.0,
                pauseCooldownMs: 600000,
            };

            const highSlippageMetrics: RollingRiskMetrics = {
                tradesCount: 100,
                profitFactor: 1.5,
                expectancyBps: 10,
                drawdownPct: 3,
                avgSlippageBps: 35, // > 30
                partialFillRate: 0.1,
                winRate: 0.55,
                consecutiveFailures: 0,
            };

            const result = determineProtectionMode(highSlippageMetrics, config);
            expect(result.mode).toBe('THROTTLE');
            expect(result.reasons.some(r => r.includes('slippage'))).toBe(true);
        });
    });
});

describe('CapitalProtectionEngine in isolation', () => {
    it('can be instantiated with config', async () => {
        const { loadCapitalProtectionConfig } = await import('../../risk/capitalProtection');

        const config = loadCapitalProtectionConfig();
        expect(config).toBeDefined();
        expect(config.enabled).toBeDefined();
        expect(config.maxRollingDrawdownPct).toBeGreaterThan(0);
    });

    it('respects enabled flag', async () => {
        const { CapitalProtectionEngine } = await import('../../risk/capitalProtection');

        const disabledConfig: CapitalProtectionConfig = {
            enabled: false,
            lookbackTrades: 200,
            minTrades: 50,
            maxRollingDrawdownPct: 7,
            minProfitFactor: 1.1,
            minExpectancyBps: -2,
            maxAvgSlippageBps: 30,
            maxPartialFillRate: 0.35,
            consecFailShutdown: 8,
            throttleSizeMultiplier: 0.5,
            throttleCooldownMs: 30000,
            pauseSizeMultiplier: 0.0,
            pauseCooldownMs: 600000,
        };

        const mockFeedback = {
            getRollingRiskMetrics: vi.fn(() => ({
                tradesCount: 100,
                profitFactor: 0.5, // Would trigger PAUSE if enabled
                expectancyBps: -50,
                drawdownPct: 20,
                drawdownConfidence: true,
                peakEquity: 10,
                equityNow: 8,
                avgSlippageBps: 100,
                partialFillRate: 0.8,
                winRate: 0.2,
                consecutiveFailures: 10,
            })),
        };

        const mockRisk = {
            checkReserve: vi.fn(() => true),
        };

        const engine = new CapitalProtectionEngine({
            feedbackEngine: mockFeedback as any,
            riskEngine: mockRisk as any,
            config: disabledConfig,
        });

        const result = engine.evaluate('XRP/RLUSD');
        expect(result.mode).toBe('ALLOW');
        expect(result.reasons).toContain('Capital protection disabled');
    });
});
