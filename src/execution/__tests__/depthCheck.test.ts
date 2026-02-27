import { describe, expect, it } from 'vitest';
import { evaluateDepthAvailability } from '../depthCheck';

describe('evaluateDepthAvailability', () => {
    it('returns NO_ORDERBOOK when side book is missing', () => {
        const result = evaluateDepthAvailability({
            side: 'BUY',
            requiredBase: 1,
            minRequiredBase: 1,
            maxLevels: 25,
            book: { bids: [{ price: 1.0, baseSize: 5 }] },
        });

        expect(result).toEqual({
            fillableBase: 0,
            hasDepth: false,
            levelsWalked: 0,
            error: 'NO_ORDERBOOK',
        });
    });

    it('walks deeper levels and marks hasDepth true once required base is met', () => {
        const result = evaluateDepthAvailability({
            side: 'BUY',
            requiredBase: 1,
            minRequiredBase: 1,
            maxLevels: 25,
            book: {
                asks: [
                    { price: 1.0, baseSize: 0.2 },
                    { price: 1.01, baseSize: 0.2 },
                    { price: 1.02, baseSize: 0.2 },
                    { price: 1.03, baseSize: 0.2 },
                    { price: 1.04, baseSize: 0.3 },
                ],
            },
        });

        expect(result.error).toBeNull();
        expect(result.fillableBase).toBeCloseTo(1.0, 8);
        expect(result.hasDepth).toBe(true);
        expect(result.levelsWalked).toBe(5);
    });

    it('returns hasDepth false when required base exceeds total depth', () => {
        const result = evaluateDepthAvailability({
            side: 'SELL',
            requiredBase: 2,
            minRequiredBase: 2,
            maxLevels: 25,
            book: {
                bids: [
                    { price: 0.99, baseSize: 0.4 },
                    { price: 0.98, baseSize: 0.3 },
                    { price: 0.97, baseSize: 0.2 },
                ],
            },
        });

        expect(result.error).toBeNull();
        expect(result.fillableBase).toBeCloseTo(0.9, 8);
        expect(result.fillableBase).toBeLessThan(2);
        expect(result.hasDepth).toBe(false);
    });
});
