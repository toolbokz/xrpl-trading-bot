import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfferExecutor } from '../offerExecutor';
import type { TradingPair } from '../../config';

const pair: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

function makeDepth(
    fillableBase: number,
    limitPrice: number,
    requiredBaseAmount: number,
    minRequiredBaseOverride?: number,
): any {
    const minRequiredBase = Number.isFinite(minRequiredBaseOverride)
        ? (minRequiredBaseOverride as number)
        : requiredBaseAmount * 0.5;
    return {
        hasDepth: fillableBase + 1e-12 >= minRequiredBase,
        fillableBase,
        requiredBaseAmount,
        minRequiredBase,
        orderType: 'IOC',
        limitPrice,
        expectedVwap: limitPrice,
        worstPrice: limitPrice,
        midSlippageAllowed: true,
        midSlippageBps: 0,
        offers: [],
        depthCheckSnapshot: {
            side: 'BUY',
            intended_price: limitPrice,
            required_base: requiredBaseAmount,
            min_required_base: minRequiredBase,
            fillable_base: fillableBase,
            vwap: limitPrice,
            worst_price: limitPrice,
            limit_price: limitPrice,
            has_depth: fillableBase + 1e-12 >= minRequiredBase,
            min_fill_ratio: 0.5,
            depth_check_levels: 5,
            order_type: 'IOC',
            side_used: 'BUY',
            snapshot_age_ms: 25,
            ledger_index_mode: 'validated',
            request_taker_gets_currency: 'XRP',
            request_taker_pays_currency: 'RLUSD',
            error: null,
        },
    };
}

function createExecutor(submitResults: string[]): {
    executor: OfferExecutor;
    client: {
        autofill: ReturnType<typeof vi.fn>;
        submitAndWait: ReturnType<typeof vi.fn>;
    };
} {
    let sequence = 1;
    let submitIndex = 0;

    const client = {
        autofill: vi.fn().mockImplementation(async (tx: any) => ({
            ...tx,
            Fee: '12',
            Sequence: sequence++,
        })),
        submitAndWait: vi.fn().mockImplementation(async () => {
            const engine = submitResults[Math.min(submitIndex, submitResults.length - 1)] ?? 'tecKILLED';
            submitIndex += 1;
            return {
                result: {
                    hash: `HASH_${submitIndex}`,
                    engine_result: engine,
                    engine_result_code: engine === 'tesSUCCESS' ? 0 : -1,
                    engine_result_message: `simulated-${engine}`,
                    tx_json: {},
                    ledger_index: 100 + submitIndex,
                    meta: {
                        TransactionResult: engine,
                        AffectedNodes: [],
                    },
                },
            };
        }),
    };

    const wallet = {
        classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        sign: vi.fn().mockImplementation((prepared: any) => ({
            tx_blob: `blob-${prepared.Sequence ?? 0}`,
            hash: `SIGNED_${prepared.Sequence ?? 0}`,
        })),
    };

    const risk = {
        registerFailure: vi.fn(),
        resetFailures: vi.fn(),
    };

    const executor = new OfferExecutor(client as any, wallet as any, risk as any, false, pair, undefined);
    executor.setCurrentMarketContext({
        midPrice: 1.0, bestBid: 0.99, bestAsk: 1.01,
        spreadBps: 20, bookAgeMs: 100,
        flowCombined: null, flowStrength: null, flowRegime: null,
    });
    (executor as any).waitMs = vi.fn().mockResolvedValue(undefined);

    return { executor, client };
}

describe('OfferExecutor IOC retry policy', () => {
    beforeEach(() => {
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';
        process.env.EXECUTION_RETRY_MAX_ATTEMPTS = '3';
        process.env.EXECUTION_RETRY_SLIPPAGE_STEP_BPS = '5';
        process.env.EXECUTION_RETRY_MAX_SLIPPAGE_BPS = '25';
        process.env.EXECUTION_SLIPPAGE_BPS_DEFAULT = '5';
    });

    afterEach(() => {
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
        delete process.env.EXECUTION_RETRY_MAX_ATTEMPTS;
        delete process.env.EXECUTION_RETRY_SLIPPAGE_STEP_BPS;
        delete process.env.EXECUTION_RETRY_MAX_SLIPPAGE_BPS;
        delete process.env.EXECUTION_SLIPPAGE_BPS_DEFAULT;
        vi.restoreAllMocks();
    });

    it('tecKILLED triggers retry with increased slippage', async () => {
        process.env.EXECUTION_RETRY_MAX_ATTEMPTS = '2';

        const { executor, client } = createExecutor(['tecKILLED', 'tecKILLED']);
        const depthSpy = vi.fn()
            .mockImplementation(async (_side: string, _price: number, amount: number, _flags: unknown, _slippageBps: number) => makeDepth(10, 1.0, amount));
        (executor as any).hasSufficientDepthAtPrice = depthSpy;

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 10,
            flags: { immediateOrCancel: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('tecKILLED');
        expect(client.submitAndWait).toHaveBeenCalledTimes(2);
        expect(depthSpy.mock.calls.map((call) => call[4])).toEqual([5, 10]);
    });

    it('retries stop at max attempts', async () => {
        process.env.EXECUTION_RETRY_MAX_ATTEMPTS = '3';

        const { executor, client } = createExecutor(['tecKILLED', 'tecKILLED', 'tecKILLED', 'tecKILLED']);
        (executor as any).hasSufficientDepthAtPrice = vi.fn()
            .mockImplementation(async (_side: string, _price: number, amount: number) => makeDepth(10, 1.0, amount));

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 10,
            flags: { immediateOrCancel: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('tecKILLED');
        expect(client.submitAndWait).toHaveBeenCalledTimes(3);
    });

    it('size shrink stops when below min', async () => {
        process.env.EXECUTION_MIN_BASE_XRP = '5';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '5';

        const { executor, client } = createExecutor(['tecKILLED']);
        const depthSpy = vi.fn()
            .mockImplementationOnce(async (_side: string, _price: number, amount: number) => makeDepth(10, 1.0, amount))
            .mockImplementationOnce(async (_side: string, _price: number, amount: number) => makeDepth(4.5, 1.0, amount, 1));
        (executor as any).hasSufficientDepthAtPrice = depthSpy;

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 10,
            allowPartialSizing: true,
            flags: { immediateOrCancel: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('ABORT_BELOW_MIN');
        expect(client.submitAndWait).toHaveBeenCalledTimes(1);
        expect(depthSpy).toHaveBeenCalledTimes(2);
    });

    it('fatal engine_result does not retry', async () => {
        const { executor, client } = createExecutor(['tefPAST_SEQ']);
        const depthSpy = vi.fn()
            .mockImplementation(async (_side: string, _price: number, amount: number) => makeDepth(10, 1.0, amount));
        (executor as any).hasSufficientDepthAtPrice = depthSpy;

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 10,
            flags: { immediateOrCancel: true },
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('tefPAST_SEQ');
        expect(client.submitAndWait).toHaveBeenCalledTimes(1);
        expect(depthSpy).toHaveBeenCalledTimes(1);
    });
});
