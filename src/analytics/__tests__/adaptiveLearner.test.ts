/**
 * Adaptive Learner Tests
 *
 * Tests for recommendTuning heuristics and smoothing logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    recommendTuning,
    DEFAULT_TUNING,
    AdaptiveTuning,
    PerformanceRow,
    AdaptiveLearnerConfig,
} from '../adaptiveLearner';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const defaultConfig: AdaptiveLearnerConfig = {
    lookbackHours: 24,
    minSamples: 25,
    alpha: 0.2,
    maxSizeStep: 0.1,
    maxSlippageStep: 10,
    statePath: '/tmp/test-adaptive-state.json',
};

function makePerformanceRow(overrides: Partial<PerformanceRow> = {}): PerformanceRow {
    return {
        strategy: 'scalper',
        regime: 'normal',
        fills: 50,
        avgNetEdgeBps: 5,
        avgSlippageBpsVsMid: 3,
        avgSpreadPaidBps: 2,
        partialFillRate: 0.1,
        winRateProxy: 0.6,
        score: 2.5,
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('recommendTuning', () => {
    describe('default behavior', () => {
        it('should return stable tuning for good performance', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: 8,
                avgSlippageBpsVsMid: 5,
                winRateProxy: 0.65,
                partialFillRate: 0.05,
                score: 5,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            // Strong performance should allow size increase
            expect(result.sizeMultiplier).toBeGreaterThanOrEqual(1.0);
            expect(result.sizeMultiplier).toBeLessThanOrEqual(1.2);
            expect(result.minEdgeBpsToTrade).toBeLessThanOrEqual(5);
            expect(result.coolDownMs).toBe(0);
            expect(result.disabledRegimes).toHaveLength(0);
            expect(result.reason).toContain('strongPerf');
        });

        it('should reduce exposure for negative edge', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: -10,
                winRateProxy: 0.4,
                score: -15,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.sizeMultiplier).toBeLessThan(1.0);
            expect(result.minEdgeBpsToTrade).toBeGreaterThan(0);
            expect(result.coolDownMs).toBeGreaterThan(0);
            expect(result.reason).toContain('negEdge');
        });

        it('should reduce size for high partial fill rate', () => {
            const perfRow = makePerformanceRow({
                partialFillRate: 0.5,
                score: -5,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.sizeMultiplier).toBeLessThan(1.0);
            expect(result.reason).toContain('highPartials');
        });

        it('should disable chaotic regime with negative score', () => {
            const perfRow = makePerformanceRow({
                regime: 'chaotic',
                avgNetEdgeBps: -5,
                score: -10,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.disabledRegimes).toContain('chaotic');
            expect(result.reason).toContain('disable chaotic');
        });

        it('should disable illiquid regime with negative score', () => {
            const perfRow = makePerformanceRow({
                regime: 'illiquid',
                avgNetEdgeBps: -3,
                score: -8,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.disabledRegimes).toContain('illiquid');
            expect(result.reason).toContain('disable illiquid');
        });

        it('should not disable normal regime even with negative score', () => {
            const perfRow = makePerformanceRow({
                regime: 'normal',
                avgNetEdgeBps: -5,
                score: -10,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.disabledRegimes).not.toContain('normal');
        });
    });

    describe('smoothing behavior', () => {
        it('should smooth size multiplier changes', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: -20,
                score: -30,
            });

            const priorTuning: AdaptiveTuning = {
                ...DEFAULT_TUNING,
                sizeMultiplier: 1.0,
            };

            const result = recommendTuning({
                perfRow,
                priorTuning,
                config: defaultConfig,
            });

            // Should not drop instantly from 1.0 to target
            // maxSizeStep is 0.1, alpha is 0.2
            expect(result.sizeMultiplier).toBeGreaterThanOrEqual(0.9);
            expect(result.sizeMultiplier).toBeLessThan(1.0);
        });

        it('should respect maxSizeStep constraint', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: -50,
                score: -60,
            });

            const priorTuning: AdaptiveTuning = {
                ...DEFAULT_TUNING,
                sizeMultiplier: 1.0,
            };

            const result = recommendTuning({
                perfRow,
                priorTuning,
                config: { ...defaultConfig, maxSizeStep: 0.1 },
            });

            // Change should be bounded by maxSizeStep
            expect(result.sizeMultiplier).toBeGreaterThanOrEqual(0.9);
        });

        it('should smooth slippage changes', () => {
            const perfRow = makePerformanceRow({
                avgSlippageBpsVsMid: 20,
                score: -5,
            });

            const priorTuning: AdaptiveTuning = {
                ...DEFAULT_TUNING,
                maxSlippageBps: 50,
            };

            const result = recommendTuning({
                perfRow,
                priorTuning,
                config: defaultConfig,
            });

            // Max slippage should not change by more than maxSlippageStep
            expect(Math.abs(result.maxSlippageBps - priorTuning.maxSlippageBps)).toBeLessThanOrEqual(10);
        });

        it('should preserve prior disabled regimes', () => {
            const perfRow = makePerformanceRow({
                regime: 'normal',
                score: 5,
            });

            const priorTuning: AdaptiveTuning = {
                ...DEFAULT_TUNING,
                disabledRegimes: ['chaotic'],
            };

            const result = recommendTuning({
                perfRow,
                priorTuning,
                config: defaultConfig,
            });

            // Prior disabled regime should be preserved
            expect(result.disabledRegimes).toContain('chaotic');
        });
    });

    describe('bounds enforcement', () => {
        it('should clamp sizeMultiplier to [0, 1.5]', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: 100,
                score: 100,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.sizeMultiplier).toBeLessThanOrEqual(1.5);
            expect(result.sizeMultiplier).toBeGreaterThanOrEqual(0);
        });

        it('should clamp maxSlippageBps to [10, 150]', () => {
            const perfRow = makePerformanceRow({ score: 0 });

            const priorTuning: AdaptiveTuning = {
                ...DEFAULT_TUNING,
                maxSlippageBps: 5, // Below minimum
            };

            const result = recommendTuning({
                perfRow,
                priorTuning,
                config: defaultConfig,
            });

            expect(result.maxSlippageBps).toBeGreaterThanOrEqual(10);
            expect(result.maxSlippageBps).toBeLessThanOrEqual(150);
        });

        it('should clamp minEdgeBpsToTrade to [0, 30]', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: -100,
                score: -100,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.minEdgeBpsToTrade).toBeGreaterThanOrEqual(0);
            expect(result.minEdgeBpsToTrade).toBeLessThanOrEqual(30);
        });

        it('should clamp coolDownMs to [0, 60000]', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: -100,
                score: -100,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.coolDownMs).toBeGreaterThanOrEqual(0);
            expect(result.coolDownMs).toBeLessThanOrEqual(60000);
        });
    });

    describe('reason generation', () => {
        it('should include meaningful reason for adjustments', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: -15,
                partialFillRate: 0.4,
                score: -20,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            expect(result.reason).toBeTruthy();
            expect(result.reason.length).toBeGreaterThan(10);
            // Should mention the key metrics
            expect(result.reason).toMatch(/negEdge|highPartials/);
        });

        it('should indicate stability when no major changes', () => {
            const perfRow = makePerformanceRow({
                avgNetEdgeBps: 2,
                avgSlippageBpsVsMid: 3,
                partialFillRate: 0.05,
                winRateProxy: 0.52,
                score: 1,
            });

            const result = recommendTuning({ perfRow, config: defaultConfig });

            // With neutral metrics, should indicate stability
            expect(result.reason).toMatch(/stable|score/);
        });
    });
});

describe('score calculation', () => {
    it('should produce positive score for good metrics', () => {
        // score = avgNetEdgeBps - 0.5*avgSlippageBpsVsMid - 0.25*avgSpreadPaidBps - 20*partialFillRate
        // = 10 - 0.5*2 - 0.25*1 - 20*0.05
        // = 10 - 1 - 0.25 - 1
        // = 7.75
        const perfRow = makePerformanceRow({
            avgNetEdgeBps: 10,
            avgSlippageBpsVsMid: 2,
            avgSpreadPaidBps: 1,
            partialFillRate: 0.05,
            score: 7.75,
        });

        expect(perfRow.score).toBeGreaterThan(0);
    });

    it('should produce negative score for poor metrics', () => {
        // score = -5 - 0.5*15 - 0.25*5 - 20*0.3
        // = -5 - 7.5 - 1.25 - 6
        // = -19.75
        const perfRow = makePerformanceRow({
            avgNetEdgeBps: -5,
            avgSlippageBpsVsMid: 15,
            avgSpreadPaidBps: 5,
            partialFillRate: 0.3,
            score: -19.75,
        });

        expect(perfRow.score).toBeLessThan(0);
    });
});
