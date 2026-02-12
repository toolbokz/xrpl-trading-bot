import { describe, expect, it } from 'vitest';
import { validateTradeIntegrity } from '../tradeIntegrity';

describe('trade integrity guard', () => {
    it('accepts valid normalized fill records', () => {
        const result = validateTradeIntegrity({
            pair: 'XRP/RLUSD',
            side: 'SELL',
            status: 'FILLED',
            amountBase: 0.15,
            filledBase: 0.15,
            filledQuote: 0.2055,
            priceQuotePerBase: 1.37,
            expectedPrice: 1.36,
            txHash: 'HASH',
        });
        expect(result.ok).toBe(true);
    });

    it('rejects final records with filledBase > amountBase', () => {
        const result = validateTradeIntegrity({
            pair: 'XRP/RLUSD',
            side: 'SELL',
            status: 'FILLED',
            amountBase: 0.15,
            filledBase: 0.21,
            filledQuote: 0.21,
            priceQuotePerBase: 1.4,
            txHash: 'HASH',
        });
        expect(result.ok).toBe(false);
        expect(result.reasons).toContain('filled-base-exceeds-amount-base');
    });

    it('rejects likely reciprocal SELL inversion for XRP/RLUSD when reference is >1', () => {
        const result = validateTradeIntegrity({
            pair: 'XRP/524C555344000000000000000000000000000000',
            side: 'SELL',
            status: 'FILLED',
            amountBase: 0.15,
            filledBase: 0.15,
            filledQuote: 0.1035,
            priceQuotePerBase: 0.69,
            expectedPrice: 1.37,
            txHash: 'HASH',
        });
        expect(result.ok).toBe(false);
        expect(result.reasons).toContain('sell-price-likely-inverted-vs-reference');
    });
});
