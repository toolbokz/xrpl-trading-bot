import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enforceMinSize } from '../minSizeGate';

const pair = 'XRP/RLUSD';

describe('minSizeGate', () => {
    const originalBaseOrderSize = process.env.BASE_ORDER_SIZE_XRP;
    const originalPositionSize = process.env.POSITION_SIZE_XRP;

    beforeEach(() => {
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
        delete process.env.BASE_ORDER_SIZE_XRP;
        delete process.env.POSITION_SIZE_XRP;
    });

    afterEach(() => {
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
        // Restore original values
        if (originalBaseOrderSize !== undefined) process.env.BASE_ORDER_SIZE_XRP = originalBaseOrderSize;
        else delete process.env.BASE_ORDER_SIZE_XRP;
        if (originalPositionSize !== undefined) process.env.POSITION_SIZE_XRP = originalPositionSize;
        else delete process.env.POSITION_SIZE_XRP;
    });

    it('derives min from BASE_ORDER_SIZE_XRP when EXECUTION_MIN_BASE_XRP is absent', () => {
        // With no sizing env vars set, defaults: base=5, frac=0.25 → derived min=1.25
        const result = enforceMinSize({
            pair,
            side: 'BUY',
            amountBase: 0.25,
            price: 1.0,
        });

        expect(result).toEqual({ ok: false, reason: 'base-below-min' });
    });

    it('uses explicit EXECUTION_MIN_BASE_XRP over derived value', () => {
        process.env.EXECUTION_MIN_BASE_XRP = '5';
        const result = enforceMinSize({
            pair,
            side: 'BUY',
            amountBase: 3,
            price: 1.0,
        });

        expect(result).toEqual({ ok: false, reason: 'base-below-min' });
    });

    it('passes amountBase=10 when quote notional passes', () => {
        const result = enforceMinSize({
            pair,
            side: 'SELL',
            amountBase: 10,
            price: 1.0,
        });

        expect(result).toEqual({ ok: true, reason: null });
    });

    it('stops retry shrink sequence once reduced amount crosses min threshold', () => {
        // Derived base min = default base(5) × default frac(0.25) = 1.25
        // Use price=10 so quote notional stays above the quote min (5 RLUSD fallback):
        //   amountBase=1.25 × price=10 = 12.5 RLUSD → ok
        //   amountBase=1.0  × price=10 = 10.0 RLUSD → ok on quote, but amountBase<1.25 → base-below-min
        const proposedAmounts = [5, 2.5, 1.25, 1.0, 0.5];
        const acceptedAmounts: number[] = [];
        let stopReason: string | null = null;

        for (const amountBase of proposedAmounts) {
            const gate = enforceMinSize({
                pair,
                side: 'BUY',
                amountBase,
                price: 10,
            });
            if (!gate.ok) {
                stopReason = gate.reason;
                break;
            }
            acceptedAmounts.push(amountBase);
        }

        expect(acceptedAmounts).toEqual([5, 2.5, 1.25]);
        expect(stopReason).toBe('base-below-min');
    });
});
