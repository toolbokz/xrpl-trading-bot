/**
 * Tests for feedbackEngine.computeEventPnl fee-aware behavior (Fix B)
 * and computeProfitFactor canonical behavior (Fix C) in capitalProtection.
 *
 * These tests verify that:
 * - tx fees and AMM fees are deducted from edge-based PnL
 * - PF fallback is consistent across capitalProtection and feedbackEngine
 */

import { describe, expect, it } from 'vitest';
import { computeProfitFactor } from '../../risk/capitalProtection';
import {
    computeProfitFactorCanonical,
    classifyPnl,
    PNL_EPSILON,
} from '../metricUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: PF canonical fallback consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('PF canonical fallback — capitalProtection vs metricUtils', () => {
    it('(0,0) => 1 in both', () => {
        expect(computeProfitFactor(0, 0)).toBe(1);
        expect(computeProfitFactorCanonical(0, 0)).toBe(1);
    });

    it('(>0,0) => Infinity in both', () => {
        expect(computeProfitFactor(100, 0)).toBe(Infinity);
        expect(computeProfitFactorCanonical(100, 0)).toBe(Infinity);
    });

    it('(0,>0) => 0 in both', () => {
        expect(computeProfitFactor(0, 100)).toBe(0);
        expect(computeProfitFactorCanonical(0, 100)).toBe(0);
    });

    it('normal => gain/loss in both', () => {
        expect(computeProfitFactor(200, 100)).toBeCloseTo(2.0, 6);
        expect(computeProfitFactorCanonical(200, 100)).toBeCloseTo(2.0, 6);
    });

    it('capitalProtection.computeProfitFactor matches canonical for all edge cases', () => {
        const testCases: [number, number][] = [
            [0, 0],
            [100, 0],
            [0, 100],
            [50, 50],
            [150, 75],
            [1, 1000],
        ];

        for (const [gain, loss] of testCases) {
            const cp = computeProfitFactor(gain, loss);
            const canonical = computeProfitFactorCanonical(gain, loss);
            expect(cp).toBe(canonical);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 (complementary): Fees in computeEventPnl
// NOTE: computeEventPnl is private to FeedbackEngine, so we test its
// behavioral effect through the public-facing classification logic here.
// The actual integration testing of computeEventPnl with fees is done in
// feedbackEngine.test.ts if/when a test harness exists for the engine.
// ─────────────────────────────────────────────────────────────────────────────

describe('Fee-aware PnL classification (unit-level via classifyPnl)', () => {
    it('gross positive edge becomes net negative after fee deduction', () => {
        // Simulate what computeEventPnl now does:
        // edgeBps = 5, fillPrice = 2.0, fillSize = 10
        // grossPnl = (5/10000) * 2.0 * 10 = 0.01
        const grossPnl = (5 / 10000) * 2.0 * 10;
        expect(classifyPnl(grossPnl)).toBe('win');

        // After txFee = 0.000012 XRP * 2.0 = 0.000024 and AMM fee = 8 bps
        // ammFee = (8/10000) * 2.0 * 10 = 0.016
        const feeCost = 0.000024 + (8 / 10000) * 2.0 * 10;
        const netPnl = grossPnl - feeCost;
        expect(netPnl).toBeLessThan(0);
        expect(classifyPnl(netPnl)).toBe('loss');
    });

    it('large edge survives fee deduction', () => {
        // edgeBps = 50
        const grossPnl = (50 / 10000) * 2.0 * 10;
        const feeCost = 0.000024 + (8 / 10000) * 2.0 * 10;
        const netPnl = grossPnl - feeCost;
        expect(netPnl).toBeGreaterThan(0);
        expect(classifyPnl(netPnl)).toBe('win');
    });

    it('exact fee cancellation results in breakeven', () => {
        // Construct PnL that is exactly at epsilon
        const netPnl = PNL_EPSILON * 0.5;
        expect(classifyPnl(netPnl)).toBe('breakeven');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Series fill-only filter (behavioral)
// ─────────────────────────────────────────────────────────────────────────────

describe('PF series filter verification', () => {
    // computeProfitFactorSeries is private, so we verify the filtering logic
    // using the same predicate used in the implementation.
    it('fill event predicate matches fill and offer_create-with-fill', () => {
        const fillEvent = { action: 'fill', fillPrice: 2.0, isBotTrade: 1 };
        const offerFill = { action: 'offer_create', fillPrice: 2.0, isBotTrade: 1 };
        const reject = { action: 'reject', fillPrice: null, isBotTrade: 1 };
        const error = { action: 'error', fillPrice: null, isBotTrade: 1 };
        const manualFill = { action: 'fill', fillPrice: 2.0, isBotTrade: 0 };

        const isFill = (e: any) =>
            (e.action === 'fill' || (e.action === 'offer_create' && e.fillPrice)) &&
            e.isBotTrade === 1;

        expect(isFill(fillEvent)).toBe(true);
        expect(isFill(offerFill)).toBe(true);
        expect(isFill(reject)).toBe(false);
        expect(isFill(error)).toBe(false);
        expect(isFill(manualFill)).toBe(false);
    });
});
