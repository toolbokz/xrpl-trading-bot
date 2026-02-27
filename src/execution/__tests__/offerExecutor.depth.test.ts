import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { OfferExecutor } from '../offerExecutor';
import type { TradingPair } from '../../config';

const pair: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

function setReadyMarket(executor: OfferExecutor): void {
    executor.setCurrentMarketContext({
        midPrice: 1.02,
        bestBid: 1.019,
        bestAsk: 1.021,
        spreadBps: 20,
        bookAgeMs: 50,
        flowCombined: null,
        flowStrength: null,
        flowRegime: null,
    });
}

describe('OfferExecutor depth preflight', () => {
    beforeEach(() => {
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';
    });

    afterEach(() => {
        delete process.env.EXECUTION_DEPTH_LEVELS;
        delete process.env.EXECUTION_IOC_MIN_FILL_RATIO;
        delete process.env.EXECUTION_MIN_FILL_RATIO;
        delete process.env.FEATURE_EXECUTION_DEPTH_LEDGER_CURRENT;
        delete process.env.EXECUTION_SLIPPAGE_BPS_DEFAULT;
        delete process.env.EXECUTION_MAX_SLIPPAGE_BPS_VS_MID;
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
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
        setReadyMarket(executor);

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 0.5,
            flags: { fillOrKill: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('INSUFFICIENT_DEPTH');
        expect(client.autofill).not.toHaveBeenCalled();
        expect(client.submitAndWait).not.toHaveBeenCalled();
    });

    it('returns SKIP_NO_MARKET_DATA and never submits when orderbook is missing', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';

        const client = {
            request: vi.fn().mockResolvedValue({ result: { offers: [] } }),
            autofill: vi.fn(),
            submitAndWait: vi.fn(),
        } as any;

        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn(),
        } as any;

        const risk = {} as any;
        const executor = new OfferExecutor(client, wallet, risk, false, pair, undefined);
        setReadyMarket(executor);

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 0.5,
            flags: { immediateOrCancel: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('SKIP_NO_MARKET_DATA');
        expect(client.autofill).not.toHaveBeenCalled();
        expect(client.submitAndWait).not.toHaveBeenCalled();
    });

    it('allows IOC when depth meets configured IOC minimum fill ratio', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';
        process.env.EXECUTION_MIN_FILL_RATIO = '0.3';

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
        setReadyMarket(executor);

        const depth = await (executor as any).hasSufficientDepthAtPrice('BUY', 1.05, 0.5, { immediateOrCancel: true });
        expect(depth.orderType).toBe('IOC');
        expect(depth.hasDepth).toBe(true);
        expect(depth.fillableBase).toBeCloseTo(0.2, 8);
        expect(depth.minRequiredBase).toBeCloseTo(0.15, 8); // 0.5 * 0.3
    });

    it('uses ledger_index=current when FEATURE_EXECUTION_DEPTH_LEDGER_CURRENT is enabled', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';
        process.env.FEATURE_EXECUTION_DEPTH_LEDGER_CURRENT = 'true';

        const client = {
            request: vi.fn().mockResolvedValue({
                result: {
                    offers: [],
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
        setReadyMarket(executor);
        const depth = await (executor as any).hasSufficientDepthAtPrice('BUY', 1.05, 0.5, { immediateOrCancel: true });

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            command: 'book_offers',
            ledger_index: 'current',
        }));
        expect(depth.depthCheckSnapshot).toEqual(expect.objectContaining({
            ledger_index_mode: 'current',
            request_taker_gets_currency: 'XRP',
            request_taker_pays_currency: 'RLUSD',
        }));
    });

    it('aborts when partial sizing reduces amount below min size gate', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';
        process.env.EXECUTION_MIN_FILL_RATIO = '0.3';
        process.env.EXECUTION_MIN_BASE_XRP = '5';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '5';

        const client = {
            request: vi.fn().mockResolvedValue({
                result: {
                    offers: [
                        // ask price = 1.0 quote/base, base size 4 (below min gate after resize)
                        { TakerGets: '4000000', TakerPays: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '4.0' } },
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
        setReadyMarket(executor);

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 10,
            allowPartialSizing: true,
            flags: { immediateOrCancel: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('ABORT_BELOW_MIN');
        expect(client.autofill).not.toHaveBeenCalled();
        expect(client.submitAndWait).not.toHaveBeenCalled();
    });

    it('aborts when computed limit exceeds max slippage vs mid guard', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';
        process.env.EXECUTION_SLIPPAGE_BPS_DEFAULT = '10';
        process.env.EXECUTION_MAX_SLIPPAGE_BPS_VS_MID = '30';

        const client = {
            request: vi.fn().mockResolvedValue({
                result: {
                    offers: [
                        { TakerGets: '1000000', TakerPays: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '1.05' } },
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
        executor.setCurrentMarketContext({
            midPrice: 1.0,
            bestBid: 0.999,
            bestAsk: 1.001,
            spreadBps: 1,
            bookAgeMs: 50,
            flowCombined: null,
            flowStrength: null,
            flowRegime: null,
        });

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 1.0,
            flags: { fillOrKill: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('MAX_SLIPPAGE_VS_MID');
        expect(client.autofill).not.toHaveBeenCalled();
        expect(client.submitAndWait).not.toHaveBeenCalled();
    });
});
