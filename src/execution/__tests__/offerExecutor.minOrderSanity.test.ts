import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
    baseIssuer: '',
    issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

function buildClient(options?: {
    autofillPatch?: Record<string, unknown>;
    hash?: string;
}) {
    const hash = options?.hash ?? 'MIN_ORDER_SANITY_HASH';
    const client = {
        request: vi.fn().mockResolvedValue({
            result: {
                offers: [
                    {
                        TakerGets: '1000000',
                        TakerPays: {
                            currency: 'RLUSD',
                            issuer: pair.quoteIssuer,
                            value: '1.3900',
                        },
                    },
                ],
            },
        }),
        autofill: vi.fn().mockImplementation(async (tx: Record<string, unknown>) => ({
            ...tx,
            Fee: '12',
            Sequence: 88,
            LastLedgerSequence: 101,
            ...(options?.autofillPatch ?? {}),
        })),
        submit: vi.fn().mockResolvedValue({
            result: {
                hash,
                engine_result: 'tesSUCCESS',
                engine_result_code: 0,
                engine_result_message: 'simulated-tesSUCCESS',
                meta: {
                    TransactionResult: 'tesSUCCESS',
                    AffectedNodes: [],
                },
                tx_json: {
                    hash,
                },
                ledger_index: 123456,
            },
        }),
    };
    return { client, hash };
}

describe.sequential('OfferExecutor min-order sanity feature flag', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-min-order-sanity-'));
        process.chdir(tempDir);
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        vi.resetModules();
    });

    afterEach(async () => {
        delete process.env.FEATURE_EXECUTION_MIN_ORDER_SANITY;
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
        try {
            const { tradeMarkoutScheduler } = await import('../../analytics/tradeMarkoutScheduler');
            tradeMarkoutScheduler.stop();
        } catch {
            // best effort cleanup
        }
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('rejects before submit when XRP drops would underflow below 1 drop', async () => {
        process.env.FEATURE_EXECUTION_MIN_ORDER_SANITY = 'true';
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';

        const { OfferExecutor } = await import('../offerExecutor');
        const { tradeHistory } = await import('../../analytics/tradeHistory');
        const { feedbackEngine } = await import('../../analytics/feedbackEngine');
        const { client } = buildClient({
            autofillPatch: {
                TakerGets: {
                    currency: 'RLUSD',
                    issuer: pair.quoteIssuer,
                    value: '0.7',
                },
                TakerPays: '0.5',
            },
        });
        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn().mockReturnValue({
                tx_blob: 'DEADBEEF',
                hash: 'UNUSED_HASH',
            }),
        };
        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        };
        const feedbackSpy = vi.spyOn(feedbackEngine, 'recordTradeEvent').mockReturnValue('event-1');

        const executor = new OfferExecutor(client as any, wallet as any, risk as any, false, pair as any, undefined);
        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.4,
            amount: 0.5,
            expectedPrice: 1.4,
            strategy: 'min-order-sanity-test',
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('execution-min-order-sanity');
        expect(client.submit).not.toHaveBeenCalled();
        expect(wallet.sign).not.toHaveBeenCalled();

        const recent = tradeHistory.getRecentTrades(1)[0];
        expect(recent?.status).toBe('REJECTED');
        expect(recent?.trace?.outcome_reason).toBe('execution-min-order-sanity');

        expect(feedbackSpy).toHaveBeenCalledWith(expect.objectContaining({
            action: 'reject',
            resultCode: 'execution-min-order-sanity',
            error: 'execution-min-order-sanity:xrp-drops-underflow',
            intentSizeBase: expect.any(Number),
            intentSizeQuote: expect.any(Number),
        }));
    });

    it('rejects before submit when issued amount would underflow at serialization precision', async () => {
        process.env.FEATURE_EXECUTION_MIN_ORDER_SANITY = 'true';
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';

        const { OfferExecutor } = await import('../offerExecutor');
        const { feedbackEngine } = await import('../../analytics/feedbackEngine');
        const { client } = buildClient({
            autofillPatch: {
                TakerGets: {
                    currency: 'RLUSD',
                    issuer: pair.quoteIssuer,
                    value: '0.0000000000000000001',
                },
                TakerPays: '500000',
            },
        });
        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn().mockReturnValue({
                tx_blob: 'DEADBEEF',
                hash: 'UNUSED_HASH',
            }),
        };
        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        };
        const feedbackSpy = vi.spyOn(feedbackEngine, 'recordTradeEvent').mockReturnValue('event-2');

        const executor = new OfferExecutor(client as any, wallet as any, risk as any, false, pair as any, undefined);
        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.4,
            amount: 0.5,
            expectedPrice: 1.4,
            strategy: 'min-order-sanity-test',
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('execution-min-order-sanity');
        expect(client.submit).not.toHaveBeenCalled();
        expect(wallet.sign).not.toHaveBeenCalled();
        expect(feedbackSpy).toHaveBeenCalledWith(expect.objectContaining({
            action: 'reject',
            resultCode: 'execution-min-order-sanity',
            error: 'execution-min-order-sanity:iou-precision-underflow',
        }));
    });

    it('accepts normal-sized orders at 0.25 and 0.5 base when enabled', async () => {
        process.env.FEATURE_EXECUTION_MIN_ORDER_SANITY = 'true';
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';

        const { OfferExecutor } = await import('../offerExecutor');
        const { client, hash } = buildClient();
        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn().mockReturnValue({
                tx_blob: 'DEADBEEF',
                hash,
            }),
        };
        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        };

        const executor = new OfferExecutor(client as any, wallet as any, risk as any, false, pair as any, undefined);
        const resultQuarter = await executor.placeOffer({
            side: 'buy',
            price: 1.4,
            amount: 0.25,
            expectedPrice: 1.4,
            strategy: 'min-order-sanity-test',
        });
        const resultHalf = await executor.placeOffer({
            side: 'buy',
            price: 1.4,
            amount: 0.5,
            expectedPrice: 1.4,
            strategy: 'min-order-sanity-test',
        });

        expect(resultQuarter.accepted).toBe(true);
        expect(resultHalf.accepted).toBe(true);
        expect(client.submit).toHaveBeenCalledTimes(2);
    });
});
