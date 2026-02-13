import { describe, expect, it } from 'vitest';
import { computeRollingDrawdownMetricsFromPnl } from '../feedbackEngine';

describe('computeRollingDrawdownMetricsFromPnl', () => {
    it('marks confidence false and drawdownPct=0 when peak equity is near zero', () => {
        // Pathological cold-start shape: tiny positive blip then large loss.
        const result = computeRollingDrawdownMetricsFromPnl([1e-8, -1], 1e-6);

        expect(result.drawdownConfidence).toBe(false);
        expect(result.drawdownPct).toBe(0);
        expect(result.peakEquity).toBeCloseTo(1e-8, 12);
        expect(result.equityNow).toBeCloseTo(-0.99999999, 8);
    });

    it('computes drawdown when peak equity is meaningful', () => {
        // Equity curve: 1 -> 2 -> 1.5, max DD = (2 - 1.5) / 2 = 25%
        const result = computeRollingDrawdownMetricsFromPnl([1, 1, -0.5], 1e-6);

        expect(result.drawdownConfidence).toBe(true);
        expect(result.drawdownPct).toBeCloseTo(25, 6);
        expect(result.peakEquity).toBeCloseTo(2, 6);
        expect(result.equityNow).toBeCloseTo(1.5, 6);
    });

    it('never emits NaN/negative drawdown for non-finite inputs', () => {
        const result = computeRollingDrawdownMetricsFromPnl([Number.NaN, Number.POSITIVE_INFINITY, -5], 1e-6);

        expect(Number.isFinite(result.drawdownPct)).toBe(true);
        expect(result.drawdownPct).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result.peakEquity)).toBe(true);
        expect(Number.isFinite(result.equityNow)).toBe(true);
    });
});

