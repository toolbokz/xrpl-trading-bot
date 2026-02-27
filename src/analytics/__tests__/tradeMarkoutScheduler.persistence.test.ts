import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe.sequential('tradeMarkoutScheduler persistence/resume', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-markout-'));
        process.chdir(tempDir);
        fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        vi.resetModules();
    });

    afterEach(async () => {
        try {
            const { tradeMarkoutScheduler } = await import('../tradeMarkoutScheduler');
            tradeMarkoutScheduler.stop();
        } catch {
            // best effort cleanup
        }
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('persists pending markouts, resumes after restart, and records explicit missing reasons', async () => {
        const { tradeHistory } = await import('../tradeHistory');
        const {
            tradeMarkoutScheduler,
            TRADE_MARKOUT_PENDING_FILE,
        } = await import('../tradeMarkoutScheduler');

        const filledTrade = tradeHistory.recordTrade({
            pair: 'XRP/RLUSD',
            side: 'BUY',
            price: 1.4,
            priceQuotePerBase: 1.4,
            amount: 0.5,
            amountBase: 0.5,
            filled: 0.5,
            filledBase: 0.5,
            filledQuote: 0.7,
            fee: 0.000012,
            pnl: 0,
            hash: 'MARKOUT_TX_HASH_001',
            paper: false,
            status: 'FILLED',
            source: 'bot',
        });

        tradeHistory.upsertTradeTrace({
            hash: filledTrade.hash,
            tradeId: filledTrade.id,
            patch: {
                decision_ts_ms: Date.now() - 10_000,
                submit_ts_ms: Date.now() - 9_000,
                ack_ts_ms: Date.now() - 8_000,
                validated_ts_ms: Date.now() - 7_000,
                validated_ledger_index: 900010,
                validated_ledger_time: Date.now() - 7_000,
                tx_hash: filledTrade.hash,
                ack_status: 'accepted',
                outcome: 'filled',
                outcome_reason: null,
            },
        });

        const lifecycleEvents: Array<{ event_type: string; detail: Record<string, unknown> }> = [];
        tradeMarkoutScheduler.setHooks({
            emit_event: (event) => lifecycleEvents.push({
                event_type: event.event_type,
                detail: event.detail,
            }),
        });
        tradeMarkoutScheduler.start();

        const fillTsMs = Date.now();
        tradeMarkoutScheduler.schedule({
            trade_id: filledTrade.id,
            tx_hash: filledTrade.hash!,
            pair_key: 'XRP/RLUSD',
            side: 'buy',
            fill_price: 1.4,
            fill_ts_ms: fillTsMs,
            horizons_s: [120],
        });

        expect(fs.existsSync(TRADE_MARKOUT_PENDING_FILE)).toBe(true);
        const persistedRaw = JSON.parse(fs.readFileSync(TRADE_MARKOUT_PENDING_FILE, 'utf8')) as Array<Record<string, unknown>>;
        expect(persistedRaw.length).toBeGreaterThan(0);

        // Simulate restart: stop scheduler, mutate pending job to be overdue+expired, then start again.
        tradeMarkoutScheduler.stop();
        const expiredJobs = persistedRaw.map((job) => ({
            ...job,
            due_ts_ms: Date.now() - 5_000,
            expires_ts_ms: Date.now() - 1_000,
            attempts: 5,
        }));
        fs.writeFileSync(TRADE_MARKOUT_PENDING_FILE, JSON.stringify(expiredJobs, null, 2), 'utf8');

        tradeMarkoutScheduler.start();
        await new Promise((resolve) => setTimeout(resolve, 80));

        const updatedTrade = tradeHistory.getTradeByHash('MARKOUT_TX_HASH_001');
        expect(updatedTrade).toBeTruthy();
        expect(updatedTrade?.trace).toBeTruthy();
        expect(Array.isArray(updatedTrade?.trace?.markouts)).toBe(true);
        expect(updatedTrade?.trace?.markouts.length).toBeGreaterThan(0);

        const missing = updatedTrade?.trace?.markouts[0];
        expect(missing?.status).toBe('missing');
        expect(missing?.missing_reason).toBe('timeout');

        const eventTypes = lifecycleEvents.map((e) => e.event_type);
        expect(eventTypes).toContain('MARKOUT_SCHEDULED');
        expect(eventTypes).toContain('MARKOUT_MISSING');

        const remaining = JSON.parse(fs.readFileSync(TRADE_MARKOUT_PENDING_FILE, 'utf8')) as unknown[];
        expect(remaining.length).toBe(0);
    });
});
