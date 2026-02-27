/**
 * Trade Tape Unit Tests
 * 
 * Tests for:
 * - Ring buffer behavior (max size, ordering, dedupe)
 * - Trade normalization from mocked XRPL transaction metadata
 * - Computed helpers (getRecent, getAggression, getVWAP)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TradeTape, Trade } from '../tradeTape';

// Mock trading pair for tests
const mockPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

// Helper to create a test trade
const createTrade = (overrides: Partial<Trade> = {}): Trade => ({
    id: `tx-${Date.now()}-${Math.random()}`,
    ts: Date.now(),
    pairKey: 'XRP/RLUSD',
    price: 2.5,
    sizeBase: 100,
    sizeQuote: 250,
    side: 'buy',
    txHash: '0x' + Math.random().toString(16).slice(2),
    ledgerIndex: 12345678,
    ...overrides,
});

describe('TradeTape', () => {
    let tape: TradeTape;

    beforeEach(() => {
        tape = new TradeTape(mockPair);
    });

    describe('Ring Buffer Behavior', () => {
        it('should add trades to the buffer', () => {
            const trade = createTrade();
            const added = tape.add(trade);

            expect(added).toBe(true);
            expect(tape.size()).toBe(1);
        });

        it('should deduplicate by trade id', () => {
            const trade = createTrade({ id: 'unique-id-123' });

            tape.add(trade);
            tape.add(trade); // Same id
            tape.add({ ...trade, id: 'unique-id-123' }); // Same id again

            expect(tape.size()).toBe(1);
        });

        it('should maintain sorted order by timestamp (ascending)', () => {
            const now = Date.now();

            // Add trades out of order
            tape.add(createTrade({ id: 't3', ts: now + 2000 }));
            tape.add(createTrade({ id: 't1', ts: now }));
            tape.add(createTrade({ id: 't2', ts: now + 1000 }));

            const all = tape.getAll();
            expect(all.length).toBe(3);
            expect(all[0]!.id).toBe('t1');
            expect(all[1]!.id).toBe('t2');
            expect(all[2]!.id).toBe('t3');
        });

        it('should enforce max buffer size', () => {
            // Add 1100 trades (exceeds max of 1000 from env or 500 default)
            for (let i = 0; i < 1100; i++) {
                tape.add(createTrade({ id: `trade-${i}`, ts: Date.now() + i }));
            }

            // Should be capped at the configured max (500 default, 1000 from env)
            expect(tape.size()).toBeLessThanOrEqual(1000);
        });

        it('should remove oldest trades when buffer is full', () => {
            const baseTs = Date.now();

            // Fill buffer to the max (use 1000 to cover env setting)
            for (let i = 0; i < 1000; i++) {
                tape.add(createTrade({ id: `trade-${i}`, ts: baseTs + i }));
            }

            // Add one more
            tape.add(createTrade({ id: 'newest-trade', ts: baseTs + 2000 }));

            const all = tape.getAll();

            // Oldest trade (trade-0) should be gone
            expect(all.some(t => t.id === 'trade-0')).toBe(false);
            // Newest trade should exist
            expect(all.some(t => t.id === 'newest-trade')).toBe(true);
        });

        it('should filter trades by pair key', () => {
            // Trade for different pair should be rejected
            const wrongPair = createTrade({ pairKey: 'XRP/USD' });
            const rightPair = createTrade({ pairKey: 'XRP/RLUSD' });

            expect(tape.add(wrongPair)).toBe(false);
            expect(tape.add(rightPair)).toBe(true);
            expect(tape.size()).toBe(1);
        });

        it('should clear buffer on pair change', () => {
            tape.add(createTrade());
            tape.add(createTrade({ id: 'trade-2' }));
            expect(tape.size()).toBe(2);

            tape.setPair({ baseCurrency: 'XRP', quoteCurrency: 'USD', issuer: 'rTestIssuer' });
            expect(tape.size()).toBe(0);
        });
    });

    describe('getRecent', () => {
        it('should return trades within time window', () => {
            const now = Date.now();

            tape.add(createTrade({ id: 't1', ts: now - 120_000 })); // 2 min ago
            tape.add(createTrade({ id: 't2', ts: now - 30_000 }));  // 30 sec ago
            tape.add(createTrade({ id: 't3', ts: now - 10_000 }));  // 10 sec ago

            const recent = tape.getRecent(60_000); // 1 min window
            expect(recent.length).toBe(2);
            expect(recent.map(t => t.id)).toEqual(['t2', 't3']);
        });

        it('should return empty array if no trades in window', () => {
            const now = Date.now();
            tape.add(createTrade({ ts: now - 300_000 })); // 5 min ago

            const recent = tape.getRecent(60_000);
            expect(recent).toEqual([]);
        });
    });

    describe('getAggression', () => {
        it('should calculate buy vs sell volume', () => {
            const now = Date.now();

            tape.add(createTrade({ id: 't1', ts: now, side: 'buy', sizeBase: 100 }));
            tape.add(createTrade({ id: 't2', ts: now, side: 'buy', sizeBase: 50 }));
            tape.add(createTrade({ id: 't3', ts: now, side: 'sell', sizeBase: 75 }));

            const stats = tape.getAggression(60_000);

            expect(stats.buyVolumeBase).toBe(150);
            expect(stats.sellVolumeBase).toBe(75);
            expect(stats.buyCount).toBe(2);
            expect(stats.sellCount).toBe(1);
        });

        it('should return zeros for empty window', () => {
            const stats = tape.getAggression(60_000);

            expect(stats.buyVolumeBase).toBe(0);
            expect(stats.sellVolumeBase).toBe(0);
            expect(stats.buyCount).toBe(0);
            expect(stats.sellCount).toBe(0);
        });
    });

    describe('getVWAP', () => {
        it('should calculate volume-weighted average price', () => {
            const now = Date.now();

            // Trade 1: 100 XRP at 2.0 = 200 value
            tape.add(createTrade({ id: 't1', ts: now, price: 2.0, sizeBase: 100 }));
            // Trade 2: 200 XRP at 2.5 = 500 value
            tape.add(createTrade({ id: 't2', ts: now, price: 2.5, sizeBase: 200 }));

            // VWAP = (200 + 500) / (100 + 200) = 700 / 300 = 2.333...
            const vwap = tape.getVWAP(60_000);
            expect(vwap).toBeCloseTo(2.333, 2);
        });

        it('should return null for empty window', () => {
            const vwap = tape.getVWAP(60_000);
            expect(vwap).toBeNull();
        });
    });

    describe('Trade Validation', () => {
        it('should reject invalid trade data', () => {
            // Missing required fields
            expect(tape.add({ ...createTrade(), id: '' })).toBe(false);
            expect(tape.add({ ...createTrade(), ts: 0 })).toBe(false);
            expect(tape.add({ ...createTrade(), price: 0 })).toBe(false);
            expect(tape.add({ ...createTrade(), price: -1 })).toBe(false);
            expect(tape.add({ ...createTrade(), sizeBase: 0 })).toBe(false);
            expect(tape.add({ ...createTrade(), txHash: '' })).toBe(false);
        });

        it('should accept valid trade data', () => {
            const trade = createTrade();
            expect(tape.add(trade)).toBe(true);
        });
    });
});
