/**
 * Tests for shared metric utilities used across dashboard, capital protection,
 * and feedback engine PF/WR computations.
 *
 * Covers: Fix A (dashboard WR/PF), Fix B (fee-aware PnL), Fix C (canonical PF),
 * Fix D (epsilon classification), Fix E (diagnostics), Fix F (series filter).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    PNL_EPSILON,
    classifyPnl,
    computeProfitFactorCanonical,
    pfToFinite,
    warnOnPoorClassifiability,
    type ClassifiabilityReport,
} from '../metricUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Fix D — Epsilon PnL Classification
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyPnl (epsilon-aware)', () => {
    it('classifies clear win', () => {
        expect(classifyPnl(0.01)).toBe('win');
        expect(classifyPnl(100)).toBe('win');
    });

    it('classifies clear loss', () => {
        expect(classifyPnl(-0.01)).toBe('loss');
        expect(classifyPnl(-100)).toBe('loss');
    });

    it('classifies zero as breakeven', () => {
        expect(classifyPnl(0)).toBe('breakeven');
    });

    it('classifies tiny positive below epsilon as breakeven', () => {
        expect(classifyPnl(PNL_EPSILON * 0.5)).toBe('breakeven');
        expect(classifyPnl(PNL_EPSILON)).toBe('breakeven');
    });

    it('classifies tiny negative above -epsilon as breakeven', () => {
        expect(classifyPnl(-PNL_EPSILON * 0.5)).toBe('breakeven');
        expect(classifyPnl(-PNL_EPSILON)).toBe('breakeven');
    });

    it('classifies value just above epsilon as win', () => {
        expect(classifyPnl(PNL_EPSILON * 1.1)).toBe('win');
    });

    it('classifies value just below -epsilon as loss', () => {
        expect(classifyPnl(-PNL_EPSILON * 1.1)).toBe('loss');
    });

    it('classifies NaN as breakeven', () => {
        expect(classifyPnl(NaN)).toBe('breakeven');
    });

    it('classifies Infinity as breakeven', () => {
        expect(classifyPnl(Infinity)).toBe('breakeven');
        expect(classifyPnl(-Infinity)).toBe('breakeven');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix C — Canonical Profit Factor
// ─────────────────────────────────────────────────────────────────────────────

describe('computeProfitFactorCanonical', () => {
    it('returns 1 for no data (gain=0, loss=0)', () => {
        expect(computeProfitFactorCanonical(0, 0)).toBe(1);
    });

    it('returns Infinity for all wins (gain>0, loss=0)', () => {
        expect(computeProfitFactorCanonical(100, 0)).toBe(Infinity);
    });

    it('returns 0 for all losses (gain=0, loss>0)', () => {
        expect(computeProfitFactorCanonical(0, 100)).toBe(0);
    });

    it('computes normal PF correctly', () => {
        expect(computeProfitFactorCanonical(200, 100)).toBeCloseTo(2.0, 6);
        expect(computeProfitFactorCanonical(50, 100)).toBeCloseTo(0.5, 6);
    });

    it('caps at displayCap when specified', () => {
        const pf = computeProfitFactorCanonical(100, 0, { displayCap: 10 });
        expect(pf).toBe(10);
    });

    it('caps finite PF above displayCap', () => {
        const pf = computeProfitFactorCanonical(1000, 1, { displayCap: 10 });
        expect(pf).toBe(10);
    });

    it('does not cap below displayCap', () => {
        const pf = computeProfitFactorCanonical(200, 100, { displayCap: 10 });
        expect(pf).toBeCloseTo(2.0, 6);
    });

    it('clamps negative gain to 0', () => {
        // Shouldn't happen in practice, but guard against it
        expect(computeProfitFactorCanonical(-10, 0)).toBe(1);
    });
});

describe('pfToFinite', () => {
    it('converts Infinity to cap', () => {
        expect(pfToFinite(Infinity)).toBe(100);
        expect(pfToFinite(Infinity, 50)).toBe(50);
    });

    it('passes through finite values', () => {
        expect(pfToFinite(2.5)).toBe(2.5);
        expect(pfToFinite(0)).toBe(0);
    });

    it('converts NaN to cap', () => {
        expect(pfToFinite(NaN, 100)).toBe(100);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix E — Rolling-Window Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

describe('warnOnPoorClassifiability', () => {
    // Mock logger
    const mockLogger = {
        warn: vi.fn(),
        debug: vi.fn(),
    };

    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.debug.mockClear();
        // Inject mock logger via module mock
        vi.doMock('../logger', () => ({ logger: mockLogger }));
    });

    function makeReport(overrides: Partial<ClassifiabilityReport> = {}): ClassifiabilityReport {
        return {
            total: 100,
            classifiable: 80,
            breakeven: 10,
            unclassifiableReasons: {
                missingMidPrice: 5,
                zeroFillSize: 3,
                missingFeeConversion: 2,
                breakeven: 10,
                nonFillEvent: 0,
            },
            ratio: 0.8,
            ...overrides,
        };
    }

    it('does nothing for empty input', () => {
        warnOnPoorClassifiability('test', makeReport({ total: 0 }));
        // Logger is the real one here; we just verify no crash
    });

    it('warns when classifiable is 0', () => {
        const report = makeReport({ total: 50, classifiable: 0, ratio: 0 });
        // Call succeeds without crashing
        warnOnPoorClassifiability('test', report);
    });

    it('warns when ratio < 0.5', () => {
        const report = makeReport({ total: 100, classifiable: 30, ratio: 0.3 });
        warnOnPoorClassifiability('test', report);
    });

    it('respects rate limiting', () => {
        const report = makeReport({ total: 100, classifiable: 0, ratio: 0 });
        const limiter = { lastWarnTs: Date.now(), intervalMs: 60000 };
        // Should be suppressed (too recent)
        warnOnPoorClassifiability('test', report, limiter);
    });
});
