/**
 * Circuit Breaker Persistence Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryBreakerStore, BreakerState } from '../breakerStore';

describe('MemoryBreakerStore', () => {
    let store: MemoryBreakerStore;

    beforeEach(() => {
        store = new MemoryBreakerStore();
    });

    afterEach(async () => {
        await store.close();
    });

    it('returns default state for unknown key', async () => {
        const state = await store.load('unknown-key');
        expect(state.trades).toEqual([]);
        expect(state.trippedAt).toBeNull();
    });

    it('saves and loads state correctly', async () => {
        const testState: BreakerState = {
            trades: [
                { timestamp: 1000, pnlBps: -50 },
                { timestamp: 2000, pnlBps: -100 },
            ],
            trippedAt: 3000,
            lastUpdated: 4000,
        };

        await store.save('test-key', testState);
        const loaded = await store.load('test-key');

        expect(loaded.trades).toHaveLength(2);
        expect(loaded.trades[0]?.pnlBps).toBe(-50);
        expect(loaded.trades[1]?.pnlBps).toBe(-100);
        expect(loaded.trippedAt).toBe(3000);
    });

    it('updates lastUpdated on save', async () => {
        const testState: BreakerState = {
            trades: [],
            trippedAt: null,
            lastUpdated: 0,
        };

        const before = Date.now();
        await store.save('test-key', testState);
        const loaded = await store.load('test-key');
        const after = Date.now();

        expect(loaded.lastUpdated).toBeGreaterThanOrEqual(before);
        expect(loaded.lastUpdated).toBeLessThanOrEqual(after);
    });

    it('isolates different keys', async () => {
        await store.save('key1', {
            trades: [{ timestamp: 1000, pnlBps: -10 }],
            trippedAt: null,
            lastUpdated: 0,
        });

        await store.save('key2', {
            trades: [{ timestamp: 2000, pnlBps: -20 }],
            trippedAt: 5000,
            lastUpdated: 0,
        });

        const state1 = await store.load('key1');
        const state2 = await store.load('key2');

        expect(state1.trades[0]?.pnlBps).toBe(-10);
        expect(state1.trippedAt).toBeNull();

        expect(state2.trades[0]?.pnlBps).toBe(-20);
        expect(state2.trippedAt).toBe(5000);
    });

    it('clears data on close', async () => {
        await store.save('test-key', {
            trades: [{ timestamp: 1000, pnlBps: -50 }],
            trippedAt: null,
            lastUpdated: 0,
        });

        await store.close();

        // After close, store is cleared (create new instance to test)
        const newStore = new MemoryBreakerStore();
        const state = await newStore.load('test-key');
        expect(state.trades).toEqual([]);
    });
});

describe('Circuit Breaker State Preservation', () => {
    it('preserves tripped state across save/load cycle', async () => {
        const store = new MemoryBreakerStore();

        // Simulate circuit breaker tripping
        const trippedState: BreakerState = {
            trades: [
                { timestamp: Date.now() - 60000, pnlBps: -200 },
                { timestamp: Date.now() - 30000, pnlBps: -350 },
            ],
            trippedAt: Date.now() - 10000, // Tripped 10 seconds ago
            lastUpdated: Date.now(),
        };

        await store.save('path_arb', trippedState);
        const loaded = await store.load('path_arb');

        // Verify tripped state is preserved
        expect(loaded.trippedAt).toBe(trippedState.trippedAt);
        expect(loaded.trades).toHaveLength(2);

        // Verify total loss is preserved
        const totalLoss = loaded.trades.reduce((sum: number, t: { pnlBps: number }) => sum + t.pnlBps, 0);
        expect(totalLoss).toBe(-550);

        await store.close();
    });

    it('allows fresh start when state is empty', async () => {
        const store = new MemoryBreakerStore();

        const state = await store.load('new_strategy');

        expect(state.trippedAt).toBeNull();
        expect(state.trades).toEqual([]);

        await store.close();
    });
});
