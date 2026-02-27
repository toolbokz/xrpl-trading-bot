import { describe, expect, it } from 'vitest';
import {
    checkLimitVsMidSlippage,
    chooseLimitPrice,
    computeFill,
} from '../depthPricing';

describe('depthPricing', () => {
    it('computeFill calculates VWAP across multiple levels', () => {
        const fill = computeFill([
            { price: 1.0, baseSize: 1.0 },
            { price: 1.2, baseSize: 2.0 },
        ], 2.0);

        // (1 * 1.0 + 1 * 1.2) / 2 = 1.1
        expect(fill.fillableBase).toBeCloseTo(2.0, 10);
        expect(fill.vwap).toBeCloseTo(1.1, 10);
        expect(fill.worstPrice).toBeCloseTo(1.2, 10);
    });

    it('returns zero fill when book is empty', () => {
        const decision = chooseLimitPrice({
            side: 'BUY',
            desiredBase: 1.0,
            book: { bids: [], asks: [] },
            slippageBps: 5,
        });

        expect(decision.fillableBase).toBe(0);
        expect(decision.limitPrice).toBeNull();
        expect(decision.expectedVwap).toBeNull();
    });

    it('computes slippage-aware limit for BUY and SELL', () => {
        const buyDecision = chooseLimitPrice({
            side: 'BUY',
            desiredBase: 1.0,
            book: {
                bids: [],
                asks: [
                    { price: 1.0, baseSize: 0.5 },
                    { price: 1.02, baseSize: 1.0 },
                ],
            },
            slippageBps: 100, // 1%
        });
        const sellDecision = chooseLimitPrice({
            side: 'SELL',
            desiredBase: 1.0,
            book: {
                bids: [
                    { price: 0.99, baseSize: 0.4 },
                    { price: 0.98, baseSize: 1.0 },
                ],
                asks: [],
            },
            slippageBps: 100, // 1%
        });

        expect(buyDecision.fillableBase).toBeCloseTo(1.0, 10);
        expect(buyDecision.limitPrice).toBeCloseTo(1.02, 10);
        expect(buyDecision.expectedVwap).toBeCloseTo(1.01, 10);

        expect(sellDecision.fillableBase).toBeCloseTo(1.0, 10);
        expect(sellDecision.limitPrice).toBeCloseTo(0.98, 10);
        expect(sellDecision.expectedVwap).toBeCloseTo(0.984, 10);
    });

    it('max slippage vs mid guard rejects outlier limit', () => {
        const guard = checkLimitVsMidSlippage({
            side: 'BUY',
            limitPrice: 1.05,
            midPrice: 1.0,
            maxSlippageBps: 30,
        });

        expect(guard.allowed).toBe(false);
        expect(guard.slippageBps).toBeCloseTo(500, 10);
    });
});
