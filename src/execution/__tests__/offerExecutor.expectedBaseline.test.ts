import { describe, expect, it } from 'vitest';
import type { TradingPair } from '../../config';
import { computeCanonicalSlippageBps } from '../../analytics/slippageMath';
import { OfferExecutor } from '../offerExecutor';

const PAIR: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rQuoteIssuer1111111111111111111111111',
    issuer: 'rQuoteIssuer1111111111111111111111111',
};

describe('OfferExecutor expected baseline', () => {
    it('uses best ask for BUY expected price in quote_per_base convention', () => {
        const executor = new OfferExecutor(
            {} as any,
            null,
            { registerFailure() { }, resetFailures() { } } as any,
            false,
            PAIR
        );

        executor.setCurrentMarketContext({
            midPrice: 1.405,
            bestBid: 1.404,
            bestAsk: 1.406,
            spreadBps: 14.23,
            bookAgeMs: 150,
            flowCombined: null,
            flowStrength: null,
            flowRegime: null,
        });

        const baseline = (executor as any).resolveExpectedBaseline({
            side: 'buy',
            intentPrice: 1.41,
            expectedPrice: 1.41,
            decisionTsMs: 1000,
            submitTsMs: 1100,
        });

        expect(baseline.expectedPrice).toBeCloseTo(1.406, 8);
        expect(baseline.expectedRule).toBe('BUY->best_ask');
        expect(baseline.priceConvention).toBe('quote_per_base');
        expect(baseline.baselineSource).toBe('orderbook_snapshot');
        expect(baseline.orderingValid).toBe(true);

        // Worse BUY fill than expected ask should be positive slippage.
        const adverse = computeCanonicalSlippageBps('buy', baseline.expectedPrice, 1.407);
        // Better BUY fill than expected ask should be negative slippage.
        const improved = computeCanonicalSlippageBps('buy', baseline.expectedPrice, 1.405);
        expect(adverse).toBeGreaterThan(0);
        expect(improved).toBeLessThan(0);
    });

    it('uses best bid for SELL expected price', () => {
        const executor = new OfferExecutor(
            {} as any,
            null,
            { registerFailure() { }, resetFailures() { } } as any,
            false,
            PAIR
        );

        executor.setCurrentMarketContext({
            midPrice: 1.405,
            bestBid: 1.404,
            bestAsk: 1.406,
            spreadBps: 14.23,
            bookAgeMs: 90,
            flowCombined: null,
            flowStrength: null,
            flowRegime: null,
        });

        const baseline = (executor as any).resolveExpectedBaseline({
            side: 'sell',
            intentPrice: 1.40,
            expectedPrice: 1.40,
            decisionTsMs: 2000,
            submitTsMs: 2100,
        });

        expect(baseline.expectedPrice).toBeCloseTo(1.404, 8);
        expect(baseline.expectedRule).toBe('SELL->best_bid');
        expect(baseline.priceConvention).toBe('quote_per_base');
        expect(baseline.baselineSource).toBe('orderbook_snapshot');
        expect(baseline.orderingValid).toBe(true);
    });
});
