import { describe, expect, it } from 'vitest';
import type { TransactionMetadata } from 'xrpl';
import type { TradingPair } from '../../config';
import { OfferExecutor } from '../offerExecutor';

const PAIR: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rQuoteIssuer1111111111111111111111111',
    issuer: 'rQuoteIssuer1111111111111111111111111',
};

describe('OfferExecutor.parsePartialFill SELL normalization', () => {
    it('computes quote-per-base price for SELL fills (no reciprocal inversion)', () => {
        const executor = new OfferExecutor(
            {} as any,
            null,
            { registerFailure() { }, resetFailures() { } } as any,
            false,
            PAIR
        );

        // Fixture-aligned shape for hash FB3E6D9B...12F3:
        // base sold = 0.075 XRP, quote received = 0.10351875 RLUSD
        // expected quote/base price ≈ 1.38025 (NOT 0.7245 reciprocal).
        const meta = {
            AffectedNodes: [
                {
                    DeletedNode: {
                        LedgerEntryType: 'Offer',
                        PreviousFields: {
                            TakerGets: '75000', // 0.075 XRP
                            TakerPays: {
                                currency: '524C555344000000000000000000000000000000',
                                issuer: PAIR.quoteIssuer,
                                value: '0.10351875',
                            },
                        },
                    },
                },
            ],
        } as unknown as TransactionMetadata;

        const result = executor.parsePartialFill(
            meta,
            '75000',
            {
                currency: '524C555344000000000000000000000000000000',
                issuer: PAIR.quoteIssuer!,
                value: '0.10351875',
            },
            'SELL',
            1.38025
        );

        expect(result.baseFilled).toBeCloseTo(0.075, 8);
        expect(result.quoteFilled).toBeCloseTo(0.10351875, 8);
        expect(result.priceQuotePerBase).toBeCloseTo(1.38025, 5);
        expect(result.priceQuotePerBase).toBeGreaterThan(1.0);
        expect(result.priceQuotePerBase).not.toBeCloseTo(0.7245064299, 4);
    });
});
