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

describe.sequential('OfferExecutor market-data readiness gate', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-market-data-gate-'));
        process.chdir(tempDir);
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        process.env.EXECUTION_MIN_BASE_XRP = '0';
        process.env.EXECUTION_MIN_QUOTE_RLUSD = '0';
        process.env.EXECUTION_BOOK_MAX_AGE_MS = '1500';
        vi.resetModules();
    });

    afterEach(async () => {
        delete process.env.EXECUTION_MIN_BASE_XRP;
        delete process.env.EXECUTION_MIN_QUOTE_RLUSD;
        delete process.env.EXECUTION_BOOK_MAX_AGE_MS;
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

    it('skips live order before depth-check/submit when market snapshot is missing', async () => {
        const { OfferExecutor } = await import('../offerExecutor');
        const { tradeHistory } = await import('../../analytics/tradeHistory');

        const client = {
            request: vi.fn().mockResolvedValue(null),
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
            flags: { immediateOrCancel: true },
            strategy: 'market-data-gate-test',
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('SKIP_NO_MARKET_DATA');
        expect(client.request).not.toHaveBeenCalled();
        expect(client.autofill).not.toHaveBeenCalled();
        expect(client.submit).not.toHaveBeenCalled();
        expect(client.submitAndWait).not.toHaveBeenCalled();

        const recent = tradeHistory.getRecentTrades(1)[0];
        expect(recent?.trace?.depth_check).toBeNull();
        expect(recent?.trace?.outcome).toBe('skipped');
        expect(recent?.trace?.outcome_reason).toBe('no_market_data');
        expect(recent?.trace?.baseline_source).toBe('market_data_missing');
    });
});
