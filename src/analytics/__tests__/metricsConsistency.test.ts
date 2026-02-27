/**
 * Integration-level tests for metrics consistency across modules.
 *
 * Validates that:
 * - capitalProtection.computeProfitFactor delegates to canonical
 * - PF/WR classification semantics are consistent
 * - Display caps apply only at visualization layers
 * - Rolling metrics handle edge cases safely
 */

import { describe, expect, it } from 'vitest';
import { computeProfitFactor, computeExpectancyBps } from '../../risk/capitalProtection';
import {
    computeProfitFactorCanonical,
    classifyPnl,
    pfToFinite,
    PNL_EPSILON,
} from '../metricUtils';

// ─────────────────────────────────────────────────────────────────────────────
// PF Canonical Fallback Consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('PF canonical fallback — all modules consistent', () => {
    const testCases: [number, number, number][] = [
        // [gain, loss, expected]
        [0, 0, 1],           // no data → neutral
        [100, 0, Infinity],  // all wins → Infinity
        [0, 100, 0],         // all losses → 0
        [200, 100, 2.0],     // normal
        [50, 100, 0.5],      // sub-1 PF
        [1, 1, 1.0],         // breakeven
        [1, 1000, 0.001],    // tiny edge
    ];

    for (const [gain, loss, expected] of testCases) {
        it(`(${gain}, ${loss}) → ${expected}`, () => {
            const cp = computeProfitFactor(gain, loss);
            const canonical = computeProfitFactorCanonical(gain, loss);
            expect(cp).toBe(canonical);
            if (Number.isFinite(expected)) {
                expect(cp).toBeCloseTo(expected, 6);
            } else {
                expect(cp).toBe(expected);
            }
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Display Cap vs Core Logic
// ─────────────────────────────────────────────────────────────────────────────

describe('Display cap applies only at visualization layer', () => {
    it('canonical without cap preserves Infinity for risk logic', () => {
        const pf = computeProfitFactorCanonical(100, 0);
        expect(pf).toBe(Infinity);
    });

    it('canonical with displayCap caps Infinity for charts/heatmaps', () => {
        const pf = computeProfitFactorCanonical(100, 0, { displayCap: 10 });
        expect(pf).toBe(10);
    });

    it('pfToFinite caps Infinity for JSON serialization', () => {
        expect(pfToFinite(Infinity, 100)).toBe(100);
        expect(pfToFinite(2.5, 100)).toBe(2.5);
    });

    it('displayCap does not affect sub-cap values', () => {
        const pf = computeProfitFactorCanonical(200, 100, { displayCap: 10 });
        expect(pf).toBeCloseTo(2.0, 6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PnL Classification Semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('PnL classification consistency', () => {
    it('breakeven trades do not count as win or loss', () => {
        const breakeven = classifyPnl(PNL_EPSILON * 0.5);
        expect(breakeven).toBe('breakeven');
        expect(breakeven).not.toBe('win');
        expect(breakeven).not.toBe('loss');
    });

    it('fee-aware PnL classification: gross positive becomes net negative', () => {
        // Simulated: grossPnl = 0.01, fee = 0.02
        const netPnl = 0.01 - 0.02;
        expect(classifyPnl(netPnl)).toBe('loss');
    });

    it('fee-aware PnL classification: large edge survives fees', () => {
        const netPnl = 0.10 - 0.02;
        expect(classifyPnl(netPnl)).toBe('win');
    });

    it('NaN and Infinity are breakeven', () => {
        expect(classifyPnl(NaN)).toBe('breakeven');
        expect(classifyPnl(Infinity)).toBe('breakeven');
        expect(classifyPnl(-Infinity)).toBe('breakeven');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expectancy Computation
// ─────────────────────────────────────────────────────────────────────────────

describe('computeExpectancyBps edge cases', () => {
    it('returns 0 for zero trades', () => {
        expect(computeExpectancyBps(0, 0, 0, 0, 1)).toBe(0);
    });

    it('returns 0 for zero avgTradeSize', () => {
        expect(computeExpectancyBps(5, 3, 100, 30, 0)).toBe(0);
    });

    it('positive expectancy for profitable system', () => {
        // 7 wins avg 20, 3 losses avg 10
        const exp = computeExpectancyBps(7, 3, 140, 30, 10);
        expect(exp).toBeGreaterThan(0);
    });

    it('negative expectancy for losing system', () => {
        // 3 wins avg 10, 7 losses avg 20
        const exp = computeExpectancyBps(3, 7, 30, 140, 10);
        expect(exp).toBeLessThan(0);
    });
});
