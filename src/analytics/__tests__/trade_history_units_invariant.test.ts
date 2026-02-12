import { describe, expect, it } from 'vitest';
import { normalizeTradeUnits } from '../tradeHistory';

describe('trade history unit normalization', () => {
    it('converts legacy SELL unit-mixed records so filledBase does not exceed amountBase', () => {
        const legacy = normalizeTradeUnits({
            pair: 'XRP/524C555344000000000000000000000000000000',
            side: 'SELL',
            price: 0.7178288824031187,
            amount: 0.25,
            filled: 0.3481442529355263,
            fee: 0.000012,
            pnl: 0,
            hash: 'FED85E26AED2B410CEE4CAB32E1F066303282B35B70703739DF8AC70CE9540A5',
            paper: false,
            status: 'FILLED',
            source: 'bot',
        });

        expect(legacy.pair).toBe('XRP/RLUSD');
        expect(legacy.amountBase).toBeCloseTo(0.25, 8);
        expect(legacy.filledBase).toBeLessThanOrEqual((legacy.amountBase ?? legacy.amount) + 1e-9);
        expect(legacy.filledQuote).toBeCloseTo(0.3481442529355263, 10);
        expect(legacy.filled).toBeCloseTo(legacy.filledBase ?? 0, 10);
    });

    it('preserves explicit base/quote fields for corrected records', () => {
        const corrected = normalizeTradeUnits({
            pair: 'XRP/RLUSD',
            side: 'SELL',
            price: 1.38025,
            priceQuotePerBase: 1.38025,
            amount: 0.075,
            amountBase: 0.075,
            filled: 0.075,
            filledBase: 0.075,
            filledQuote: 0.10351875,
            fee: 0.000012,
            pnl: 0,
            hash: 'FB3E6D9B10FDF1E8542A5506A1B815CBDFD25192B9F245E619456C62333212F3',
            paper: false,
            status: 'FILLED',
            source: 'bot',
        });

        expect(corrected.amountBase).toBeCloseTo(0.075, 10);
        expect(corrected.filledBase).toBeCloseTo(0.075, 10);
        expect(corrected.filledQuote).toBeCloseTo(0.10351875, 10);
        expect(corrected.priceQuotePerBase).toBeCloseTo(1.38025, 10);
    });
});
