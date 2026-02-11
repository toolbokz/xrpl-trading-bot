import { describe, expect, it, vi } from 'vitest';
import { ScanScheduler } from '../scanScheduler';

describe('ScanScheduler', () => {
    it('enforces SCANNER_MAX_RPS budget with round-robin batches', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const scheduler = new ScanScheduler({
            maxRps: 2,
            tier1IntervalMs: 3000,
            tier2IntervalMs: 15000,
            maxBatchSize: 3,
        });

        scheduler.setUniverse(['XRP/USDC', 'XRP/USD'], ['XRP/USDT', 'XRP/RLUSD'], Date.now());

        const batchA = scheduler.nextBatch(Date.now());
        expect(batchA.length).toBeLessThanOrEqual(2);

        const batchB = scheduler.nextBatch(Date.now());
        expect(batchB).toEqual([]);

        vi.advanceTimersByTime(500);
        const batchC = scheduler.nextBatch(Date.now());
        expect(batchC.length).toBeLessThanOrEqual(1);

        vi.advanceTimersByTime(500);
        const batchD = scheduler.nextBatch(Date.now());
        expect(batchD.length).toBeLessThanOrEqual(1);

        const all = [...batchA, ...batchC, ...batchD];
        expect(new Set(all).size).toBeGreaterThan(1);

        vi.useRealTimers();
    });
});
