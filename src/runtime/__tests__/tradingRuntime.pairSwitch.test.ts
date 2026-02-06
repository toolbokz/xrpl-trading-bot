import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { TradingRuntime } from '../tradingRuntime';

const ORIG_LOCAL_ONLY = process.env.BOT_LOCAL_ONLY;

describe('TradingRuntime pair switching', () => {
    beforeEach(() => {
        process.env.BOT_LOCAL_ONLY = 'true';
    });

    it('is idempotent when switching to active pair', () => {
        const runtime = new TradingRuntime();
        const active = runtime.getActivePair();

        const result = runtime.setActivePair(active);
        expect(result.success).toBe(true);
        expect(result.activePair).toBe(active);
        expect(runtime.getActivePair()).toBe(active);
    });

    it('rejects invalid pair key and keeps current active pair', () => {
        const runtime = new TradingRuntime();
        const before = runtime.getActivePair();

        const result = runtime.setActivePair('XRP/INVALID');

        expect(result.success).toBe(false);
        expect(result.activePair).toBe(before);
        expect(runtime.getActivePair()).toBe(before);
    });

    it('rolls back active pair if switching fails during apply', () => {
        const runtime = new TradingRuntime();
        const before = runtime.getActivePair();

        (runtime as any).tradeTape = {
            setPair: () => {
                throw new Error('boom');
            },
        };

        const result = runtime.setActivePair('XRP/USDC');

        expect(result.success).toBe(false);
        expect(result.activePair).toBe(before);
        expect(runtime.getActivePair()).toBe(before);
    });
});

afterAll(() => {
    if (ORIG_LOCAL_ONLY === undefined) {
        delete process.env.BOT_LOCAL_ONLY;
    } else {
        process.env.BOT_LOCAL_ONLY = ORIG_LOCAL_ONLY;
    }
});
