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

describe.sequential('depth reprice behavior', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-depth-reprice-targeted-'));
        process.chdir(tempDir);
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        process.env.FEATURE_EXECUTION_DEPTH_REPRICE = 'true';
        process.env.EXECUTION_REPRICE_MAX_BPS = '3';
        process.env.EXECUTION_SLIPPAGE_BPS_DEFAULT = '1';
        process.env.EXECUTION_MIN_FILL_RATIO = '1';
        process.env.EXECUTION_DEPTH_LEVELS = '5';
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';
        vi.resetModules();
    });

    afterEach(async () => {
        delete process.env.FEATURE_EXECUTION_DEPTH_REPRICE;
        delete process.env.EXECUTION_REPRICE_MAX_BPS;
        delete process.env.EXECUTION_SLIPPAGE_BPS_DEFAULT;
        delete process.env.EXECUTION_MIN_FILL_RATIO;
        delete process.env.EXECUTION_DEPTH_LEVELS;
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

    it('repricing within max bps flips decision to reprice', async () => {
        const { OfferExecutor } = await import('../offerExecutor');
        const { tradeHistory } = await import('../../analytics/tradeHistory');

        const client = {
            request: vi.fn().mockImplementation(async (req: { command: string }) => {
                if (req.command === 'book_offers') {
                    return {
                        result: {
                            offers: [
                                { TakerGets: '4000000', TakerPays: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '4' } },
                                { TakerGets: '6000000', TakerPays: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '6.0012' } },
                            ],
                        },
                    };
                }
                if (req.command === 'ledger_current') {
                    return { result: { ledger_current_index: 100 } };
                }
                if (req.command === 'tx') {
                    return {
                        result: {
                            validated: true,
                            ledger_index: 101,
                            date: 800000000,
                            meta: {
                                TransactionResult: 'tesSUCCESS',
                                AffectedNodes: [],
                            },
                            tx_json: {
                                hash: 'DEPTH_REPRICE_TARGETED_HASH',
                            },
                        },
                    };
                }
                return { result: {} };
            }),
            autofill: vi.fn().mockImplementation(async (tx: Record<string, unknown>) => ({
                ...tx,
                Fee: '12',
                Sequence: 101,
                LastLedgerSequence: 120,
            })),
            submit: vi.fn().mockResolvedValue({
                result: {
                    hash: 'DEPTH_REPRICE_TARGETED_HASH',
                    engine_result: 'tesSUCCESS',
                    engine_result_code: 0,
                    engine_result_message: 'The transaction was applied.',
                    meta: {
                        TransactionResult: 'tesSUCCESS',
                        AffectedNodes: [],
                    },
                    tx_json: {
                        hash: 'DEPTH_REPRICE_TARGETED_HASH',
                    },
                    ledger_index: 101,
                },
            }),
        };

        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn().mockReturnValue({
                tx_blob: 'DEADBEEF',
                hash: 'DEPTH_REPRICE_TARGETED_HASH',
            }),
        };

        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        };

        const executor = new OfferExecutor(client as any, wallet as any, risk as any, false, pair as any, undefined);
        executor.setCurrentMarketContext({
            midPrice: 1.0,
            bestBid: 0.999,
            bestAsk: 1.001,
            spreadBps: 20,
            bookAgeMs: 50,
            flowCombined: null,
            flowStrength: null,
            flowRegime: null,
        });

        await executor.placeOffer({
            side: 'buy',
            price: 1,
            amount: 10,
            flags: { fillOrKill: true },
            strategy: 'depth-reprice-targeted',
        });

        const recent = tradeHistory.getRecentTrades(1)[0];
        expect(recent?.trace?.depth_reprice?.decision).toBe('reprice');
        expect(recent?.trace?.depth_reprice?.required_reprice_bps).not.toBeNull();
        expect((recent?.trace?.depth_reprice?.required_reprice_bps ?? 0)).toBeLessThanOrEqual(3);
    });

    it('repricing over max bps marks skip_too_far and aborts safely', async () => {
        process.env.EXECUTION_REPRICE_MAX_BPS = '1';
        const { OfferExecutor } = await import('../offerExecutor');
        const { tradeHistory } = await import('../../analytics/tradeHistory');

        const client = {
            request: vi.fn().mockResolvedValue({
                result: {
                    offers: [
                        { TakerGets: '4000000', TakerPays: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '4' } },
                        { TakerGets: '6000000', TakerPays: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '6.003' } },
                    ],
                },
            }),
            autofill: vi.fn(),
            submit: vi.fn(),
        };

        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn(),
        };

        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        };

        const executor = new OfferExecutor(client as any, wallet as any, risk as any, false, pair as any, undefined);
        executor.setCurrentMarketContext({
            midPrice: 1.0,
            bestBid: 0.999,
            bestAsk: 1.001,
            spreadBps: 20,
            bookAgeMs: 50,
            flowCombined: null,
            flowStrength: null,
            flowRegime: null,
        });

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1,
            amount: 10,
            flags: { fillOrKill: true },
            strategy: 'depth-reprice-targeted',
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('SKIP_INSUFFICIENT_DEPTH');
        const recent = tradeHistory.getRecentTrades(1)[0];
        expect(recent?.trace?.depth_reprice?.decision).toBe('skip_too_far');
    });

    it('uses asks for BUY and bids for SELL in reprice computation', async () => {
        const { computeRepriceToMeetMinFill } = await import('../offerExecutor');

        const buyResult = computeRepriceToMeetMinFill({
            side: 'BUY',
            intendedPrice: 1,
            minRequiredBase: 10,
            maxRepriceBps: 3,
            offers: [
                { TakerGets: '4000000', TakerPays: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '4' } },
                { TakerGets: '6000000', TakerPays: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '6.0012' } },
            ],
        });

        const sellResult = computeRepriceToMeetMinFill({
            side: 'SELL',
            intendedPrice: 1,
            minRequiredBase: 10,
            maxRepriceBps: 3,
            offers: [
                { TakerGets: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '4' }, TakerPays: '4000000' },
                { TakerGets: { currency: pair.quoteCurrency, issuer: pair.quoteIssuer, value: '5.9988' }, TakerPays: '6000000' },
            ],
        });

        expect(buyResult.repricedPrice).toBeCloseTo(1.00012, 8);
        expect(sellResult.repricedPrice).toBeCloseTo(0.99988, 8);
        expect(buyResult.requiredRepriceBps).toBeCloseTo(1.2, 8);
        expect(sellResult.requiredRepriceBps).toBeCloseTo(1.2, 8);
    });
});
