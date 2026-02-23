import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enforceMinSize } from '../minSizeGate';

const pair = 'XRP/RLUSD';

describe('minSizeGate', () => {
    beforeEach(() => {
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
    });

    afterEach(() => {
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
    });

    it('fails amountBase=0.25 with default min base 5 XRP', () => {
        const result = enforceMinSize({
            pair,
            side: 'BUY',
            amountBase: 0.25,
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
        const proposedAmounts = [10, 7.5, 5, 4.5, 4];
        const acceptedAmounts: number[] = [];
        let stopReason: string | null = null;

        for (const amountBase of proposedAmounts) {
            const gate = enforceMinSize({
                pair,
                side: 'BUY',
                amountBase,
                price: 1.0,
            });
            if (!gate.ok) {
                stopReason = gate.reason;
                break;
            }
            acceptedAmounts.push(amountBase);
        }

        expect(acceptedAmounts).toEqual([10, 7.5, 5]);
        expect(stopReason).toBe('base-below-min');
    });
});
