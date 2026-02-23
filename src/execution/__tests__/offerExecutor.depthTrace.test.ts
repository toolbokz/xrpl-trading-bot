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

describe.sequential('OfferExecutor depth trace persistence', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-depth-trace-'));
        process.chdir(tempDir);
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        vi.resetModules();
    });

    afterEach(async () => {
        delete process.env.EXECUTION_DEPTH_LEVELS;
        delete process.env.EXECUTION_IOC_MIN_FILL_RATIO;
        delete process.env.FEATURE_EXECUTION_DEPTH_LEDGER_CURRENT;
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

    it('persists depth_check snapshot for insufficient-depth OfferCreate rejects', async () => {
        process.env.EXECUTION_DEPTH_LEVELS = '3';
        process.env.EXECUTION_IOC_MIN_FILL_RATIO = '1';
        process.env.FEATURE_EXECUTION_DEPTH_LEDGER_CURRENT = 'false';

        const { OfferExecutor } = await import('../offerExecutor');
        const { tradeHistory } = await import('../../analytics/tradeHistory');

        const client = {
            request: vi.fn().mockResolvedValue({
                result: {
                    offers: [
                        { TakerGets: '200000', TakerPays: { currency: 'RLUSD', issuer: pair.quoteIssuer, value: '0.204' } },
                    ],
                },
            }),
            autofill: vi.fn(),
            submit: vi.fn(),
            submitAndWait: vi.fn(),
        };

        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn(),
        };

        const risk = {} as any;
        const executor = new OfferExecutor(client as any, wallet as any, risk as any, false, pair as any, undefined);

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.0,
            amount: 0.5,
            flags: { fillOrKill: true },
            strategy: 'depth-trace-test',
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('insufficient-depth-at-price');
        expect(client.autofill).not.toHaveBeenCalled();
        expect(client.submit).not.toHaveBeenCalled();

        const recent = tradeHistory.getRecentTrades(1)[0];
        expect(recent?.status).toBe('REJECTED');
        expect(recent?.trace?.tx_type).toBe('OfferCreate');
        expect(recent?.trace?.depth_check).toEqual(expect.objectContaining({
            side: 'BUY',
            intended_price: 1.0,
            required_base: 0.5,
            min_required_base: 0.5,
            has_depth: false,
            ioc_min_fill_ratio: 1,
            depth_check_levels: 3,
            order_type: 'FOK',
            ledger_index_mode: 'validated',
            request_taker_gets_currency: 'XRP',
            request_taker_pays_currency: 'RLUSD',
            error: null,
        }));
        expect(recent?.trace?.depth_check?.fillable_base).toBe(0);
        expect(recent?.trace?.submit_result?.engine_result_message).toBe('insufficient-depth-at-price');
    });
});
