import { describe, expect, it } from 'vitest';
import {
    computeCanonicalSlippageBps,
    isReciprocalLikePrices,
} from '../slippageMath';

describe('slippageMath', () => {
    it('computes BUY slippage with positive=cost and negative=improvement', () => {
        const worse = computeCanonicalSlippageBps('buy', 1.35, 1.36);
        const better = computeCanonicalSlippageBps('buy', 1.35, 1.34);

        expect(worse).not.toBeNull();
        expect(better).not.toBeNull();
        expect(worse!).toBeGreaterThan(0);
        expect(better!).toBeLessThan(0);
    });

    it('computes SELL slippage with positive=cost and negative=improvement', () => {
        const worse = computeCanonicalSlippageBps('sell', 1.35, 1.34);
        const better = computeCanonicalSlippageBps('sell', 1.35, 1.36);

        expect(worse).not.toBeNull();
        expect(better).not.toBeNull();
        expect(worse!).toBeGreaterThan(0);
        expect(better!).toBeLessThan(0);
    });

    it('flags reciprocal-like orientation mismatches', () => {
        const expected = 1.38025;
        const reciprocalFill = 0.7245064299;

        const reciprocal = isReciprocalLikePrices(expected, reciprocalFill);
        const slippage = computeCanonicalSlippageBps('sell', expected, reciprocalFill);

        expect(reciprocal.reciprocalLike).toBe(true);
        expect(slippage).toBeNull();
    });

    it('produces distinct slippage values across intent, mid, and BBO baselines', () => {
        const fillPrice = 1.365;
        const side: 'buy' = 'buy';
        const vsIntent = computeCanonicalSlippageBps(side, 1.36, fillPrice);
        const vsMid = computeCanonicalSlippageBps(side, 1.355, fillPrice);
        const vsBbo = computeCanonicalSlippageBps(side, 1.362, fillPrice);

        expect(vsIntent).not.toBeNull();
        expect(vsMid).not.toBeNull();
        expect(vsBbo).not.toBeNull();

        const unique = new Set([
            vsIntent!.toFixed(6),
            vsMid!.toFixed(6),
            vsBbo!.toFixed(6),
        ]);
        expect(unique.size).toBe(3);
    });
});
