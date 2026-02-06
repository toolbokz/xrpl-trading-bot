/**
 * SnapshotValidator — Unit Tests
 *
 * Validates the structural truth enforcement layer that checks
 * sequence continuity, timestamp monotonicity, NaN/Infinity guards,
 * spread/depth/crossed-book invariants.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SnapshotValidator } from '../snapshotValidator';
import { OrderBookSnapshot, DepthLevel } from '../models';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const validSnapshot = (overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot => ({
    pairKey: 'XRP/USD',
    sequence: 1,
    eventTimeMs: NOW - 2_000,
    ingestTimeMs: NOW,
    bids: [{ price: 0.50, size: 100 }],
    asks: [{ price: 0.51, size: 100 }],
    bestBid: 0.50,
    bestAsk: 0.51,
    spreadBps: 196,
    depthNotional1Pct: 101,
    stalenessMs: 2_000,
    healthScore: 100,
    ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SnapshotValidator', () => {
    let validator: SnapshotValidator;

    beforeEach(() => {
        validator = new SnapshotValidator();
    });

    // ─── Structural checks ──────────────────────────────────────────────

    it('passes a valid snapshot', () => {
        const result = validator.validate(validSnapshot());
        expect(result.valid).toBe(true);
        expect(result.reasons).toEqual([]);
    });

    it('rejects NaN in bestBid', () => {
        const result = validator.validate(validSnapshot({ bestBid: NaN }));
        expect(result.valid).toBe(false);
        expect(result.reasons).toContain('nan-or-infinite:bestBid=NaN');
    });

    it('rejects Infinity in bestAsk', () => {
        const result = validator.validate(validSnapshot({ bestAsk: Infinity }));
        expect(result.valid).toBe(false);
        expect(result.reasons.some(r => r.includes('nan-or-infinite:bestAsk'))).toBe(true);
    });

    it('rejects NaN in depth levels', () => {
        const badBids: DepthLevel[] = [{ price: NaN, size: 100 }];
        const result = validator.validate(validSnapshot({ bids: badBids }));
        expect(result.valid).toBe(false);
        expect(result.reasons).toContain('nan-or-infinite:bid[0]');
    });

    it('rejects negative spread', () => {
        const result = validator.validate(validSnapshot({ spreadBps: -10 }));
        expect(result.valid).toBe(false);
        expect(result.reasons.some(r => r.includes('negative-spread'))).toBe(true);
    });

    it('rejects crossed book (bid >= ask)', () => {
        const result = validator.validate(validSnapshot({ bestBid: 0.52, bestAsk: 0.50 }));
        expect(result.valid).toBe(false);
        expect(result.reasons.some(r => r.includes('crossed-book'))).toBe(true);
    });

    it('rejects empty book (no depth)', () => {
        const result = validator.validate(validSnapshot({ bids: [], asks: [] }));
        expect(result.valid).toBe(false);
        expect(result.reasons).toContain('empty-book:no-depth');
    });

    it('allows book with only bids (one-sided)', () => {
        const result = validator.validate(validSnapshot({
            asks: [],
            bestAsk: 0,
        }));
        expect(result.valid).toBe(true);
    });

    // ─── Sequence continuity ────────────────────────────────────────────

    it('detects sequence gap', () => {
        validator.validate(validSnapshot({ sequence: 1 }));
        const result = validator.validate(validSnapshot({ sequence: 3, ingestTimeMs: NOW + 1 }));
        expect(result.valid).toBe(false);
        expect(result.reasons.some(r => r.includes('sequence-gap'))).toBe(true);
    });

    it('detects sequence regression', () => {
        validator.validate(validSnapshot({ sequence: 5 }));
        const result = validator.validate(validSnapshot({ sequence: 3, ingestTimeMs: NOW + 1 }));
        expect(result.valid).toBe(false);
        expect(result.reasons.some(r => r.includes('sequence-regression'))).toBe(true);
    });

    it('passes consecutive sequences', () => {
        validator.validate(validSnapshot({ sequence: 1 }));
        const result = validator.validate(validSnapshot({ sequence: 2, ingestTimeMs: NOW + 1 }));
        expect(result.valid).toBe(true);
    });

    it('skips sequence check on first snapshot', () => {
        const result = validator.validate(validSnapshot({ sequence: 42 }));
        expect(result.valid).toBe(true);
    });

    // ─── Timestamp monotonicity ─────────────────────────────────────────

    it('detects timestamp regression', () => {
        validator.validate(validSnapshot({ ingestTimeMs: NOW + 1000 }));
        const result = validator.validate(validSnapshot({
            sequence: 2,
            ingestTimeMs: NOW,
        }));
        expect(result.valid).toBe(false);
        expect(result.reasons.some(r => r.includes('timestamp-regression'))).toBe(true);
    });

    it('passes forward timestamps', () => {
        validator.validate(validSnapshot({ ingestTimeMs: NOW }));
        const result = validator.validate(validSnapshot({
            sequence: 2,
            ingestTimeMs: NOW + 1,
        }));
        expect(result.valid).toBe(true);
    });

    // ─── Cross-pair safety ──────────────────────────────────────────────

    it('does not compare sequence across different pairs', () => {
        validator.validate(validSnapshot({ pairKey: 'XRP/USD', sequence: 10 }));
        // Different pair — sequence 1 should be fine (no gap)
        const result = validator.validate(validSnapshot({
            pairKey: 'XRP/EUR',
            sequence: 1,
        }));
        expect(result.valid).toBe(true);
    });

    // ─── Reset ──────────────────────────────────────────────────────────

    it('reset clears state so next snapshot is treated as first', () => {
        validator.validate(validSnapshot({ sequence: 10, ingestTimeMs: NOW + 5000 }));
        validator.reset();
        const state = validator.getState();
        expect(state.lastSequence).toBe(0);
        expect(state.lastIngestTimeMs).toBe(0);
        expect(state.lastPairKey).toBe('');

        // Sequence 1 should pass without "gap from 10"
        const result = validator.validate(validSnapshot({ sequence: 1 }));
        expect(result.valid).toBe(true);
    });

    // ─── Multiple failures accumulate ───────────────────────────────────

    it('reports multiple failures at once', () => {
        const result = validator.validate(validSnapshot({
            bestBid: NaN,
            spreadBps: -5,
            bids: [],
            asks: [],
        }));
        expect(result.valid).toBe(false);
        expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    });
});
