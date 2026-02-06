import { describe, it, expect } from 'vitest';
import { RuntimeFSM, RuntimeState, isValidTransition } from '../runtimeFsm';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

function bootToReady(fsm: RuntimeFSM, t: number = T0): void {
    fsm.transition('SYNCING_LEDGER', 'connect', t);
    fsm.transition('SUBSCRIBING_FEEDS', 'subscribe', t + 100);
    fsm.transition('WARMING_MARKET_CACHE', 'components-init', t + 200);
    fsm.transition('READY', 'first-tick-healthy', t + 300);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RuntimeFSM', () => {
    // ─── Initial state ───────────────────────────────────────────────────

    it('starts in BOOTING state', () => {
        const fsm = new RuntimeFSM(T0);
        expect(fsm.getState()).toBe('BOOTING');
        expect(fsm.isBooting()).toBe(true);
        expect(fsm.isExecutionAllowed()).toBe(false);
        expect(fsm.isHalted()).toBe(false);
    });

    // ─── Boot sequence (happy path) ─────────────────────────────────────

    it('follows the full boot sequence to READY', () => {
        const fsm = new RuntimeFSM(T0);

        expect(fsm.transition('SYNCING_LEDGER', 'connect', T0 + 10)).toBe(true);
        expect(fsm.getState()).toBe('SYNCING_LEDGER');
        expect(fsm.isBooting()).toBe(true);

        expect(fsm.transition('SUBSCRIBING_FEEDS', 'subscribe', T0 + 20)).toBe(true);
        expect(fsm.getState()).toBe('SUBSCRIBING_FEEDS');
        expect(fsm.isBooting()).toBe(true);

        expect(fsm.transition('WARMING_MARKET_CACHE', 'init-complete', T0 + 30)).toBe(true);
        expect(fsm.getState()).toBe('WARMING_MARKET_CACHE');
        expect(fsm.isBooting()).toBe(true);

        expect(fsm.transition('READY', 'first-tick', T0 + 40)).toBe(true);
        expect(fsm.getState()).toBe('READY');
        expect(fsm.isBooting()).toBe(false);
        expect(fsm.isExecutionAllowed()).toBe(true);
    });

    it('can go from WARMING_MARKET_CACHE to DEGRADED (first tick unhealthy)', () => {
        const fsm = new RuntimeFSM(T0);
        fsm.transition('SYNCING_LEDGER', 'connect', T0);
        fsm.transition('SUBSCRIBING_FEEDS', 'subscribe', T0);
        fsm.transition('WARMING_MARKET_CACHE', 'init', T0);

        expect(fsm.transition('DEGRADED', 'first-tick-unhealthy', T0 + 100)).toBe(true);
        expect(fsm.getState()).toBe('DEGRADED');
        expect(fsm.isExecutionAllowed()).toBe(false);
        expect(fsm.isDegraded()).toBe(true);
    });

    // ─── Idempotent transitions ──────────────────────────────────────────

    it('no-op transition to the same state returns false', () => {
        const fsm = new RuntimeFSM(T0);
        expect(fsm.transition('BOOTING', 'no-op')).toBe(false);
        expect(fsm.getState()).toBe('BOOTING');
    });

    // ─── Invalid transitions throw ──────────────────────────────────────

    it('throws on invalid transition BOOTING → READY', () => {
        const fsm = new RuntimeFSM(T0);
        expect(() => fsm.transition('READY', 'skip-boot')).toThrow(/Invalid RuntimeFSM transition/);
    });

    it('throws on invalid transition BOOTING → RECOVERING', () => {
        const fsm = new RuntimeFSM(T0);
        expect(() => fsm.transition('RECOVERING', 'bad')).toThrow(/Invalid RuntimeFSM transition/);
    });

    it('throws on transition out of HALTED', () => {
        const fsm = new RuntimeFSM(T0);
        fsm.transition('HALTED', 'shutdown', T0);
        expect(() => fsm.transition('BOOTING', 'restart')).toThrow(/Invalid RuntimeFSM transition/);
    });

    // ─── Operational state transitions ───────────────────────────────────

    it('READY → DEGRADED → READY round-trip', () => {
        const fsm = new RuntimeFSM(T0);
        bootToReady(fsm);
        expect(fsm.getState()).toBe('READY');

        fsm.transition('DEGRADED', 'health-drop', T0 + 500);
        expect(fsm.isDegraded()).toBe(true);
        expect(fsm.isExecutionAllowed()).toBe(false);

        fsm.transition('READY', 'health-recovered', T0 + 600);
        expect(fsm.isExecutionAllowed()).toBe(true);
    });

    it('READY → RECOVERING → READY recovery round-trip', () => {
        const fsm = new RuntimeFSM(T0);
        bootToReady(fsm);

        fsm.transition('RECOVERING', 'feed-stall', T0 + 500);
        expect(fsm.isRecovering()).toBe(true);
        expect(fsm.isExecutionAllowed()).toBe(false);

        fsm.transition('READY', 'feed-recovered', T0 + 600);
        expect(fsm.isExecutionAllowed()).toBe(true);
    });

    it('READY → RECOVERING → DEGRADED (recovery completed but health still bad)', () => {
        const fsm = new RuntimeFSM(T0);
        bootToReady(fsm);

        fsm.transition('RECOVERING', 'stall', T0 + 500);
        fsm.transition('DEGRADED', 'recovery-done-unhealthy', T0 + 600);
        expect(fsm.isDegraded()).toBe(true);
    });

    it('DEGRADED → RECOVERING → READY', () => {
        const fsm = new RuntimeFSM(T0);
        bootToReady(fsm);
        fsm.transition('DEGRADED', 'health-drop', T0 + 500);
        fsm.transition('RECOVERING', 'stall', T0 + 600);
        fsm.transition('READY', 'recovered', T0 + 700);
        expect(fsm.isExecutionAllowed()).toBe(true);
    });

    // ─── HALTED is terminal ──────────────────────────────────────────────

    it('HALTED is reachable from every operational state', () => {
        const states: RuntimeState[] = [
            'BOOTING',
            'SYNCING_LEDGER',
            'SUBSCRIBING_FEEDS',
            'WARMING_MARKET_CACHE',
            'READY',
            'DEGRADED',
            'RECOVERING',
        ];

        for (const s of states) {
            expect(isValidTransition(s, 'HALTED')).toBe(true);
        }
    });

    it('HALTED has no outgoing transitions', () => {
        const targets: RuntimeState[] = [
            'BOOTING',
            'SYNCING_LEDGER',
            'SUBSCRIBING_FEEDS',
            'WARMING_MARKET_CACHE',
            'READY',
            'DEGRADED',
            'RECOVERING',
        ];

        for (const t of targets) {
            expect(isValidTransition('HALTED', t)).toBe(false);
        }
    });

    // ─── forceHalt ───────────────────────────────────────────────────────

    it('forceHalt() transitions to HALTED from any state', () => {
        const fsm = new RuntimeFSM(T0);
        bootToReady(fsm);
        fsm.forceHalt('emergency', T0 + 1000);
        expect(fsm.isHalted()).toBe(true);
    });

    it('forceHalt() is idempotent if already HALTED', () => {
        const fsm = new RuntimeFSM(T0);
        fsm.transition('HALTED', 'shutdown', T0);
        fsm.forceHalt('again', T0 + 100);
        expect(fsm.isHalted()).toBe(true);
    });

    // ─── Snapshot / history ──────────────────────────────────────────────

    it('getSnapshot() returns correct state and transition count', () => {
        const fsm = new RuntimeFSM(T0);
        bootToReady(fsm, T0);

        const snap = fsm.getSnapshot(T0 + 1000);
        expect(snap.state).toBe('READY');
        expect(snap.transitionCount).toBe(4);
        expect(snap.durationMs).toBe(700); // enteredAt = T0+300, now = T0+1000
        expect(snap.recentTransitions).toHaveLength(4);
        expect(snap.recentTransitions[0].from).toBe('BOOTING');
        expect(snap.recentTransitions[0].to).toBe('SYNCING_LEDGER');
        expect(snap.recentTransitions[3].to).toBe('READY');
    });

    it('durationInCurrentState() is accurate', () => {
        const fsm = new RuntimeFSM(T0);
        expect(fsm.durationInCurrentState(T0 + 5000)).toBe(5000);
    });

    // ─── reset() ─────────────────────────────────────────────────────────

    it('reset() restores BOOTING state and clears history', () => {
        const fsm = new RuntimeFSM(T0);
        bootToReady(fsm);
        fsm.forceHalt('shutdown');

        fsm.reset(T0 + 2000);
        expect(fsm.getState()).toBe('BOOTING');
        expect(fsm.getSnapshot().transitionCount).toBe(0);
        expect(fsm.getSnapshot().recentTransitions).toHaveLength(0);
    });

    // ─── isValidTransition() helper ──────────────────────────────────────

    it('isValidTransition() checks adjacency correctly', () => {
        expect(isValidTransition('BOOTING', 'SYNCING_LEDGER')).toBe(true);
        expect(isValidTransition('BOOTING', 'READY')).toBe(false);
        expect(isValidTransition('READY', 'DEGRADED')).toBe(true);
        expect(isValidTransition('READY', 'BOOTING')).toBe(false);
        expect(isValidTransition('RECOVERING', 'READY')).toBe(true);
        expect(isValidTransition('RECOVERING', 'DEGRADED')).toBe(true);
        expect(isValidTransition('HALTED', 'BOOTING')).toBe(false);
    });
});
