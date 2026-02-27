/**
 * RuntimeCacheRegistry — Integration Tests
 *
 * Proves:
 *  1. All snapshots carry the correct pairKey.
 *  2. reset() wipes every cache (pair-switch safety).
 *  3. Cross-pair balance updates are silently rejected.
 *  4. Execution quality counters accumulate and reset correctly.
 *  5. PairPayload helpers validate correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    RuntimeCacheRegistry,
    CacheUpdateInput,
    FeedType,
    RuntimeCacheSnapshot,
} from '../runtimeCacheRegistry';
import { buildPairPayload, isPairPayloadUsable, PairPayload } from '../../ui/lib/types/pairPayload';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeUpdateInput(overrides: Partial<CacheUpdateInput> = {}): CacheUpdateInput {
    return {
        pairKey: 'XRP/RLUSD',
        sequence: 1,
        runtimeState: 'READY',
        health: {
            score: 80,
            signalCount: 4,
            quorumMet: true,
            signals: {},
            reasons: [],
        } as any,
        gate: {
            verdict: 'ALLOW',
            reasons: [],
            healthScore: 80,
            timestamp: Date.now(),
        } as any,
        flow: {
            regime: 'NORMAL' as any,
            spreadBps: 15,
            midPrice: 2.05,
            bestBid: 2.0,
            bestAsk: 2.1,
            buyPressure: 0.5,
            sellPressure: 0.5,
            tradeIntensity: 10,
            vwap: 2.05,
        } as any,
        tape: {
            trades: [{ ts: Date.now(), price: 2.05, qty: 100, side: 'buy' }] as any[],
            tradeCount: 1,
            lastTradeAtMs: Date.now(),
        },
        orderbook: {
            bids: [{ price: 2.0, quantity: 100 }],
            asks: [{ price: 2.1, quantity: 100 }],
            spreadBps: 15,
            lastUpdated: Date.now(),
        } as any,
        lastTrade: { price: 2.05, quantity: 100, side: 'buy', timestamp: Date.now() } as any,
        spreadDistribution: {
            pair: 'XRP/RLUSD',
            updatedAtMs: Date.now(),
            lookback24h: { sampleCount: 3, medianBps: 10, p75Bps: 12, p90Bps: 15 },
            baselineMultiDay: { days: 3, sampleCount: 5, medianBps: 11, p75Bps: 13, p90Bps: 16 },
        },
        ...overrides,
    };
}

const ALL_FEED_TYPES: FeedType[] = [
    'health',
    'flow',
    'tape',
    'orderbook',
    'execution-quality',
    'spread-regime',
];

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RuntimeCacheRegistry', () => {
    let registry: RuntimeCacheRegistry;

    beforeEach(() => {
        registry = new RuntimeCacheRegistry();
    });

    // ═════════════════════════════════════════════════════════════════════
    // 1 · All payloads contain correct pairKey
    // ═════════════════════════════════════════════════════════════════════

    describe('pair-key affinity', () => {
        it('every feed entry carries the update pairKey', () => {
            const pairKey = 'XRP/RLUSD';
            registry.update(makeUpdateInput({ pairKey }));

            const snapshot = registry.getSnapshot();
            expect(snapshot.pairKey).toBe(pairKey);

            for (const ft of ALL_FEED_TYPES) {
                const entry = registry.getFeed(ft);
                expect(entry).not.toBeNull();
                expect(entry!.pairKey).toBe(pairKey);
            }
        });

        it('balance entry carries correct pairKey after updateBalance', () => {
            const pairKey = 'XRP/RLUSD';
            registry.update(makeUpdateInput({ pairKey }));

            registry.updateBalance(pairKey, {
                xrpBalance: 100,
                quoteBalance: 200,
                quoteCurrency: 'RLUSD',
                ledgerIndex: 42,
            });

            const bal = registry.getFeed('balance');
            expect(bal).not.toBeNull();
            expect(bal!.pairKey).toBe(pairKey);
        });

        it('snapshot pairKey matches after multiple updates', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD', sequence: 1 }));
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD', sequence: 2 }));
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD', sequence: 3 }));

            const snapshot = registry.getSnapshot();
            expect(snapshot.pairKey).toBe('XRP/RLUSD');
            expect(snapshot.sequence).toBe(3);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 2 · reset() wipes all caches (pair-switch safety)
    // ═════════════════════════════════════════════════════════════════════

    describe('pair-switch reset', () => {
        it('reset() clears all feed entries to null', () => {
            registry.update(makeUpdateInput());
            registry.updateStrategyFunnel('XRP/RLUSD', {
                'orderbook-scalper': {
                    strategyTicks: 1,
                    candidatesBuilt: 0,
                    rejectedCount: 1,
                    rejectedByReason: { regimeNotAllowed: 1 },
                    approvedCount: 0,
                    submitAttemptCount: 0,
                    submitSuccessCount: 0,
                    submitFailCount: 0,
                    lastSubmitError: null,
                    lastTxHash: null,
                },
            });
            // Pre-condition: all feeds populated
            for (const ft of ALL_FEED_TYPES) {
                expect(registry.getFeed(ft)).not.toBeNull();
            }

            registry.reset();

            // Post-condition: everything null
            const snapshot = registry.getSnapshot();
            expect(snapshot.pairKey).toBe('');
            expect(snapshot.sequence).toBe(0);
            expect(snapshot.asOfMs).toBe(0);
            expect(snapshot.runtimeState).toBeNull();
            expect(snapshot.executionAllowed).toBe(false);
            expect(snapshot.heartbeat).toBeNull();
            expect(snapshot.health).toBeNull();
            expect(snapshot.flow).toBeNull();
            expect(snapshot.tape).toBeNull();
            expect(snapshot.orderbook).toBeNull();
            expect(snapshot.balance).toBeNull();
            expect(snapshot.executionQuality).toBeNull();
            expect(snapshot.spreadRegime).toBeNull();
            expect(snapshot.spreadDistribution).toBeNull();
            expect(snapshot.background).toBeNull();
            expect(snapshot.strategyFunnel).toBeNull();
        });

        it('reset() clears execution quality counters', () => {
            const input = makeUpdateInput();
            // Accumulate some ticks
            registry.update({ ...input, sequence: 1 });
            registry.update({ ...input, sequence: 2 });

            const before = registry.getFeed('execution-quality');
            expect(before!.data.allowedTicks).toBe(2);

            registry.reset();

            // After reset, counters start from zero
            registry.update({ ...input, pairKey: 'XRP/USD', sequence: 1 });
            const after = registry.getFeed('execution-quality');
            expect(after!.data.allowedTicks).toBe(1);
            expect(after!.data.blockedTicks).toBe(0);
        });

        it('update after reset uses the new pairKey', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));
            registry.reset();
            registry.update(makeUpdateInput({ pairKey: 'XRP/USD', sequence: 1 }));

            const snapshot = registry.getSnapshot();
            expect(snapshot.pairKey).toBe('XRP/USD');
            for (const ft of ALL_FEED_TYPES) {
                expect(registry.getFeed(ft)!.pairKey).toBe('XRP/USD');
            }
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 3 · Cross-pair balance updates rejected
    // ═════════════════════════════════════════════════════════════════════

    describe('cross-pair rejection', () => {
        it('updateBalance rejects data with different pairKey', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));

            registry.updateBalance('XRP/USD', {
                xrpBalance: 999,
                quoteBalance: 999,
                quoteCurrency: 'USD',
                ledgerIndex: 99,
            });

            expect(registry.getFeed('balance')).toBeNull();
        });

        it('updateBalance accepts data with matching pairKey', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));

            registry.updateBalance('XRP/RLUSD', {
                xrpBalance: 100,
                quoteBalance: 200,
                quoteCurrency: 'RLUSD',
                ledgerIndex: 42,
            });

            const bal = registry.getFeed('balance');
            expect(bal).not.toBeNull();
            expect(bal!.data.xrpBalance).toBe(100);
        });

        it('updateBackground rejects data with different pairKey', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));

            registry.updateBackground('XRP/USD', {
                asOfMs: Date.now(),
                health: { score: 90, lastOkAtMs: Date.now(), lastErrorAtMs: null, consecutiveFailures: 0 },
                fairValue: { xrpMid: 1.0, confidence: 80, sourcesUsed: [], divergenceBpsVsXrpRlusd: 0 },
                crossMarket: { liquidityScore: 60, volatilityScore: 20, notes: [] },
                markets: {},
            });

            expect(registry.getSnapshot().background).toBeNull();
        });

        it('updateBackground accepts pre-tick writes for matching pair', () => {
            registry.updateBackground('XRP/RLUSD', {
                asOfMs: Date.now(),
                health: { score: 100, lastOkAtMs: Date.now(), lastErrorAtMs: null, consecutiveFailures: 0 },
                fairValue: { xrpMid: 1.0, confidence: 90, sourcesUsed: [], divergenceBpsVsXrpRlusd: null },
                crossMarket: { liquidityScore: 70, volatilityScore: 10, notes: ['pre-tick'] },
                markets: {},
            });

            const snapshot = registry.getSnapshot();
            expect(snapshot.pairKey).toBe('XRP/RLUSD');
            expect(snapshot.background?.fairValue.xrpMid).toBe(1.0);
        });

        it('updateStrategyFunnel rejects data with different pairKey', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));

            registry.updateStrategyFunnel('XRP/USD', {
                'orderbook-scalper': {
                    strategyTicks: 1,
                    candidatesBuilt: 0,
                    rejectedCount: 1,
                    rejectedByReason: { cooldown: 1 },
                    approvedCount: 0,
                    submitAttemptCount: 0,
                    submitSuccessCount: 0,
                    submitFailCount: 0,
                    lastSubmitError: null,
                    lastTxHash: null,
                },
            });

            expect(registry.getSnapshot().strategyFunnel).toBeNull();
        });

        it('updateStrategyFunnel stores funnel state for matching pair', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));

            registry.updateStrategyFunnel('XRP/RLUSD', {
                'orderbook-scalper': {
                    strategyTicks: 10,
                    candidatesBuilt: 3,
                    rejectedCount: 7,
                    rejectedByReason: { minEdge: 4, regimeNotAllowed: 3 },
                    approvedCount: 3,
                    submitAttemptCount: 2,
                    submitSuccessCount: 1,
                    submitFailCount: 1,
                    lastSubmitError: 'tecUNFUNDED_OFFER',
                    lastTxHash: 'ABC123',
                },
            });

            const snapshot = registry.getSnapshot();
            expect(snapshot.strategyFunnel).toEqual({
                'orderbook-scalper': {
                    strategyTicks: 10,
                    candidatesBuilt: 3,
                    rejectedCount: 7,
                    rejectedByReason: { minEdge: 4, regimeNotAllowed: 3 },
                    approvedCount: 3,
                    submitAttemptCount: 2,
                    submitSuccessCount: 1,
                    submitFailCount: 1,
                    lastSubmitError: 'tecUNFUNDED_OFFER',
                    lastTxHash: 'ABC123',
                },
            });
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 4 · Heartbeat cache
    // ═════════════════════════════════════════════════════════════════════

    describe('runtime heartbeat cache', () => {
        it('stores heartbeat snapshots for the active pair', () => {
            registry.updateHeartbeat('XRP/RLUSD', {
                ts: 1_770_000_000_000,
                tickId: 41,
                inFlight: false,
                lastError: null,
                lastSubmitTs: 1_770_000_000_100,
                lastValidatedTs: 1_770_000_000_200,
            });

            const snapshot = registry.getSnapshot();
            expect(snapshot.pairKey).toBe('XRP/RLUSD');
            expect(snapshot.heartbeat).toEqual({
                ts: 1_770_000_000_000,
                tickId: 41,
                inFlight: false,
                lastError: null,
                lastSubmitTs: 1_770_000_000_100,
                lastValidatedTs: 1_770_000_000_200,
            });
        });

        it('rejects cross-pair heartbeat updates', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));

            registry.updateHeartbeat('XRP/USD', {
                ts: 1_770_000_000_000,
                tickId: 99,
                inFlight: true,
                lastError: 'tick-failed',
                lastSubmitTs: null,
                lastValidatedTs: null,
            });

            expect(registry.getSnapshot().heartbeat).toBeNull();
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 5 · Execution quality counters
    // ═════════════════════════════════════════════════════════════════════

    describe('execution quality tracking', () => {
        it('counts ALLOW ticks', () => {
            const input = makeUpdateInput({
                gate: { verdict: 'ALLOW', reasons: [], healthScore: 85, timestamp: Date.now() } as any,
            });
            registry.update({ ...input, sequence: 1 });
            registry.update({ ...input, sequence: 2 });
            registry.update({ ...input, sequence: 3 });

            const eq = registry.getFeed('execution-quality')!.data;
            expect(eq.allowedTicks).toBe(3);
            expect(eq.blockedTicks).toBe(0);
            expect(eq.currentVerdict).toBe('ALLOW');
        });

        it('counts BLOCK ticks with reasons', () => {
            const input = makeUpdateInput({
                gate: {
                    verdict: 'BLOCK',
                    reasons: ['spread_too_wide', 'health_below_threshold'],
                    healthScore: 20,
                    timestamp: Date.now(),
                } as any,
            });
            registry.update({ ...input, sequence: 1 });

            const eq = registry.getFeed('execution-quality')!.data;
            expect(eq.allowedTicks).toBe(0);
            expect(eq.blockedTicks).toBe(1);
            expect(eq.currentVerdict).toBe('BLOCK');
            expect(eq.lastBlockReasons).toEqual(['spread_too_wide', 'health_below_threshold']);
        });

        it('mixes ALLOW and BLOCK ticks correctly', () => {
            const allow = makeUpdateInput({
                gate: { verdict: 'ALLOW', reasons: [], healthScore: 85, timestamp: Date.now() } as any,
            });
            const block = makeUpdateInput({
                gate: { verdict: 'BLOCK', reasons: ['stale_book'], healthScore: 30, timestamp: Date.now() } as any,
            });

            registry.update({ ...allow, sequence: 1 });
            registry.update({ ...allow, sequence: 2 });
            registry.update({ ...block, sequence: 3 });
            registry.update({ ...allow, sequence: 4 });

            const eq = registry.getFeed('execution-quality')!.data;
            expect(eq.allowedTicks).toBe(3);
            expect(eq.blockedTicks).toBe(1);
            // Last update was ALLOW, so block reasons should be empty
            expect(eq.currentVerdict).toBe('ALLOW');
            expect(eq.lastBlockReasons).toEqual([]);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 6 · Snapshot immutability
    // ═════════════════════════════════════════════════════════════════════

    describe('snapshot consistency', () => {
        it('getSnapshot returns consistent pairKey across all non-null entries', () => {
            registry.update(makeUpdateInput({ pairKey: 'XRP/RLUSD' }));
            registry.updateBalance('XRP/RLUSD', {
                xrpBalance: 100,
                quoteBalance: 200,
                quoteCurrency: 'RLUSD',
                ledgerIndex: 42,
            });

            const snapshot = registry.getSnapshot();
            const entries = [
                snapshot.health,
                snapshot.flow,
                snapshot.tape,
                snapshot.orderbook,
                snapshot.balance,
                snapshot.executionQuality,
                snapshot.spreadRegime,
            ];

            for (const entry of entries) {
                if (entry !== null) {
                    expect(entry.pairKey).toBe(snapshot.pairKey);
                }
            }
        });

        it('convenience getters reflect current state', () => {
            registry.update(makeUpdateInput({
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                gate: { verdict: 'ALLOW', reasons: [], healthScore: 90, timestamp: Date.now() } as any,
            }));

            expect(registry.getPairKey()).toBe('XRP/RLUSD');
            expect(registry.getRuntimeState()).toBe('READY');
            expect(registry.isExecutionAllowed()).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 7 · Null-safe when feeds are partially provided
    // ═════════════════════════════════════════════════════════════════════

    describe('partial updates', () => {
        it('works when flow is null (BLOCK path)', () => {
            registry.update(makeUpdateInput({
                flow: null,
                gate: { verdict: 'BLOCK', reasons: ['no_flow'], healthScore: 10, timestamp: Date.now() } as any,
            }));

            const snapshot = registry.getSnapshot();
            expect(snapshot.flow).toBeNull();
            expect(snapshot.spreadRegime).toBeNull();
            expect(snapshot.health).not.toBeNull();
            expect(snapshot.executionQuality).not.toBeNull();
            expect(snapshot.executionQuality!.data.currentVerdict).toBe('BLOCK');
        });

        it('works when tape is null', () => {
            registry.update(makeUpdateInput({ tape: null }));
            expect(registry.getFeed('tape')).toBeNull();
            expect(registry.getFeed('health')).not.toBeNull();
        });

        it('works when orderbook is null', () => {
            registry.update(makeUpdateInput({ orderbook: null }));
            expect(registry.getFeed('orderbook')).toBeNull();
            expect(registry.getFeed('flow')).not.toBeNull();
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PairPayload helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('PairPayload helpers', () => {
    describe('buildPairPayload', () => {
        it('computes non-negative stalenessMs', () => {
            const now = Date.now();
            const payload = buildPairPayload(
                {
                    pairKey: 'XRP/RLUSD',
                    asOfMs: now - 500,
                    executionAllowed: true,
                    runtimeState: 'READY',
                    requestId: 'test-1',
                },
                { foo: 'bar' },
            );

            expect(payload.pairKey).toBe('XRP/RLUSD');
            expect(payload.stalenessMs).toBeGreaterThanOrEqual(500);
            expect(payload.executionAllowed).toBe(true);
            expect(payload.data).toEqual({ foo: 'bar' });
            expect(payload.requestId).toBe('test-1');
        });

        it('handles null data', () => {
            const payload = buildPairPayload(
                {
                    pairKey: 'XRP/USD',
                    asOfMs: Date.now(),
                    executionAllowed: false,
                    runtimeState: null,
                    requestId: 'test-2',
                },
                null,
            );

            expect(payload.data).toBeNull();
            expect(payload.runtimeState).toBeNull();
        });
    });

    describe('isPairPayloadUsable', () => {
        function makePayload<T>(overrides: Partial<PairPayload<T>> = {}): PairPayload<T> {
            return {
                pairKey: 'XRP/RLUSD',
                asOfMs: Date.now(),
                stalenessMs: 0,
                executionAllowed: true,
                runtimeState: 'READY',
                data: null,
                requestId: 'test',
                ...overrides,
            } as PairPayload<T>;
        }

        it('returns true when pair matches and data is fresh', () => {
            const payload = makePayload({ asOfMs: Date.now() });
            expect(isPairPayloadUsable(payload, 'XRP/RLUSD')).toBe(true);
        });

        it('returns false when pairKey does not match', () => {
            const payload = makePayload({ pairKey: 'XRP/USD' });
            expect(isPairPayloadUsable(payload, 'XRP/RLUSD')).toBe(false);
        });

        it('returns false when data is stale', () => {
            const payload = makePayload({ asOfMs: Date.now() - 60_000 });
            expect(isPairPayloadUsable(payload, 'XRP/RLUSD', 30_000)).toBe(false);
        });

        it('respects custom maxStalenessMs', () => {
            const payload = makePayload({ asOfMs: Date.now() - 5_000 });
            // 5s old, 10s threshold → usable
            expect(isPairPayloadUsable(payload, 'XRP/RLUSD', 10_000)).toBe(true);
            // 5s old, 3s threshold → stale
            expect(isPairPayloadUsable(payload, 'XRP/RLUSD', 3_000)).toBe(false);
        });
    });
});
