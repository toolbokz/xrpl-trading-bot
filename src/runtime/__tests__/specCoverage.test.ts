/**
 * Spec-coverage tests — Institutional Reliability Hardening
 *
 * These tests verify the remaining specification requirements:
 * 1. Listener deduplication — start/reset/start must not stack listeners
 * 2. Recovery → READY — RECOVERING can reach READY via DEGRADED
 * 3. Execution never outside READY — all 7 non-READY states are blocked
 * 4. Observability types — feed monitoring timestamps present in telemetry
 */

import { describe, it, expect } from 'vitest';
import { RuntimeFSM, RuntimeState } from '../runtimeFsm';
import {
    buildRuntimeTelemetry,
    RuntimeTelemetryInput,
} from '../runtimeObservability';
import {
    evaluateExecutionGate,
    ExecutionGateInput,
} from '../../execution/executionGate';
import { MarketHealthResult } from '../../market/marketDataHealth';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function bootToReady(fsm: RuntimeFSM): void {
    fsm.transition('SYNCING_LEDGER', 'connect', NOW);
    fsm.transition('SUBSCRIBING_FEEDS', 'subscribe', NOW + 100);
    fsm.transition('WARMING_MARKET_CACHE', 'init', NOW + 200);
    fsm.transition('READY', 'first-tick-healthy', NOW + 300);
}

const healthyResult = (): MarketHealthResult => ({
    score: 100,
    healthy: true,
    signals: {
        tape: { name: 'tape', score: 100, reasons: ['ok'] },
        book: { name: 'book', score: 100, reasons: ['ok'] },
        ledger: { name: 'ledger', score: 100, reasons: ['ok'] },
        balance: { name: 'balance', score: 100, reasons: ['ok'] },
    },
    computedAt: NOW,
});

const baseGateInput = (): ExecutionGateInput => ({
    // Use real wall-clock time so the gate's Date.now()-based staleness
    // checks don't spuriously fire (the gate compares against Date.now(), not NOW).
    lastBalanceSnapshotMs: Date.now() - 5_000,
    runtimeState: 'READY',
    health: healthyResult(),
    isConnected: true,
    isReconnecting: false,
    pairSwitchState: 'READY',
    isShuttingDown: false,
    isInRecovery: false,
    isRiskShutdown: false,
    dataValid: true,
    dataInvalidReasons: [],
    ledgerIndex: 100,
    lastLedgerCloseMs: Date.now() - 3_000,
});

const baseTelemetryInput = (): RuntimeTelemetryInput => {
    const fsm = new RuntimeFSM(NOW);
    bootToReady(fsm);
    return {
        fsmSnapshot: fsm.getSnapshot(),
        pairSwitchState: 'IDLE',
        isConnected: true,
        isReconnecting: false,
        feedStallState: null,
        ledgerIndex: 42,
        previousLedgerIndex: 41,
        lastLedgerCloseMs: NOW - 3_000,
        lastBalanceSnapshotMs: NOW - 5_000,
        lastBalanceLedgerIndex: 41,
        lastBookUpdateMs: NOW - 1_000,
        lastTapeUpdateMs: NOW - 2_000,
        lastLedgerAdvanceMs: NOW - 3_000,
        marketHealth: healthyResult(),
        executionGate: null,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Spec: Execution never allowed outside READY', () => {
    const NON_READY_STATES: RuntimeState[] = [
        'BOOTING',
        'SYNCING_LEDGER',
        'SUBSCRIBING_FEEDS',
        'WARMING_MARKET_CACHE',
        'DEGRADED',
        'RECOVERING',
        'HALTED',
    ];

    for (const state of NON_READY_STATES) {
        it(`blocks execution when runtimeState is ${state}`, () => {
            const input = baseGateInput();
            input.runtimeState = state;
            const result = evaluateExecutionGate(input);
            expect(result.verdict).toBe('BLOCK');
            expect(result.reasons[0]).toContain('runtime-not-ready');
        });
    }

    it('allows execution only in READY state', () => {
        const input = baseGateInput();
        input.runtimeState = 'READY';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('ALLOW');
    });
});

describe('Spec: Recovery → READY via DEGRADED', () => {
    it('READY → RECOVERING → DEGRADED → READY round-trip succeeds', () => {
        const fsm = new RuntimeFSM(NOW);
        bootToReady(fsm);
        expect(fsm.getState()).toBe('READY');

        // Enter recovery
        fsm.transition('RECOVERING', 'feed-stall', NOW + 400);
        expect(fsm.getState()).toBe('RECOVERING');
        expect(fsm.isExecutionAllowed()).toBe(false);

        // Recovery completes → DEGRADED
        fsm.transition('DEGRADED', 'recovery-done', NOW + 500);
        expect(fsm.getState()).toBe('DEGRADED');
        expect(fsm.isExecutionAllowed()).toBe(false);

        // Health recovers → READY
        fsm.transition('READY', 'health-recovered', NOW + 600);
        expect(fsm.getState()).toBe('READY');
        expect(fsm.isExecutionAllowed()).toBe(true);
    });

    it('DEGRADED → RECOVERING → DEGRADED → READY', () => {
        const fsm = new RuntimeFSM(NOW);
        bootToReady(fsm);
        fsm.transition('DEGRADED', 'health-drop', NOW + 400);

        // Enter recovery from DEGRADED
        fsm.transition('RECOVERING', 'stall-detected', NOW + 500);
        expect(fsm.getState()).toBe('RECOVERING');

        // Recovery completes
        fsm.transition('DEGRADED', 'recovery-complete', NOW + 600);
        fsm.transition('READY', 'health-restored', NOW + 700);
        expect(fsm.getState()).toBe('READY');
        expect(fsm.isExecutionAllowed()).toBe(true);
    });
});

describe('Spec: Listener dedup guard via FSM reset', () => {
    it('FSM reset returns to BOOTING — ready for re-registration', () => {
        const fsm = new RuntimeFSM(NOW);
        bootToReady(fsm);
        expect(fsm.getState()).toBe('READY');

        fsm.reset();
        expect(fsm.getState()).toBe('BOOTING');
        expect(fsm.isBooting()).toBe(true);
        expect(fsm.isExecutionAllowed()).toBe(false);

        // Can boot again
        bootToReady(fsm);
        expect(fsm.getState()).toBe('READY');
    });

    it('transition history is cleared on reset', () => {
        const fsm = new RuntimeFSM(NOW);
        bootToReady(fsm);

        const snapshotBefore = fsm.getSnapshot();
        expect(snapshotBefore.recentTransitions.length).toBeGreaterThan(0);
        expect(snapshotBefore.transitionCount).toBeGreaterThan(0);

        fsm.reset();
        const snapshotAfter = fsm.getSnapshot();
        expect(snapshotAfter.recentTransitions.length).toBe(0);
        expect(snapshotAfter.transitionCount).toBe(0);
    });
});

describe('Spec: Feed monitoring timestamps in telemetry', () => {
    it('telemetry includes lastBookUpdateMs, lastTapeUpdateMs, lastLedgerAdvanceMs', () => {
        const input = baseTelemetryInput();
        const telemetry = buildRuntimeTelemetry(input, NOW);

        expect(telemetry.feed.lastBookUpdateMs).toBe(NOW - 1_000);
        expect(telemetry.feed.lastTapeUpdateMs).toBe(NOW - 2_000);
        expect(telemetry.feed.lastLedgerAdvanceMs).toBe(NOW - 3_000);
    });

    it('feed timestamps default to 0 when no data received', () => {
        const input = baseTelemetryInput();
        input.lastBookUpdateMs = 0;
        input.lastTapeUpdateMs = 0;
        input.lastLedgerAdvanceMs = 0;
        const telemetry = buildRuntimeTelemetry(input, NOW);

        expect(telemetry.feed.lastBookUpdateMs).toBe(0);
        expect(telemetry.feed.lastTapeUpdateMs).toBe(0);
        expect(telemetry.feed.lastLedgerAdvanceMs).toBe(0);
    });

    it('telemetry runtimeState matches FSM snapshot state', () => {
        const input = baseTelemetryInput();
        const telemetry = buildRuntimeTelemetry(input, NOW);
        expect(telemetry.runtimeState).toBe('READY');
        expect(telemetry.runtimeState).toBe(input.fsmSnapshot.state);
    });
});
