import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfferExecutor } from '../offerExecutor';
import type { TradingPair } from '../../config';

const ORIGINAL_ENV = { ...process.env };

const pair: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

function createClientMock() {
    return {
        request: vi.fn(async (req: { command?: string }) => {
            if (req.command === 'ledger_current') {
                return { result: { ledger_current_index: 1000 } };
            }
            if (req.command === 'book_offers') {
                return {
                    result: {
                        offers: [
                            {
                                // ask price = 1.0 quote/base, base size = 1.5
                                TakerGets: '1500000',
                                TakerPays: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '1.5' },
                            },
                        ],
                    },
                };
            }
            return { result: {} };
        }),
        autofill: vi.fn(async (tx: Record<string, unknown>) => ({
            ...tx,
            Fee: '12',
            Sequence: 101,
            LastLedgerSequence: 1008,
        })),
        submitAndWait: vi.fn(async () => ({
            result: {
                hash: 'ABC123',
                engine_result: 'tesSUCCESS',
                meta: {
                    TransactionResult: 'tesSUCCESS',
                    AffectedNodes: [],
                },
                tx_json: {},
                ledger_index: 1001,
            },
        })),
    } as any;
}

function createWalletMock() {
    return {
        classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        sign: vi.fn(() => ({
            tx_blob: 'DEADBEEF',
            hash: 'ABC123',
        })),
    } as any;
}

function createRiskMock() {
    return {
        registerFailure: vi.fn(),
        resetFailures: vi.fn(),
    } as any;
}

describe('OfferExecutor idempotency guard', () => {
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        vi.restoreAllMocks();
    });

    it('blocks duplicate offer submissions inside idempotency window when audit guards are enabled', async () => {
        process.env.ADAPTIVE_LEARNING_ENABLED = 'false';
        process.env.FEATURE_AUDIT_GUARDS = '1';
        process.env.EXECUTION_IDEMPOTENCY_WINDOW_MS = '60000';
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';

        const client = createClientMock();
        const wallet = createWalletMock();
        const risk = createRiskMock();
        const executor = new OfferExecutor(client, wallet, risk, false, pair, undefined);
        executor.setCurrentMarketContext({
            midPrice: 1.0, bestBid: 0.99, bestAsk: 1.01,
            spreadBps: 20, bookAgeMs: 100,
            flowCombined: null, flowStrength: null, flowRegime: null,
        });

        const first = await executor.placeOffer({
            side: 'buy',
            price: 1,
            amount: 1,
            flags: { immediateOrCancel: true },
        });

        const second = await executor.placeOffer({
            side: 'buy',
            price: 1,
            amount: 1,
            flags: { immediateOrCancel: true },
        });

        expect(first.accepted).toBe(true);
        expect(second.accepted).toBe(false);
        expect(second.reason).toBe('idempotency-duplicate-prevented');
        expect(client.submitAndWait).toHaveBeenCalledTimes(1);
    });

    it('does not block duplicate submissions when audit guards are disabled', async () => {
        process.env.ADAPTIVE_LEARNING_ENABLED = 'false';
        process.env.FEATURE_AUDIT_GUARDS = '0';
        process.env.EXECUTION_IDEMPOTENCY_WINDOW_MS = '60000';
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';

        const client = createClientMock();
        const wallet = createWalletMock();
        const risk = createRiskMock();
        const executor = new OfferExecutor(client, wallet, risk, false, pair, undefined);
        executor.setCurrentMarketContext({
            midPrice: 1.0, bestBid: 0.99, bestAsk: 1.01,
            spreadBps: 20, bookAgeMs: 100,
            flowCombined: null, flowStrength: null, flowRegime: null,
        });

        const first = await executor.placeOffer({
            side: 'buy',
            price: 1,
            amount: 1,
            flags: { immediateOrCancel: true },
        });
        const second = await executor.placeOffer({
            side: 'buy',
            price: 1,
            amount: 1,
            flags: { immediateOrCancel: true },
        });

        expect(first.accepted).toBe(true);
        expect(second.accepted).toBe(true);
        expect(client.submitAndWait).toHaveBeenCalledTimes(2);
    });
});
