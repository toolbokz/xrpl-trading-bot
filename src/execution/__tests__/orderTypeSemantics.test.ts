import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfferExecutor } from '../offerExecutor';
import type { TradingPair } from '../../config';
import { getExecutionOrderFlags } from '../orderType';

const pair: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

function createExecutor() {
    const client = {
        request: vi.fn(async (req: { command?: string; taker_gets?: { currency?: string } }) => {
            if (req.command === 'book_offers') {
                const getsCurrency = req.taker_gets?.currency;
                if (getsCurrency === 'XRP') {
                    return {
                        result: {
                            offers: [
                                { TakerGets: '1000000', TakerPays: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '1.0' } },
                            ],
                        },
                    };
                }
                return {
                    result: {
                        offers: [
                            { TakerGets: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '1.0' }, TakerPays: '1000000' },
                        ],
                    },
                };
            }
            return { result: {} };
        }),
        autofill: vi.fn(async (tx: Record<string, unknown>) => ({ ...tx, Fee: '12', Sequence: 1, LastLedgerSequence: 10 })),
        submitAndWait: vi.fn(async () => ({
            result: {
                hash: 'ABC123',
                engine_result: 'tesSUCCESS',
                engine_result_code: 0,
                engine_result_message: 'tesSUCCESS',
                tx_json: {},
                ledger_index: 100,
                meta: {
                    TransactionResult: 'tesSUCCESS',
                    AffectedNodes: [],
                },
            },
        })),
    } as any;

    const wallet = {
        classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        sign: vi.fn(() => ({ tx_blob: 'blob', hash: 'ABC123' })),
    } as any;

    const risk = {
        registerFailure: vi.fn(),
        resetFailures: vi.fn(),
    } as any;

    return { executor: new OfferExecutor(client, wallet, risk, false, pair, undefined), client };
}

describe('order type semantics', () => {
    beforeEach(() => {
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';
        process.env.EXECUTION_DEPTH_LEVELS = '5';
    });

    afterEach(() => {
        delete process.env.EXECUTION_ORDER_TYPE;
        delete process.env.EXECUTION_MIN_FILL_RATIO;
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
        delete process.env.EXECUTION_DEPTH_LEVELS;
        vi.restoreAllMocks();
    });

    it('FOK forces min_fill_ratio=1.0 for BUY and SELL depth checks', async () => {
        process.env.EXECUTION_ORDER_TYPE = 'FOK';
        process.env.EXECUTION_MIN_FILL_RATIO = '0.5';

        const { executor } = createExecutor();
        const buyDepth = await (executor as any).hasSufficientDepthAtPrice('BUY', 1.0, 1.0, getExecutionOrderFlags());
        const sellDepth = await (executor as any).hasSufficientDepthAtPrice('SELL', 1.0, 1.0, getExecutionOrderFlags());

        expect(buyDepth.depthCheckSnapshot.order_type).toBe('FOK');
        expect(buyDepth.depthCheckSnapshot.min_fill_ratio).toBe(1);
        expect(buyDepth.minRequiredBase).toBeCloseTo(1.0, 8);

        expect(sellDepth.depthCheckSnapshot.order_type).toBe('FOK');
        expect(sellDepth.depthCheckSnapshot.min_fill_ratio).toBe(1);
        expect(sellDepth.minRequiredBase).toBeCloseTo(1.0, 8);
    });

    it('IOC allows configurable min_fill_ratio=0.5 for BUY and SELL', async () => {
        process.env.EXECUTION_ORDER_TYPE = 'IOC';
        process.env.EXECUTION_MIN_FILL_RATIO = '0.5';

        const { executor } = createExecutor();
        const buyDepth = await (executor as any).hasSufficientDepthAtPrice('BUY', 1.0, 2.0, getExecutionOrderFlags());
        const sellDepth = await (executor as any).hasSufficientDepthAtPrice('SELL', 1.0, 2.0, getExecutionOrderFlags());

        expect(buyDepth.depthCheckSnapshot.order_type).toBe('IOC');
        expect(buyDepth.depthCheckSnapshot.min_fill_ratio).toBe(0.5);
        expect(buyDepth.minRequiredBase).toBeCloseTo(1.0, 8);

        expect(sellDepth.depthCheckSnapshot.order_type).toBe('IOC');
        expect(sellDepth.depthCheckSnapshot.min_fill_ratio).toBe(0.5);
        expect(sellDepth.minRequiredBase).toBeCloseTo(1.0, 8);
    });

    it('maps OfferCreate flags correctly (IOC vs FOK)', () => {
        process.env.EXECUTION_ORDER_TYPE = 'IOC';
        const { executor: iocExecutor } = createExecutor();
        const iocFlags = getExecutionOrderFlags();
        const iocRaw = (iocExecutor as any).mapFlags(iocFlags);
        expect((iocRaw & 0x00020000) !== 0).toBe(true);
        expect((iocRaw & 0x00040000) !== 0).toBe(false);

        process.env.EXECUTION_ORDER_TYPE = 'FOK';
        process.env.EXECUTION_MIN_FILL_RATIO = '1';
        const { executor: fokExecutor } = createExecutor();
        const fokFlags = getExecutionOrderFlags();
        const fokRaw = (fokExecutor as any).mapFlags(fokFlags);
        expect((fokRaw & 0x00040000) !== 0).toBe(true);
        expect((fokRaw & 0x00020000) !== 0).toBe(false);
    });
});
