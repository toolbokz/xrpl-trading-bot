/**
 * Execution Quality Analytics — Unit Tests
 *
 * Proves:
 *   1. Trace continuity: decision → submit → ledgerAccepted → fill timestamps are monotonic
 *   2. Slippage determinism: same inputs produce identical bps outputs
 *   3. Aggregation correctness: P50/P95, ratios, mean
 *   4. Cross-pair contamination guard: wrong pairKey → null from recordFill
 *   5. Ring buffer eviction: oldest fills removed when capacity exceeded
 *   6. Percentile edge cases: 0 fills, 1 fill, even/odd counts
 *   7. Paper trade traces: perfect fill, zero latency
 *   8. Payload structure: getPayload returns correct envelope
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    ExecutionQualityCollector,
    ExecutionFill,
    InFlightTrace,
    AggregatedExecutionQuality,
    ExecutionQualityPayload,
} from '../executionQuality';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a collector pre-configured with a pair key. */
function makeCollector(
    pairKey = 'XRP/RLUSD',
    opts: { maxFills?: number; defaultWindowMs?: number } = {},
): ExecutionQualityCollector {
    const c = new ExecutionQualityCollector(opts);
    c.setPairKey(pairKey);
    return c;
}

/** Record a fill with minimal boilerplate. Returns the ExecutionFill or null. */
function quickFill(
    collector: ExecutionQualityCollector,
    overrides: {
        pairKey?: string;
        strategy?: string;
        side?: 'buy' | 'sell';
        arrivalMid?: number;
        expectedPrice?: number;
        fillPrice?: number;
        postFillMid?: number;
        fillRatio?: number;
        isMaker?: boolean;
        wasReplaced?: boolean;
    } = {},
): ExecutionFill | null {
    const trace = collector.createTrace({
        pairKey: overrides.pairKey ?? 'XRP/RLUSD',
        strategy: overrides.strategy ?? 'scalper',
        side: overrides.side ?? 'buy',
        arrivalMid: overrides.arrivalMid ?? 1.0,
        expectedPrice: overrides.expectedPrice ?? 1.0,
        isMaker: overrides.isMaker ?? false,
        wasReplaced: overrides.wasReplaced ?? false,
    });

    return collector.recordFill(trace, {
        submitTimeMs: Date.now(),
        ledgerAcceptedTimeMs: Date.now() + 1,
        fillPrice: overrides.fillPrice ?? 1.0,
        postFillMid: overrides.postFillMid ?? 1.0,
        fillRatio: overrides.fillRatio ?? 1,
        txHash: 'ABCD1234',
        ledgerIndex: 12345,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Trace continuity
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Trace Continuity', () => {
    let collector: ExecutionQualityCollector;

    beforeEach(() => {
        collector = makeCollector();
    });

    it('timestamps are monotonically ordered: decision ≤ submit ≤ ledgerAccepted ≤ fill', () => {
        const baseMs = Date.now();
        const trace = collector.createTrace({
            pairKey: 'XRP/RLUSD',
            strategy: 'scalper',
            side: 'buy',
            arrivalMid: 1.0,
            expectedPrice: 1.001,
        });

        // Use timestamps in the past (decision was already stamped by createTrace)
        const submitMs = baseMs + 10;
        const acceptedMs = baseMs + 20;
        // Mock Date.now for the fillTimeMs stamp inside recordFill
        const fillNow = baseMs + 30;
        vi.spyOn(Date, 'now').mockReturnValue(fillNow);

        const fill = collector.recordFill(trace, {
            submitTimeMs: submitMs,
            ledgerAcceptedTimeMs: acceptedMs,
            fillPrice: 1.001,
            postFillMid: 1.0005,
            fillRatio: 1,
            txHash: 'hash1',
            ledgerIndex: 100,
        });

        vi.restoreAllMocks();

        expect(fill).not.toBeNull();
        expect(fill!.decisionTimeMs).toBeLessThanOrEqual(fill!.submitTimeMs);
        expect(fill!.submitTimeMs).toBeLessThanOrEqual(fill!.ledgerAcceptedTimeMs);
        expect(fill!.ledgerAcceptedTimeMs).toBeLessThanOrEqual(fill!.fillTimeMs);
    });

    it('correlation ID is unique across traces', () => {
        const t1 = collector.createTrace({
            pairKey: 'XRP/RLUSD',
            strategy: 'scalper',
            side: 'buy',
            arrivalMid: 1.0,
            expectedPrice: 1.0,
        });
        const t2 = collector.createTrace({
            pairKey: 'XRP/RLUSD',
            strategy: 'scalper',
            side: 'buy',
            arrivalMid: 1.0,
            expectedPrice: 1.0,
        });

        expect(t1.trace.correlationId).not.toBe(t2.trace.correlationId);
    });

    it('preserves all metadata through the trace lifecycle', () => {
        const fill = quickFill(collector, {
            strategy: 'amm-arb',
            side: 'sell',
            isMaker: true,
            wasReplaced: true,
        });

        expect(fill).not.toBeNull();
        expect(fill!.strategy).toBe('amm-arb');
        expect(fill!.side).toBe('sell');
        expect(fill!.isMaker).toBe(true);
        expect(fill!.wasReplaced).toBe(true);
        expect(fill!.pairKey).toBe('XRP/RLUSD');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Slippage determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Slippage Determinism', () => {
    let collector: ExecutionQualityCollector;

    beforeEach(() => {
        collector = makeCollector();
    });

    it('identical inputs produce identical slippage bps', () => {
        const fill1 = quickFill(collector, {
            expectedPrice: 1.0,
            fillPrice: 1.005,
            arrivalMid: 1.0,
            postFillMid: 1.002,
        });
        const fill2 = quickFill(collector, {
            expectedPrice: 1.0,
            fillPrice: 1.005,
            arrivalMid: 1.0,
            postFillMid: 1.002,
        });

        expect(fill1).not.toBeNull();
        expect(fill2).not.toBeNull();
        expect(fill1!.slippageBps).toBe(fill2!.slippageBps);
        expect(fill1!.spreadCostBps).toBe(fill2!.spreadCostBps);
        expect(fill1!.impactProxyBps).toBe(fill2!.impactProxyBps);
    });

    it('slippage = (fillPrice − expectedPrice) / expectedPrice × 10000', () => {
        const fill = quickFill(collector, {
            expectedPrice: 1.0,
            fillPrice: 1.005, // 50 bps adverse
        });

        expect(fill).not.toBeNull();
        expect(fill!.slippageBps).toBe(50);
    });

    it('spreadCost = (fillPrice − arrivalMid) / arrivalMid × 10000', () => {
        const fill = quickFill(collector, {
            arrivalMid: 1.0,
            fillPrice: 1.003, // 30 bps
            expectedPrice: 1.003, // match so slippage is 0
        });

        expect(fill).not.toBeNull();
        expect(fill!.spreadCostBps).toBe(30);
    });

    it('impactProxy = (postFillMid − arrivalMid) / arrivalMid × 10000', () => {
        const fill = quickFill(collector, {
            arrivalMid: 1.0,
            postFillMid: 1.001, // 10 bps impact
        });

        expect(fill).not.toBeNull();
        expect(fill!.impactProxyBps).toBe(10);
    });

    it('negative slippage when fill price is better than expected', () => {
        const fill = quickFill(collector, {
            expectedPrice: 1.01,
            fillPrice: 1.0, // better by 99 bps
        });

        expect(fill).not.toBeNull();
        // (1.0 - 1.01) / 1.01 * 10000 ≈ -99.01 → rounded
        expect(fill!.slippageBps).toBeLessThan(0);
    });

    it('zero slippage when fill matches expected', () => {
        const fill = quickFill(collector, {
            expectedPrice: 1.0,
            fillPrice: 1.0,
        });

        expect(fill).not.toBeNull();
        expect(fill!.slippageBps).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Aggregation correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Aggregation', () => {
    let collector: ExecutionQualityCollector;

    beforeEach(() => {
        collector = makeCollector('XRP/RLUSD', { defaultWindowMs: 3_600_000 });
    });

    it('P50 slippage is the median of sorted slippages', () => {
        // Record 5 fills with slippages: 10, 20, 30, 40, 50 bps
        for (const slip of [10, 20, 30, 40, 50]) {
            // slippage = (fill - expected) / expected * 10000 = slip bps
            // So fillPrice = expected * (1 + slip/10000)
            const expected = 1.0;
            const fillPrice = expected * (1 + slip / 10_000);
            quickFill(collector, { expectedPrice: expected, fillPrice });
        }

        const agg = collector.aggregate();
        // Median of [10, 20, 30, 40, 50] → 30
        expect(agg.slippageBpsP50).toBe(30);
        expect(agg.fillCount).toBe(5);
    });

    it('P95 slippage returns the 95th percentile (nearest-rank)', () => {
        // Record 20 fills with slippages 1..20
        for (let i = 1; i <= 20; i++) {
            const fillPrice = 1.0 * (1 + i / 10_000);
            quickFill(collector, { expectedPrice: 1.0, fillPrice });
        }

        const agg = collector.aggregate();
        // P95 of 20 values: ceil(0.95 * 20) - 1 = 18  → value at index 18 = 19 bps
        expect(agg.slippageBpsP95).toBe(19);
    });

    it('makerFillRatio is the ratio of maker fills', () => {
        quickFill(collector, { isMaker: true });
        quickFill(collector, { isMaker: true });
        quickFill(collector, { isMaker: false });

        const agg = collector.aggregate();
        expect(agg.makerFillRatio).toBeCloseTo(2 / 3, 5);
    });

    it('replaceToFillRatio is the ratio of replaced fills', () => {
        quickFill(collector, { wasReplaced: true });
        quickFill(collector, { wasReplaced: false });
        quickFill(collector, { wasReplaced: false });
        quickFill(collector, { wasReplaced: false });

        const agg = collector.aggregate();
        expect(agg.replaceToFillRatio).toBeCloseTo(0.25, 5);
    });

    it('meanFillRatio averages partial fill ratios', () => {
        quickFill(collector, { fillRatio: 1.0 });
        quickFill(collector, { fillRatio: 0.5 });
        quickFill(collector, { fillRatio: 0.75 });

        const agg = collector.aggregate();
        // mean = (1.0 + 0.5 + 0.75) / 3 = 0.75
        expect(agg.meanFillRatio).toBeCloseTo(0.75, 5);
    });

    it('returns empty aggregate when no fills exist', () => {
        const agg = collector.aggregate();
        expect(agg.fillCount).toBe(0);
        expect(agg.slippageBpsP50).toBe(0);
        expect(agg.slippageBpsP95).toBe(0);
        expect(agg.fillLatencyP50).toBe(0);
        expect(agg.fillLatencyP95).toBe(0);
        expect(agg.makerFillRatio).toBe(0);
        expect(agg.replaceToFillRatio).toBe(0);
        expect(agg.meanFillRatio).toBe(0);
    });

    it('only aggregates fills within the time window', () => {
        // Use a very short window
        const shortCollector = makeCollector('XRP/RLUSD', { defaultWindowMs: 1 });

        quickFill(shortCollector);

        // Wait 10ms to push fills outside window
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 100);

        const agg = shortCollector.aggregate();
        expect(agg.fillCount).toBe(0);

        vi.restoreAllMocks();
    });

    it('fillLatency is computed as fillTimeMs − submitTimeMs', () => {
        const trace = collector.createTrace({
            pairKey: 'XRP/RLUSD',
            strategy: 'scalper',
            side: 'buy',
            arrivalMid: 1.0,
            expectedPrice: 1.0,
        });

        const submitMs = Date.now();
        const now = submitMs + 200;
        vi.spyOn(Date, 'now').mockReturnValue(now);

        collector.recordFill(trace, {
            submitTimeMs: submitMs,
            ledgerAcceptedTimeMs: submitMs + 100,
            fillPrice: 1.0,
            postFillMid: 1.0,
            fillRatio: 1,
            txHash: 'hash',
            ledgerIndex: 1,
        });

        vi.restoreAllMocks();

        const agg = collector.aggregate();
        // fillTimeMs is set to Date.now() inside recordFill which we mocked to submitMs + 200
        // latency = fillTimeMs - submitTimeMs = 200
        expect(agg.fillLatencyP50).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cross-pair contamination guard
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Cross-Pair Guard', () => {
    it('rejects fills with wrong pairKey', () => {
        const collector = makeCollector('XRP/RLUSD');

        const fill = quickFill(collector, { pairKey: 'XRP/USD' });
        expect(fill).toBeNull();
        expect(collector.getFillCount()).toBe(0);
    });

    it('accepts fills with correct pairKey', () => {
        const collector = makeCollector('XRP/RLUSD');

        const fill = quickFill(collector, { pairKey: 'XRP/RLUSD' });
        expect(fill).not.toBeNull();
        expect(collector.getFillCount()).toBe(1);
    });

    it('setPairKey changes which pair is accepted', () => {
        const collector = makeCollector('XRP/RLUSD');

        // Fill for current pair succeeds
        const fill1 = quickFill(collector, { pairKey: 'XRP/RLUSD' });
        expect(fill1).not.toBeNull();

        // Switch pair
        collector.setPairKey('XRP/USD');

        // Old pair fill now rejected
        const fill2 = quickFill(collector, { pairKey: 'XRP/RLUSD' });
        expect(fill2).toBeNull();

        // New pair fill accepted
        const fill3 = quickFill(collector, { pairKey: 'XRP/USD' });
        expect(fill3).not.toBeNull();
    });

    it('aggregate only returns metrics for the specified pair', () => {
        const collector = makeCollector('XRP/RLUSD');
        quickFill(collector, { pairKey: 'XRP/RLUSD', fillPrice: 1.001, expectedPrice: 1.0 });

        // Switch pair and add fill
        collector.setPairKey('XRP/USD');
        quickFill(collector, { pairKey: 'XRP/USD', fillPrice: 1.01, expectedPrice: 1.0 });

        // Aggregate for new pair only sees 1 fill
        const agg = collector.aggregate(undefined, 'XRP/USD');
        expect(agg.fillCount).toBe(1);

        // Old pair also has 1 fill
        const aggOld = collector.aggregate(undefined, 'XRP/RLUSD');
        expect(aggOld.fillCount).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Ring buffer eviction
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Ring Buffer', () => {
    it('evicts oldest fills when capacity is exceeded', () => {
        const collector = makeCollector('XRP/RLUSD', { maxFills: 5 });

        // Record 8 fills
        for (let i = 0; i < 8; i++) {
            quickFill(collector);
        }

        const allFills = collector.getAllFills();
        expect(allFills.length).toBe(5);
    });

    it('retains the newest fills after eviction', () => {
        const collector = makeCollector('XRP/RLUSD', { maxFills: 3 });

        // Fill with different slippages to distinguish them
        for (let i = 1; i <= 5; i++) {
            const fillPrice = 1.0 * (1 + i / 10_000);
            quickFill(collector, { expectedPrice: 1.0, fillPrice });
        }

        const allFills = collector.getAllFills();
        expect(allFills.length).toBe(3);

        // Should keep fills 3, 4, 5 (3, 4, 5 bps slippage)
        expect(allFills[0]!.slippageBps).toBe(3);
        expect(allFills[1]!.slippageBps).toBe(4);
        expect(allFills[2]!.slippageBps).toBe(5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Percentile edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Percentile Edge Cases', () => {
    it('single fill: P50 and P95 are the same value', () => {
        const collector = makeCollector();
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.002 });

        const agg = collector.aggregate();
        expect(agg.slippageBpsP50).toBe(agg.slippageBpsP95);
        expect(agg.slippageBpsP50).toBe(20);
    });

    it('two fills: P50 picks index 0, P95 picks index 1', () => {
        const collector = makeCollector();
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.001 }); // 10 bps
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.005 }); // 50 bps

        const agg = collector.aggregate();
        // P50: ceil(0.50 * 2) - 1 = 0 → 10
        expect(agg.slippageBpsP50).toBe(10);
        // P95: ceil(0.95 * 2) - 1 = 1 → 50
        expect(agg.slippageBpsP95).toBe(50);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Payload structure
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Payload', () => {
    it('getPayload returns complete envelope', () => {
        const collector = makeCollector('XRP/RLUSD');
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.001 });
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.002 });

        const payload = collector.getPayload();

        expect(payload.pairKey).toBe('XRP/RLUSD');
        expect(payload.totalFillsTracked).toBe(2);
        expect(payload.recentFills.length).toBe(2);
        // Recent fills are newest first
        expect(payload.recentFills[0]!.slippageBps).toBe(20); // 1.002 fill is newer
        expect(payload.aggregated.fillCount).toBe(2);
        expect(payload.aggregated.windowMs).toBe(3_600_000);
    });

    it('getRecentFills respects limit parameter', () => {
        const collector = makeCollector();
        for (let i = 0; i < 10; i++) {
            quickFill(collector);
        }

        const recent = collector.getRecentFills(3);
        expect(recent.length).toBe(3);
    });

    it('getRecentFills returns newest first', () => {
        const collector = makeCollector();

        // Use different slippages to identify order
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.001 }); // 10 bps
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.002 }); // 20 bps
        quickFill(collector, { expectedPrice: 1.0, fillPrice: 1.003 }); // 30 bps

        const recent = collector.getRecentFills();
        expect(recent[0]!.slippageBps).toBe(30); // newest
        expect(recent[2]!.slippageBps).toBe(10); // oldest
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Reset
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Reset', () => {
    it('reset clears all fills and pair key', () => {
        const collector = makeCollector('XRP/RLUSD');
        quickFill(collector);
        quickFill(collector);
        expect(collector.getAllFills().length).toBe(2);

        collector.reset();

        expect(collector.getAllFills().length).toBe(0);
        // After reset, pair key is empty — fills for old pair rejected
        const fill = quickFill(collector, { pairKey: 'XRP/RLUSD' });
        expect(fill).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Fill metadata integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — Fill Metadata', () => {
    it('fill includes txHash and ledgerIndex', () => {
        const collector = makeCollector();
        const trace = collector.createTrace({
            pairKey: 'XRP/RLUSD',
            strategy: 'path-arb',
            side: 'sell',
            arrivalMid: 2.5,
            expectedPrice: 2.505,
        });

        const fill = collector.recordFill(trace, {
            submitTimeMs: Date.now(),
            ledgerAcceptedTimeMs: Date.now() + 10,
            fillPrice: 2.503,
            postFillMid: 2.502,
            fillRatio: 0.85,
            txHash: 'DEADBEEF',
            ledgerIndex: 99999,
        });

        expect(fill).not.toBeNull();
        expect(fill!.txHash).toBe('DEADBEEF');
        expect(fill!.ledgerIndex).toBe(99999);
        expect(fill!.fillRatio).toBe(0.85);
    });

    it('null txHash is preserved for paper trades', () => {
        const collector = makeCollector();
        const trace = collector.createTrace({
            pairKey: 'XRP/RLUSD',
            strategy: 'scalper',
            side: 'buy',
            arrivalMid: 1.0,
            expectedPrice: 1.0,
        });

        const fill = collector.recordFill(trace, {
            submitTimeMs: Date.now(),
            ledgerAcceptedTimeMs: Date.now(),
            fillPrice: 1.0,
            postFillMid: 1.0,
            fillRatio: 1,
            txHash: null,
            ledgerIndex: 0,
        });

        expect(fill).not.toBeNull();
        expect(fill!.txHash).toBeNull();
        expect(fill!.ledgerIndex).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. getFillCount
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionQualityCollector — getFillCount', () => {
    it('counts fills for the active pair only', () => {
        const collector = makeCollector('XRP/RLUSD');
        quickFill(collector, { pairKey: 'XRP/RLUSD' });
        quickFill(collector, { pairKey: 'XRP/RLUSD' });

        // Switch and add fill for different pair
        collector.setPairKey('XRP/USD');
        quickFill(collector, { pairKey: 'XRP/USD' });

        expect(collector.getFillCount('XRP/RLUSD')).toBe(2);
        expect(collector.getFillCount('XRP/USD')).toBe(1);
        // Default (active pair)
        expect(collector.getFillCount()).toBe(1);
    });
});
