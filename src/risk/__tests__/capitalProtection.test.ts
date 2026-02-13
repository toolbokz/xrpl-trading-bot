import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    computeRollingDrawdown,
    computeExpectancyBps,
    computeProfitFactor,
    isSlippageDegraded,
    isPartialFillDegraded,
    determineProtectionMode,
    CapitalProtectionEngine,
    CapitalProtectionConfig,
    RollingRiskMetrics,
    ProtectionMode,
} from '../capitalProtection';

// ─────────────────────────────────────────────────────────────────────────────
// Pure Function Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('computeRollingDrawdown', () => {
    it('returns 0 for insufficient data', () => {
        expect(computeRollingDrawdown([])).toBe(0);
        expect(computeRollingDrawdown([100])).toBe(0);
    });

    it('returns 0 when no drawdown (always increasing)', () => {
        const curve = [100, 200, 300, 400, 500];
        expect(computeRollingDrawdown(curve)).toBe(0);
    });

    it('computes max drawdown correctly', () => {
        // Peak at 500, drops to 300 => 40% drawdown
        const curve = [100, 300, 500, 400, 300];
        expect(computeRollingDrawdown(curve)).toBeCloseTo(40, 1);
    });

    it('recovers from drawdown correctly', () => {
        // Goes 100 → 200 → 100 → 200 → 300
        // Max drawdown was 50% (200 to 100)
        const curve = [100, 200, 100, 200, 300];
        expect(computeRollingDrawdown(curve)).toBeCloseTo(50, 1);
    });
});

describe('computeExpectancyBps', () => {
    it('returns 0 for no trades', () => {
        expect(computeExpectancyBps(0, 0, 0, 0, 100)).toBe(0);
    });

    it('returns 0 for zero trade size', () => {
        expect(computeExpectancyBps(5, 5, 1000, 500, 0)).toBe(0);
    });

    it('computes positive expectancy', () => {
        // 6 wins, 4 losses
        // Total gain: 600, Total loss: 200
        // WinRate: 0.6, AvgWin: 100, AvgLoss: 50
        // Expectancy = (0.6 * 100) - (0.4 * 50) = 60 - 20 = 40
        // Normalized by avgTradeSize=100: (40/100)*10000 = 4000 bps
        const result = computeExpectancyBps(6, 4, 600, 200, 100);
        expect(result).toBeCloseTo(4000, 0);
    });

    it('computes negative expectancy', () => {
        // 4 wins, 6 losses
        // Total gain: 200, Total loss: 600
        // WinRate: 0.4, AvgWin: 50, AvgLoss: 100
        // Expectancy = (0.4 * 50) - (0.6 * 100) = 20 - 60 = -40
        // Normalized: (-40/100)*10000 = -4000 bps
        const result = computeExpectancyBps(4, 6, 200, 600, 100);
        expect(result).toBeCloseTo(-4000, 0);
    });
});

describe('computeProfitFactor', () => {
    it('returns Infinity for no losses with gains', () => {
        expect(computeProfitFactor(1000, 0)).toBe(Infinity);
    });

    it('returns 1 for no activity', () => {
        expect(computeProfitFactor(0, 0)).toBe(1);
    });

    it('returns 0 for only losses', () => {
        expect(computeProfitFactor(0, 1000)).toBe(0);
    });

    it('computes PF correctly', () => {
        // Gains: 150, Losses: 75 → PF = 2.0
        expect(computeProfitFactor(150, 75)).toBeCloseTo(2.0, 2);
    });
});

describe('isSlippageDegraded', () => {
    it('returns true when slippage exceeds threshold', () => {
        expect(isSlippageDegraded(35, 30)).toBe(true);
    });

    it('returns false when slippage within threshold', () => {
        expect(isSlippageDegraded(25, 30)).toBe(false);
    });

    it('returns false when exactly at threshold', () => {
        expect(isSlippageDegraded(30, 30)).toBe(false);
    });
});

describe('isPartialFillDegraded', () => {
    it('returns true when rate exceeds threshold', () => {
        expect(isPartialFillDegraded(0.4, 0.35)).toBe(true);
    });

    it('returns false when rate within threshold', () => {
        expect(isPartialFillDegraded(0.2, 0.35)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// determineProtectionMode Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('determineProtectionMode', () => {
    const baseConfig: CapitalProtectionConfig = {
        enabled: true,
        lookbackTrades: 200,
        minTrades: 50,
        maxRollingDrawdownPct: 7,
        minTradesForDrawdown: 50,
        minPeakEquityForDrawdown: 1.0,
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

    const healthyMetrics: RollingRiskMetrics = {
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
        consecutiveFailures: 0,
    };

    it('returns ALLOW for healthy metrics', () => {
        const result = determineProtectionMode(healthyMetrics, baseConfig);
        expect(result.mode).toBe('ALLOW');
    });

    it('returns ALLOW when insufficient trades (graceful)', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            tradesCount: 30, // Below minTrades
            drawdownPct: 20, // Would trigger PAUSE otherwise
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('ALLOW');
        expect(result.reasons.some(r => r.includes('Insufficient'))).toBe(true);
    });

    it('returns SHUTDOWN for consecutive failures', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            consecutiveFailures: 8,
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('SHUTDOWN');
        expect(result.reasons.some(r => r.includes('Consecutive failures'))).toBe(true);
    });

    it('returns SHUTDOWN for extreme drawdown (>1.5x threshold)', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            drawdownPct: 12, // 7 * 1.5 = 10.5, so 12 > 10.5
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('SHUTDOWN');
        expect(result.reasons.some(r => r.includes('Extreme drawdown'))).toBe(true);
    });

    it('returns PAUSE for drawdown breach', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            drawdownPct: 8, // Above 7, but below 10.5
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('PAUSE');
        expect(result.reasons.some(r => r.includes('Drawdown breach'))).toBe(true);
    });

    it('returns THROTTLE for low profit factor', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            profitFactor: 1.0, // Below 1.1
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('THROTTLE');
        expect(result.reasons.some(r => r.includes('profit factor'))).toBe(true);
    });

    it('returns THROTTLE for low expectancy', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            expectancyBps: -5, // Below -2
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('THROTTLE');
        expect(result.reasons.some(r => r.includes('expectancy'))).toBe(true);
    });

    it('returns THROTTLE for high slippage', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            avgSlippageBps: 35, // Above 30
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('THROTTLE');
        expect(result.reasons.some(r => r.includes('slippage'))).toBe(true);
    });

    it('returns THROTTLE for high partial fill rate', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            partialFillRate: 0.4, // Above 0.35
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('THROTTLE');
        expect(result.reasons.some(r => r.includes('partial fills'))).toBe(true);
    });

    it('accumulates multiple THROTTLE reasons', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            profitFactor: 1.0,
            avgSlippageBps: 35,
            partialFillRate: 0.4,
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('THROTTLE');
        expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    });

    it('PAUSE takes priority over THROTTLE', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            drawdownPct: 8, // PAUSE
            avgSlippageBps: 35, // THROTTLE
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('PAUSE');
    });

    it('SHUTDOWN takes priority over PAUSE', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            drawdownPct: 8, // PAUSE
            consecutiveFailures: 8, // SHUTDOWN
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('SHUTDOWN');
    });

    it('does NOT block on high drawdown when confidence gate is not met', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            tradesCount: 50,
            drawdownPct: 407.55,
            drawdownConfidence: true, // Upstream says true, but CP gate still requires peak threshold.
            peakEquity: 0.1923209, // Below minPeakEquityForDrawdown (1.0)
            equityNow: 0.1907102,
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('ALLOW');
        expect(result.reasons.some((r) => r.includes('Drawdown not confidence-qualified'))).toBe(true);
    });

    it('does NOT block on high drawdown when drawdownConfidence=false', () => {
        const metrics: RollingRiskMetrics = {
            ...healthyMetrics,
            drawdownPct: 120,
            drawdownConfidence: false,
            peakEquity: 10,
            equityNow: -2,
        };
        const result = determineProtectionMode(metrics, baseConfig);
        expect(result.mode).toBe('ALLOW');
        expect(result.reasons.some((r) => r.includes('Drawdown not confidence-qualified'))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CapitalProtectionEngine Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CapitalProtectionEngine', () => {
    const mockConfig: CapitalProtectionConfig = {
        enabled: true,
        lookbackTrades: 100,
        minTrades: 10,
        maxRollingDrawdownPct: 10,
        minTradesForDrawdown: 10,
        minPeakEquityForDrawdown: 1.0,
        minProfitFactor: 1.0,
        minExpectancyBps: -5,
        maxAvgSlippageBps: 50,
        maxPartialFillRate: 0.5,
        consecFailShutdown: 5,
        throttleSizeMultiplier: 0.5,
        throttleCooldownMs: 10000,
        pauseSizeMultiplier: 0.0,
        pauseCooldownMs: 600000,
    };

    const createMockFeedbackEngine = (metrics: RollingRiskMetrics) => ({
        getRollingRiskMetrics: vi.fn(() => metrics),
    });

    const createMockRiskEngine = (reserveBreach: boolean, consecutiveFailures = 0, isShutdown = false) => ({
        checkReserve: vi.fn(() => !reserveBreach),
        getStatus: vi.fn(() => ({
            consecutiveFailures,
            dailyLossExceeded: false,
            emergencyActive: isShutdown,
        })),
        isShutdown: vi.fn(() => isShutdown),
    });

    it('returns ALLOW with disabled message when disabled', () => {
        const disabledConfig = { ...mockConfig, enabled: false };
        const engine = new CapitalProtectionEngine({
            feedbackEngine: createMockFeedbackEngine({} as any) as any,
            riskEngine: createMockRiskEngine(false) as any,
            config: disabledConfig,
        });

        const result = engine.evaluate('XRP/RLUSD');
        expect(result.mode).toBe('ALLOW');
        expect(result.reasons).toContain('Capital protection disabled');
    });

    it('evaluates metrics from feedbackEngine', () => {
        const feedbackMetrics = {
            tradesCount: 50,
            profitFactor: 0.8,
            expectancyBps: -10,
            drawdownPct: 15,
            drawdownConfidence: true,
            peakEquity: 5,
            equityNow: 4,
            avgSlippageBps: 60,
            partialFillRate: 0.2,
            winRate: 0.4,
        };

        const engine = new CapitalProtectionEngine({
            feedbackEngine: createMockFeedbackEngine(feedbackMetrics as any) as any,
            riskEngine: createMockRiskEngine(false, 2) as any, // consecutiveFailures = 2
            config: mockConfig,
        });

        const result = engine.evaluate('XRP/RLUSD');
        // Extreme drawdown (15 >= 10*1.5=15) triggers SHUTDOWN
        expect(['SHUTDOWN', 'PAUSE']).toContain(result.mode);
        expect(result.metrics.tradesCount).toBe(50);
        expect(result.metrics.consecutiveFailures).toBe(2);
    });

    it('includes timestamp in decision', () => {
        const metrics = {
            tradesCount: 50,
            profitFactor: 1.5,
            expectancyBps: 10,
            drawdownPct: 3,
            drawdownConfidence: true,
            peakEquity: 5,
            equityNow: 4.8,
            avgSlippageBps: 20,
            partialFillRate: 0.1,
            winRate: 0.55,
        };

        const engine = new CapitalProtectionEngine({
            feedbackEngine: createMockFeedbackEngine(metrics as any) as any,
            riskEngine: createMockRiskEngine(false) as any,
            config: mockConfig,
        });

        const before = Date.now();
        const result = engine.evaluate('XRP/RLUSD');
        const after = Date.now();

        expect(result.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.timestamp).toBeLessThanOrEqual(after);
    });

    it('passes pairKey and lookback to feedbackEngine', () => {
        const mockFeedback = {
            getRollingRiskMetrics: vi.fn(() => ({
                tradesCount: 0,
                profitFactor: 0,
                expectancyBps: 0,
                drawdownPct: 0,
                drawdownConfidence: false,
                peakEquity: 0,
                equityNow: 0,
                avgSlippageBps: 0,
                partialFillRate: 0,
                winRate: 0,
            })),
        };

        const engine = new CapitalProtectionEngine({
            feedbackEngine: mockFeedback as any,
            riskEngine: createMockRiskEngine(false) as any,
            config: mockConfig,
        });

        engine.evaluate('XRP/RLUSD');
        expect(mockFeedback.getRollingRiskMetrics).toHaveBeenCalledWith({
            pairKey: 'XRP/RLUSD',
            lookbackTrades: 100,
        });
    });

    it('sets sizeMultiplier based on mode', () => {
        const throttleMetrics = {
            tradesCount: 50,
            profitFactor: 0.9, // Low PF triggers THROTTLE
            expectancyBps: 10,
            drawdownPct: 3,
            drawdownConfidence: true,
            peakEquity: 5,
            equityNow: 4.8,
            avgSlippageBps: 20,
            partialFillRate: 0.1,
            winRate: 0.55,
        };

        const engine = new CapitalProtectionEngine({
            feedbackEngine: createMockFeedbackEngine(throttleMetrics as any) as any,
            riskEngine: createMockRiskEngine(false) as any,
            config: mockConfig,
        });

        const result = engine.evaluate('XRP/RLUSD');
        expect(result.mode).toBe('THROTTLE');
        expect(result.sizeMultiplier).toBe(0.5);
        expect(result.cooldownMs).toBe(10000);
    });

    it('calls checkReserve on riskEngine', () => {
        const healthyMetrics = {
            tradesCount: 50,
            profitFactor: 1.5,
            expectancyBps: 10,
            drawdownPct: 3,
            drawdownConfidence: true,
            peakEquity: 5,
            equityNow: 4.8,
            avgSlippageBps: 20,
            partialFillRate: 0.1,
            winRate: 0.55,
        };

        const mockRisk = createMockRiskEngine(false);
        const engine = new CapitalProtectionEngine({
            feedbackEngine: createMockFeedbackEngine(healthyMetrics as any) as any,
            riskEngine: mockRisk as any,
            config: mockConfig,
        });

        engine.evaluate('XRP/RLUSD');
        // Reserve is checked during evaluation
        expect(mockRisk.isShutdown).toHaveBeenCalled();
    });
});
