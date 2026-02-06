import { describe, it, expect, beforeEach } from 'vitest';
import {
    ObservabilityBus,
    ObservabilityEvent,
    ObservabilityEventType,
    OBSERVABILITY_EVENT_TYPES,
} from '../eventBus';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBus(opts: { maxEvents?: number; dedupIntervalMs?: number } = {}): ObservabilityBus {
    return new ObservabilityBus(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core emit / query
// ─────────────────────────────────────────────────────────────────────────────

describe('ObservabilityBus', () => {
    let bus: ObservabilityBus;

    beforeEach(() => {
        bus = makeBus();
    });

    // ─── Canonical event types ───────────────────────────────────────────

    describe('canonical event types', () => {
        it('defines all required event types', () => {
            const required: ObservabilityEventType[] = [
                'FSM_TRANSITION',
                'PAIR_SWITCH_START',
                'PAIR_SWITCH_READY',
                'EXECUTION_BLOCKED',
                'EXECUTION_ALLOWED',
                'FEED_STALE',
                'FEED_RECOVERED',
                'XRPL_RECONNECTED',
                'XRPL_DISCONNECTED',
                'RISK_BLOCK',
                'DATA_INVALIDATED',
            ];
            for (const type of required) {
                expect(OBSERVABILITY_EVENT_TYPES).toContain(type);
            }
        });
    });

    // ─── Basic emission ──────────────────────────────────────────────────

    describe('basic emission', () => {
        it('emits an event with structured fields', () => {
            const event = bus.emit({
                eventType: 'FSM_TRANSITION',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                detail: { from: 'DEGRADED', to: 'READY', reason: 'health-recovered' },
                nowMs: 1000,
            });

            expect(event).not.toBeNull();
            expect(event!.seq).toBe(1);
            expect(event!.eventType).toBe('FSM_TRANSITION');
            expect(event!.pairKey).toBe('XRP/RLUSD');
            expect(event!.runtimeState).toBe('READY');
            expect(event!.detail).toEqual({ from: 'DEGRADED', to: 'READY', reason: 'health-recovered' });
            expect(event!.correlationId).toBeNull();
            expect(event!.timestampMs).toBe(1000);
            expect(event!.timestamp).toBe(new Date(1000).toISOString());
        });

        it('emits events with monotonically increasing seq', () => {
            bus.emit({ eventType: 'FEED_STALE', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { stage: 'BOOK_STALL' }, nowMs: 1 });
            bus.emit({ eventType: 'FEED_RECOVERED', pairKey: 'XRP/RLUSD', runtimeState: 'READY', nowMs: 2 });
            bus.emit({ eventType: 'RISK_BLOCK', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { reasons: ['dd'] }, nowMs: 3 });

            const events = bus.getAll();
            expect(events[0]!.seq).toBe(1);
            expect(events[1]!.seq).toBe(2);
            expect(events[2]!.seq).toBe(3);
        });

        it('includes correlationId when provided', () => {
            const event = bus.emit({
                eventType: 'EXECUTION_BLOCKED',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                correlationId: 'abc-123',
                detail: { reasons: ['risk-kill-switch'] },
            });

            expect(event!.correlationId).toBe('abc-123');
        });
    });

    // ─── Pair scoping ────────────────────────────────────────────────────

    describe('pair scoping', () => {
        it('every event carries the active pair key', () => {
            bus.emit({ eventType: 'FSM_TRANSITION', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { from: 'DEGRADED', to: 'READY' } });
            bus.emit({ eventType: 'EXECUTION_BLOCKED', pairKey: 'XRP/USD', runtimeState: 'DEGRADED', detail: { reasons: [] } });

            const events = bus.getAll();
            expect(events[0]!.pairKey).toBe('XRP/RLUSD');
            expect(events[1]!.pairKey).toBe('XRP/USD');
        });

        it('getByPair filters events by pair key', () => {
            bus.emit({ eventType: 'FSM_TRANSITION', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {}, nowMs: 1 });
            bus.emit({ eventType: 'FEED_STALE', pairKey: 'XRP/USD', runtimeState: 'READY', detail: {}, nowMs: 2 });
            bus.emit({ eventType: 'RISK_BLOCK', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {}, nowMs: 3 });

            const rlusdEvents = bus.getByPair('XRP/RLUSD');
            expect(rlusdEvents).toHaveLength(2);
            expect(rlusdEvents.every(e => e.pairKey === 'XRP/RLUSD')).toBe(true);

            const usdEvents = bus.getByPair('XRP/USD');
            expect(usdEvents).toHaveLength(1);
            expect(usdEvents[0]!.pairKey).toBe('XRP/USD');
        });
    });

    // ─── No duplicate event emission (dedup) ─────────────────────────────

    describe('dedup guard', () => {
        it('suppresses sequential identical events', () => {
            const e1 = bus.emit({
                eventType: 'RISK_BLOCK',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                detail: { reasons: ['drawdown-breached'], riskState: 'BLOCKED' },
            });
            const e2 = bus.emit({
                eventType: 'RISK_BLOCK',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                detail: { reasons: ['drawdown-breached'], riskState: 'BLOCKED' },
            });

            expect(e1).not.toBeNull();
            expect(e2).toBeNull(); // suppressed
            expect(bus.getCount()).toBe(1);
        });

        it('does not suppress events with different details', () => {
            bus.emit({
                eventType: 'RISK_BLOCK',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                detail: { reasons: ['drawdown-breached'], riskState: 'BLOCKED' },
            });
            const e2 = bus.emit({
                eventType: 'RISK_BLOCK',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                detail: { reasons: ['exposure-limit-exceeded'], riskState: 'BLOCKED' },
            });

            expect(e2).not.toBeNull();
            expect(bus.getCount()).toBe(2);
        });

        it('does not suppress events with different pair keys', () => {
            bus.emit({ eventType: 'FEED_STALE', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { stage: 'BOOK_STALL' } });
            const e2 = bus.emit({ eventType: 'FEED_STALE', pairKey: 'XRP/USD', runtimeState: 'READY', detail: { stage: 'BOOK_STALL' } });

            expect(e2).not.toBeNull();
            expect(bus.getCount()).toBe(2);
        });

        it('does not suppress different event types', () => {
            bus.emit({ eventType: 'FEED_STALE', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { stage: 'BOOK_STALL' } });
            const e2 = bus.emit({ eventType: 'FEED_RECOVERED', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });

            expect(e2).not.toBeNull();
            expect(bus.getCount()).toBe(2);
        });

        it('respects dedupIntervalMs for time-based dedup', () => {
            const timedBus = makeBus({ dedupIntervalMs: 1000 });
            timedBus.emit({ eventType: 'RISK_BLOCK', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { reasons: ['dd'] }, nowMs: 1000 });
            // Same event within interval → suppressed
            const e2 = timedBus.emit({ eventType: 'RISK_BLOCK', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { reasons: ['dd'] }, nowMs: 1500 });
            expect(e2).toBeNull();
            // Same event after interval → allowed
            const e3 = timedBus.emit({ eventType: 'RISK_BLOCK', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { reasons: ['dd'] }, nowMs: 2001 });
            expect(e3).not.toBeNull();
        });
    });

    // ─── Ring buffer ─────────────────────────────────────────────────────

    describe('ring buffer', () => {
        it('limits events to maxEvents', () => {
            const smallBus = makeBus({ maxEvents: 5 });
            for (let i = 0; i < 10; i++) {
                smallBus.emit({
                    eventType: 'FSM_TRANSITION',
                    pairKey: 'XRP/RLUSD',
                    runtimeState: 'READY',
                    detail: { from: `s${i}`, to: `s${i + 1}` },
                    nowMs: i,
                });
            }
            expect(smallBus.getCount()).toBe(5);
        });

        it('preserves most recent events', () => {
            const smallBus = makeBus({ maxEvents: 3 });
            for (let i = 0; i < 6; i++) {
                smallBus.emit({
                    eventType: 'DATA_INVALIDATED',
                    pairKey: 'XRP/RLUSD',
                    runtimeState: 'READY',
                    detail: { reasons: [`reason-${i}`], sequence: i },
                    nowMs: i * 100,
                });
            }
            const all = bus.getAll();
            // Newest should be the last emitted
            const recent = smallBus.getRecent(3);
            expect(recent[0]!.detail.sequence).toBe(5);
        });
    });

    // ─── Convenience emitters ────────────────────────────────────────────

    describe('emitFsmTransition', () => {
        it('emits FSM_TRANSITION with from/to/reason', () => {
            const event = bus.emitFsmTransition({
                from: 'WARMING_MARKET_CACHE',
                to: 'READY',
                reason: 'first-tick-healthy',
                pairKey: 'XRP/RLUSD',
            });

            expect(event).not.toBeNull();
            expect(event!.eventType).toBe('FSM_TRANSITION');
            expect(event!.runtimeState).toBe('READY');
            expect(event!.detail).toEqual({
                from: 'WARMING_MARKET_CACHE',
                to: 'READY',
                reason: 'first-tick-healthy',
            });
        });
    });

    describe('emitPairSwitchStart', () => {
        it('emits PAIR_SWITCH_START with fromPair/toPair', () => {
            const event = bus.emitPairSwitchStart({
                fromPair: 'XRP/RLUSD',
                toPair: 'XRP/USD',
                runtimeState: 'READY',
            });

            expect(event!.eventType).toBe('PAIR_SWITCH_START');
            expect(event!.pairKey).toBe('XRP/USD'); // target pair
            expect(event!.detail).toEqual({ fromPair: 'XRP/RLUSD', toPair: 'XRP/USD' });
        });
    });

    describe('emitPairSwitchReady', () => {
        it('emits PAIR_SWITCH_READY with durationMs', () => {
            const event = bus.emitPairSwitchReady({
                pairKey: 'XRP/USD',
                runtimeState: 'READY',
                durationMs: 450,
            });

            expect(event!.eventType).toBe('PAIR_SWITCH_READY');
            expect(event!.detail).toEqual({ durationMs: 450 });
        });
    });

    // ─── Gate verdict edge detection ─────────────────────────────────────

    describe('evaluateGateVerdict', () => {
        it('emits EXECUTION_BLOCKED on transition from allowed → blocked', () => {
            const event = bus.evaluateGateVerdict({
                blocked: true,
                reasons: ['health-quorum-below-threshold'],
                healthScore: 30,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'DEGRADED',
            });

            expect(event).not.toBeNull();
            expect(event!.eventType).toBe('EXECUTION_BLOCKED');
            expect(event!.detail).toEqual({
                reasons: ['health-quorum-below-threshold'],
                healthScore: 30,
            });
        });

        it('does not emit when staying blocked', () => {
            bus.evaluateGateVerdict({
                blocked: true,
                reasons: ['risk-kill-switch'],
                healthScore: 50,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
            });
            const e2 = bus.evaluateGateVerdict({
                blocked: true,
                reasons: ['risk-kill-switch'],
                healthScore: 50,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
            });

            expect(e2).toBeNull();
        });

        it('emits EXECUTION_ALLOWED on transition from blocked → allowed', () => {
            bus.evaluateGateVerdict({
                blocked: true,
                reasons: ['ledger-stalled'],
                healthScore: 20,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'DEGRADED',
            });
            const event = bus.evaluateGateVerdict({
                blocked: false,
                reasons: [],
                healthScore: 80,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
            });

            expect(event).not.toBeNull();
            expect(event!.eventType).toBe('EXECUTION_ALLOWED');
            expect(event!.detail).toEqual({ healthScore: 80 });
        });

        it('does not emit when staying allowed', () => {
            const e1 = bus.evaluateGateVerdict({
                blocked: false,
                reasons: [],
                healthScore: 100,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
            });
            const e2 = bus.evaluateGateVerdict({
                blocked: false,
                reasons: [],
                healthScore: 100,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
            });

            expect(e1).toBeNull(); // was never blocked
            expect(e2).toBeNull();
        });

        it('supports correlationId for execution trace linkage', () => {
            const event = bus.evaluateGateVerdict({
                blocked: true,
                reasons: ['snapshot-invalid'],
                healthScore: 0,
                pairKey: 'XRP/RLUSD',
                runtimeState: 'DEGRADED',
                correlationId: 'trace-abc-123',
            });

            expect(event!.correlationId).toBe('trace-abc-123');
        });
    });

    // ─── Feed stale/recovered ────────────────────────────────────────────

    describe('emitFeedStale + emitFeedRecovered', () => {
        it('emits FEED_STALE with stage', () => {
            const event = bus.emitFeedStale({
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                stage: 'BOOK_STALL',
            });

            expect(event!.eventType).toBe('FEED_STALE');
            expect(event!.detail).toEqual({ stage: 'BOOK_STALL' });
        });

        it('emits FEED_RECOVERED', () => {
            const event = bus.emitFeedRecovered({
                pairKey: 'XRP/RLUSD',
                runtimeState: 'DEGRADED',
            });

            expect(event!.eventType).toBe('FEED_RECOVERED');
        });
    });

    // ─── XRPL lifecycle ──────────────────────────────────────────────────

    describe('XRPL lifecycle events', () => {
        it('emits XRPL_RECONNECTED', () => {
            const event = bus.emitXrplReconnected({
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
            });

            expect(event!.eventType).toBe('XRPL_RECONNECTED');
        });

        it('emits XRPL_DISCONNECTED', () => {
            const event = bus.emitXrplDisconnected({
                pairKey: 'XRP/RLUSD',
                runtimeState: 'DEGRADED',
            });

            expect(event!.eventType).toBe('XRPL_DISCONNECTED');
        });
    });

    // ─── Risk block ──────────────────────────────────────────────────────

    describe('emitRiskBlock', () => {
        it('emits RISK_BLOCK with reasons and riskState', () => {
            const event = bus.emitRiskBlock({
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                reasons: ['drawdown-breached', 'exposure-limit-exceeded'],
                riskState: 'BLOCKED',
            });

            expect(event!.eventType).toBe('RISK_BLOCK');
            expect(event!.detail).toEqual({
                reasons: ['drawdown-breached', 'exposure-limit-exceeded'],
                riskState: 'BLOCKED',
            });
        });
    });

    // ─── Data invalidated ────────────────────────────────────────────────

    describe('emitDataInvalidated', () => {
        it('emits DATA_INVALIDATED with reasons and sequence', () => {
            const event = bus.emitDataInvalidated({
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                reasons: ['sequence-gap-detected', 'timestamp-regression'],
                sequence: 42,
            });

            expect(event!.eventType).toBe('DATA_INVALIDATED');
            expect(event!.detail).toEqual({
                reasons: ['sequence-gap-detected', 'timestamp-regression'],
                sequence: 42,
            });
        });
    });

    // ─── Query methods ───────────────────────────────────────────────────

    describe('query methods', () => {
        beforeEach(() => {
            bus.emit({ eventType: 'FSM_TRANSITION', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { from: 'A', to: 'B' }, nowMs: 100 });
            bus.emit({ eventType: 'FEED_STALE', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { stage: 'X' }, nowMs: 200 });
            bus.emit({ eventType: 'FSM_TRANSITION', pairKey: 'XRP/USD', runtimeState: 'DEGRADED', detail: { from: 'B', to: 'C' }, nowMs: 300 });
            bus.emit({ eventType: 'RISK_BLOCK', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: { reasons: ['dd'] }, nowMs: 400 });
        });

        it('getAll returns events in insertion order', () => {
            const all = bus.getAll();
            expect(all).toHaveLength(4);
            expect(all[0]!.seq).toBe(1);
            expect(all[3]!.seq).toBe(4);
        });

        it('getRecent returns events newest-first', () => {
            const recent = bus.getRecent(2);
            expect(recent).toHaveLength(2);
            expect(recent[0]!.seq).toBe(4); // newest
            expect(recent[1]!.seq).toBe(3);
        });

        it('getByType filters by event type', () => {
            const fsm = bus.getByType('FSM_TRANSITION');
            expect(fsm).toHaveLength(2);
            expect(fsm.every(e => e.eventType === 'FSM_TRANSITION')).toBe(true);
        });

        it('getSince returns events after given seq', () => {
            const events = bus.getSince(2);
            expect(events).toHaveLength(2);
            expect(events[0]!.seq).toBe(3);
            expect(events[1]!.seq).toBe(4);
        });

        it('getTimeRange returns events in time window', () => {
            const events = bus.getTimeRange(150, 350);
            expect(events).toHaveLength(2);
            expect(events[0]!.timestampMs).toBe(200);
            expect(events[1]!.timestampMs).toBe(300);
        });

        it('getSeq returns current sequence number', () => {
            expect(bus.getSeq()).toBe(4);
        });

        it('getSummary returns event counts by type', () => {
            const summary = bus.getSummary();
            expect(summary.FSM_TRANSITION).toBe(2);
            expect(summary.FEED_STALE).toBe(1);
            expect(summary.RISK_BLOCK).toBe(1);
            expect(summary.EXECUTION_BLOCKED).toBe(0);
        });
    });

    // ─── Logging format ──────────────────────────────────────────────────

    describe('logging format', () => {
        it('event has JSON-structured timestamp', () => {
            const nowMs = 1706220000000;
            const event = bus.emit({
                eventType: 'FSM_TRANSITION',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                detail: {},
                nowMs,
            });

            expect(event!.timestamp).toBe(new Date(nowMs).toISOString());
            expect(event!.timestampMs).toBe(nowMs);
        });

        it('event has all required fields for structured logging', () => {
            const event = bus.emit({
                eventType: 'EXECUTION_BLOCKED',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'DEGRADED',
                correlationId: 'trace-1',
                detail: { reasons: ['ledger-stalled'] },
                nowMs: 1000,
            });

            // Verify all required JSON fields per spec
            expect(event).toHaveProperty('timestamp');
            expect(event).toHaveProperty('eventType');
            expect(event).toHaveProperty('pairKey');
            expect(event).toHaveProperty('runtimeState');
            expect(event).toHaveProperty('correlationId');
            expect(event).toHaveProperty('seq');
            expect(event).toHaveProperty('detail');
        });
    });

    // ─── Clear/reset ─────────────────────────────────────────────────────

    describe('clear', () => {
        it('clears all events and resets state', () => {
            bus.emit({ eventType: 'FSM_TRANSITION', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });
            bus.evaluateGateVerdict({ blocked: true, reasons: [], healthScore: 0, pairKey: 'XRP/RLUSD', runtimeState: 'READY' });
            expect(bus.getCount()).toBeGreaterThan(0);
            expect(bus.isBlocked()).toBe(true);

            bus.clear();

            expect(bus.getCount()).toBe(0);
            expect(bus.getSeq()).toBe(0);
            expect(bus.isBlocked()).toBe(false);
        });
    });

    // ─── Edge case: empty bus ────────────────────────────────────────────

    describe('empty bus', () => {
        it('getAll returns empty array', () => {
            expect(bus.getAll()).toEqual([]);
        });

        it('getRecent returns empty array', () => {
            expect(bus.getRecent()).toEqual([]);
        });

        it('getSeq returns 0', () => {
            expect(bus.getSeq()).toBe(0);
        });

        it('getSummary returns all zeroes', () => {
            const summary = bus.getSummary();
            for (const type of OBSERVABILITY_EVENT_TYPES) {
                expect(summary[type]).toBe(0);
            }
        });

        it('isBlocked returns false', () => {
            expect(bus.isBlocked()).toBe(false);
        });
    });

    // ─── Full lifecycle scenario ─────────────────────────────────────────

    describe('full lifecycle scenario', () => {
        it('traces a complete pair switch with FSM transitions', () => {
            // 1. FSM transitions during startup
            bus.emitFsmTransition({ from: 'BOOTING', to: 'SYNCING_LEDGER', reason: 'xrpl-connecting', pairKey: 'XRP/RLUSD', nowMs: 100 });
            bus.emitFsmTransition({ from: 'SYNCING_LEDGER', to: 'SUBSCRIBING_FEEDS', reason: 'xrpl-subscribing', pairKey: 'XRP/RLUSD', nowMs: 200 });
            bus.emitFsmTransition({ from: 'SUBSCRIBING_FEEDS', to: 'WARMING_MARKET_CACHE', reason: 'components-initialized', pairKey: 'XRP/RLUSD', nowMs: 300 });
            bus.emitFsmTransition({ from: 'WARMING_MARKET_CACHE', to: 'READY', reason: 'first-tick-healthy', pairKey: 'XRP/RLUSD', nowMs: 400 });

            // 2. Normal operation → degraded → recovered
            bus.emitFsmTransition({ from: 'READY', to: 'DEGRADED', reason: 'health-degraded:35', pairKey: 'XRP/RLUSD', nowMs: 500 });
            bus.evaluateGateVerdict({ blocked: true, reasons: ['health-quorum-below-threshold'], healthScore: 35, pairKey: 'XRP/RLUSD', runtimeState: 'DEGRADED', nowMs: 510 });
            bus.emitFeedStale({ pairKey: 'XRP/RLUSD', runtimeState: 'DEGRADED', stage: 'BOOK_STALL', nowMs: 520 });
            bus.emitFeedRecovered({ pairKey: 'XRP/RLUSD', runtimeState: 'DEGRADED', nowMs: 600 });
            bus.emitFsmTransition({ from: 'DEGRADED', to: 'READY', reason: 'health-recovered:85', pairKey: 'XRP/RLUSD', nowMs: 700 });
            bus.evaluateGateVerdict({ blocked: false, reasons: [], healthScore: 85, pairKey: 'XRP/RLUSD', runtimeState: 'READY', nowMs: 710 });

            // 3. Pair switch
            bus.emitPairSwitchStart({ fromPair: 'XRP/RLUSD', toPair: 'XRP/USD', runtimeState: 'READY', nowMs: 800 });
            bus.emitPairSwitchReady({ pairKey: 'XRP/USD', runtimeState: 'READY', durationMs: 150, nowMs: 950 });

            // Verify event stream integrity
            const all = bus.getAll();
            expect(all).toHaveLength(12);

            // Verify event types in order
            const types = all.map(e => e.eventType);
            expect(types).toEqual([
                'FSM_TRANSITION', 'FSM_TRANSITION', 'FSM_TRANSITION', 'FSM_TRANSITION',
                'FSM_TRANSITION', 'EXECUTION_BLOCKED',
                'FEED_STALE', 'FEED_RECOVERED',
                'FSM_TRANSITION', 'EXECUTION_ALLOWED',
                'PAIR_SWITCH_START', 'PAIR_SWITCH_READY',
            ]);

            // Verify pair scoping
            const rlusdEvents = bus.getByPair('XRP/RLUSD');
            const usdEvents = bus.getByPair('XRP/USD');
            expect(rlusdEvents.length).toBe(10);
            expect(usdEvents.length).toBe(2); // PAIR_SWITCH_START + PAIR_SWITCH_READY
        });
    });
});
