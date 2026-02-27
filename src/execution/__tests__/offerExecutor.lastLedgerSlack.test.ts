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

function buildClient(ledgerCurrentIndex: number) {
    const hash = 'LLS_SLACK_TEST_HASH';
    const client = {
        request: vi.fn().mockImplementation(async (req: Record<string, unknown>) => {
            if (req.command === 'ledger_current') {
                return {
                    result: {
                        ledger_current_index: ledgerCurrentIndex,
                    },
                };
            }
            if (req.command === 'book_offers') {
                return {
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
                };
            }
            throw new Error(`Unsupported command in test client: ${String(req.command)}`);
        }),
        autofill: vi.fn().mockImplementation(async (tx: Record<string, unknown>) => ({
            ...tx,
            Fee: '12',
            Sequence: 77,
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

describe.sequential('OfferExecutor LastLedgerSequence slack feature flag', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-lls-slack-'));
        process.chdir(tempDir);
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';
        vi.resetModules();
    });

    afterEach(async () => {
        delete process.env.FEATURE_EXECUTION_LLS_SLACK;
        delete process.env.EXECUTION_LAST_LEDGER_SLACK;
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

    it('keeps legacy +4 LastLedgerSequence when feature flag is disabled', async () => {
        process.env.FEATURE_EXECUTION_LLS_SLACK = 'false';
        process.env.EXECUTION_LAST_LEDGER_SLACK = '11';

        const { OfferExecutor } = await import('../offerExecutor');
        const { client } = buildClient(700_000);
        const executor = new OfferExecutor(
            client as any,
            null,
            { registerFailure: vi.fn(), resetFailures: vi.fn() } as any,
            false,
            pair as any,
            undefined,
        );

        const computed = await (executor as any).computeLastLedgerSequence();
        expect(computed).toBe(700_004);
    });

    it('uses default slack=8 when enabled and persists it in trace.offer_create.lastLedgerSequence', async () => {
        process.env.FEATURE_EXECUTION_LLS_SLACK = 'true';
        delete process.env.EXECUTION_LAST_LEDGER_SLACK;

        const { OfferExecutor } = await import('../offerExecutor');
        const { tradeHistory } = await import('../../analytics/tradeHistory');
        const { client, hash } = buildClient(900_100);
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
        executor.setCurrentMarketContext({
            midPrice: 1.39, bestBid: 1.38, bestAsk: 1.40,
            spreadBps: 14, bookAgeMs: 100,
            flowCombined: null, flowStrength: null, flowRegime: null,
        });
        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.4,
            amount: 0.5,
            expectedPrice: 1.4,
            strategy: 'lls-slack-test',
        });

        expect(result.accepted).toBe(true);
        expect(client.autofill).toHaveBeenCalledTimes(1);
        expect(client.autofill.mock.calls[0][0].LastLedgerSequence).toBe(900_108);

        const recent = tradeHistory.getRecentTrades(1)[0];
        expect(recent?.trace?.offer_create?.lastLedgerSequence).toBe(900_108);
    });

    it('clamps EXECUTION_LAST_LEDGER_SLACK to [4, 12] when feature is enabled', async () => {
        process.env.FEATURE_EXECUTION_LLS_SLACK = 'true';

        const { OfferExecutor } = await import('../offerExecutor');

        process.env.EXECUTION_LAST_LEDGER_SLACK = '1';
        const lowExecutor = new OfferExecutor(
            buildClient(10_000).client as any,
            null,
            { registerFailure: vi.fn(), resetFailures: vi.fn() } as any,
            false,
            pair as any,
            undefined,
        );
        expect(await (lowExecutor as any).computeLastLedgerSequence()).toBe(10_004);

        process.env.EXECUTION_LAST_LEDGER_SLACK = '99';
        const highExecutor = new OfferExecutor(
            buildClient(20_000).client as any,
            null,
            { registerFailure: vi.fn(), resetFailures: vi.fn() } as any,
            false,
            pair as any,
            undefined,
        );
        expect(await (highExecutor as any).computeLastLedgerSequence()).toBe(20_012);
    });
});
