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

function buildClient() {
    const hash = 'PRICE_SANITY_TEST_HASH';
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
            // Intentionally distorted quote/base ratio to trigger sanity gate when enabled.
            TakerGets: {
                currency: 'RLUSD',
                issuer: pair.quoteIssuer,
                value: '1.0000',
            },
            TakerPays: '500000',
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

describe.sequential('OfferExecutor execution price sanity feature flag', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-price-sanity-'));
        process.chdir(tempDir);
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';
        vi.resetModules();
    });

    afterEach(async () => {
        delete process.env.FEATURE_EXECUTION_PRICE_SANITY;
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

    it('keeps legacy behavior when FEATURE_EXECUTION_PRICE_SANITY is disabled', async () => {
        process.env.FEATURE_EXECUTION_PRICE_SANITY = 'false';

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
        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.4,
            amount: 0.5,
            expectedPrice: 1.4,
            strategy: 'price-sanity-test',
        });

        expect(result.accepted).toBe(true);
        expect(client.submit).toHaveBeenCalledTimes(1);
    });

    it('rejects before submit when FEATURE_EXECUTION_PRICE_SANITY is enabled', async () => {
        process.env.FEATURE_EXECUTION_PRICE_SANITY = 'true';

        const { OfferExecutor } = await import('../offerExecutor');
        const { tradeHistory } = await import('../../analytics/tradeHistory');
        const { feedbackEngine } = await import('../../analytics/feedbackEngine');
        const { client } = buildClient();

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
            strategy: 'price-sanity-test',
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('execution-price-sanity');
        expect(client.submit).not.toHaveBeenCalled();
        expect(wallet.sign).not.toHaveBeenCalled();

        const recent = tradeHistory.getRecentTrades(1)[0];
        expect(recent).toBeTruthy();
        expect(recent?.status).toBe('REJECTED');
        expect(recent?.trace?.tx_type).toBe('OfferCreate');
        expect(recent?.trace?.offer_create).toEqual(expect.objectContaining({
            takerGets: expect.anything(),
            takerPays: expect.anything(),
        }));

        expect(feedbackSpy).toHaveBeenCalledWith(expect.objectContaining({
            action: 'reject',
            error: 'execution-price-sanity',
            fillPrice: expect.any(Number),
            slippageBpsVsIntent: expect.any(Number),
            slippageBpsVsMid: expect.any(Number),
        }));
    });
});
