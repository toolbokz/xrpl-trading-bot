import { describe, it, expect, vi, afterEach } from 'vitest';
import { OfferExecutor } from '../offerExecutor';
import type { TradingPair } from '../../config';

const pair: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

describe('OfferExecutor depth preflight', () => {
    afterEach(() => {
        delete process.env.EXECUTION_DEPTH_LEVELS;
        delete process.env.EXECUTION_IOC_MIN_FILL_RATIO;
    });

    it('skips order when depth is insufficient at intended price', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';

        const client = {
            request: vi.fn().mockResolvedValue({
                result: {
                    offers: [
                        // ask price = 1.02 quote/base, base size 0.2
                        { TakerGets: '200000', TakerPays: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '0.204' } },
                    ],
                },
            }),
            autofill: vi.fn(),
            submitAndWait: vi.fn(),
        } as any;

        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn(),
        } as any;

        const risk = {} as any;
        const executor = new OfferExecutor(client, wallet, risk, false, pair, undefined);

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 0.5,
            flags: { fillOrKill: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('insufficient-depth-at-price');
        expect(client.autofill).not.toHaveBeenCalled();
        expect(client.submitAndWait).not.toHaveBeenCalled();
    });

    it('allows IOC when depth meets configured IOC minimum fill ratio', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';
        process.env.EXECUTION_IOC_MIN_FILL_RATIO = '0.3';

        const client = {
            request: vi.fn().mockResolvedValue({
                result: {
                    offers: [
                        // ask price = 1.02 quote/base, base size 0.2
                        { TakerGets: '200000', TakerPays: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '0.204' } },
                    ],
                },
            }),
            autofill: vi.fn(),
            submitAndWait: vi.fn(),
        } as any;

        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn(),
        } as any;

        const risk = {} as any;
        const executor = new OfferExecutor(client, wallet, risk, false, pair, undefined);

        const depth = await (executor as any).hasSufficientDepthAtPrice('BUY', 1.05, 0.5, { immediateOrCancel: true });
        expect(depth.orderType).toBe('IOC');
        expect(depth.hasDepth).toBe(true);
        expect(depth.fillableBase).toBeCloseTo(0.2, 8);
        expect(depth.minRequiredBase).toBeCloseTo(0.15, 8); // 0.5 * 0.3
    });
});
