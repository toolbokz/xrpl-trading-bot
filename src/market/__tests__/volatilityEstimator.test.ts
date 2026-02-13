import { describe, it, expect } from 'vitest';
import { VolatilityEstimator, clampBps, resolveAdaptiveStopLossBps } from '../volatilityEstimator';

describe('VolatilityEstimator', () => {
    it('keeps volatility near zero for constant prices', () => {
        const estimator = new VolatilityEstimator({ alpha: 0.2, minSamples: 3, warmupMs: 60_000 }, 0);

        estimator.update(1.0, 0);
        estimator.update(1.0, 1_000);
        estimator.update(1.0, 2_000);
        estimator.update(1.0, 3_000);

        expect(estimator.getVolBps()).toBeCloseTo(0, 8);
        expect(estimator.getState().sampleCount).toBe(3);
    });

    it('computes EWMA over absolute returns in bps', () => {
        const estimator = new VolatilityEstimator({ alpha: 0.2, minSamples: 10, warmupMs: 60_000 }, 0);

        estimator.update(100, 0);
        estimator.update(101, 1_000); // 100 bps
        estimator.update(99, 2_000);  // 198.0198 bps
        estimator.update(100, 3_000); // 101.0101 bps

        // EWMA:
        // v1 = 100
        // v2 = 0.2*198.0198 + 0.8*100 = 119.60396
        // v3 = 0.2*101.0101 + 0.8*119.60396 = 115.885188
        expect(estimator.getVolBps()).toBeCloseTo(115.885188, 5);
        expect(estimator.getState().sampleCount).toBe(3);
    });

    it('readiness uses sample threshold OR warmup time', () => {
        const estimator = new VolatilityEstimator({ alpha: 0.2, minSamples: 3, warmupMs: 1_000 }, 0);

        estimator.update(1.0, 0);
        estimator.update(1.01, 100);
        estimator.update(1.015, 200);

        // 2 samples (< minSamples), warmup not elapsed
        expect(estimator.isReady(500)).toBe(false);
        // Warmup elapsed => ready even though sampleCount < minSamples
        expect(estimator.isReady(1_000)).toBe(true);
    });

    it('ignores invalid mids and can reset cleanly', () => {
        const estimator = new VolatilityEstimator({ alpha: 0.3, minSamples: 2, warmupMs: 60_000 }, 0);

        estimator.update(Number.NaN, 1);
        estimator.update(Infinity, 2);
        estimator.update(-1, 3);
        expect(estimator.getState().sampleCount).toBe(0);
        expect(estimator.getVolBps()).toBe(0);

        estimator.update(1.0, 10);
        estimator.update(1.02, 20);
        expect(estimator.getState().sampleCount).toBe(1);

        estimator.reset(30);
        expect(estimator.getState().sampleCount).toBe(0);
        expect(estimator.getVolBps()).toBe(0);
        expect(estimator.isReady(31)).toBe(false);
    });
});

describe('volatility stop helpers', () => {
    it('clamps adaptive stop bps within bounds', () => {
        expect(clampBps(20, 50, 250)).toBe(50);
        expect(clampBps(160, 50, 250)).toBe(160);
        expect(clampBps(999, 50, 250)).toBe(250);
    });

    it('resolves fixed/adaptive stop sources correctly', () => {
        const fixed = resolveAdaptiveStopLossBps({
            fixedStopLossBps: 100,
            volBps: 200,
            volReady: true,
            config: { enabled: false, multiplier: 2, minBps: 50, maxBps: 250, useForEnhanced: true },
        });
        expect(fixed.source).toBe('fixed-disabled');
        expect(fixed.stopLossBpsUsed).toBe(100);
        expect(fixed.enhancedStopBpsUsed).toBe(50);

        const warmup = resolveAdaptiveStopLossBps({
            fixedStopLossBps: 100,
            volBps: 200,
            volReady: false,
            config: { enabled: true, multiplier: 2, minBps: 50, maxBps: 250, useForEnhanced: true },
        });
        expect(warmup.source).toBe('fixed-warmup');
        expect(warmup.stopLossBpsUsed).toBe(100);
        expect(warmup.enhancedStopBpsUsed).toBe(50);

        const adaptive = resolveAdaptiveStopLossBps({
            fixedStopLossBps: 100,
            volBps: 80,
            volReady: true,
            config: { enabled: true, multiplier: 2, minBps: 50, maxBps: 250, useForEnhanced: true },
        });
        expect(adaptive.source).toBe('adaptive');
        expect(adaptive.stopLossBpsUsed).toBe(160);
        expect(adaptive.enhancedStopBpsUsed).toBe(80);
    });
});
