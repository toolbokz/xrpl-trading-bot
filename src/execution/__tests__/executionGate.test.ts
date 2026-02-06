import { describe, it, expect } from 'vitest';
import {
    evaluateExecutionGate,
    DEFAULT_GATE_CONFIG,
    ExecutionGateInput,
} from '../executionGate';
import { MarketHealthResult } from '../../market/marketDataHealth';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

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

const baseInput = (): ExecutionGateInput => ({
    runtimeState: 'READY',
    health: healthyResult(),
    isConnected: true,
    isReconnecting: false,
    pairSwitchState: 'IDLE',
    isShuttingDown: false,
    isInRecovery: false,
    ledgerIndex: 100,
    lastLedgerCloseMs: Date.now() - 3_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateExecutionGate', () => {
    it('ALLOW when everything is healthy', () => {
        const result = evaluateExecutionGate(baseInput());
        expect(result.verdict).toBe('ALLOW');
        expect(result.healthScore).toBe(100);
    });

    it('BLOCK when shutting down', () => {
        const input = baseInput();
        input.isShuttingDown = true;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toContain('shutdown-in-progress');
    });

    it('BLOCK when feed disconnected', () => {
        const input = baseInput();
        input.isConnected = false;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toContain('feed-disconnected');
    });

    it('BLOCK when feed reconnecting', () => {
        const input = baseInput();
        input.isReconnecting = true;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toContain('feed-reconnecting');
    });

    it('BLOCK during pair switch (SWITCHING)', () => {
        const input = baseInput();
        input.pairSwitchState = 'SWITCHING';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/pair-switch-state/);
    });

    it('BLOCK during pair switch (SYNCING)', () => {
        const input = baseInput();
        input.pairSwitchState = 'SYNCING';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
    });

    it('ALLOW when pair switch is IDLE or READY', () => {
        for (const state of ['IDLE', 'READY', 'FAILED'] as const) {
            const input = baseInput();
            input.pairSwitchState = state;
            expect(evaluateExecutionGate(input).verdict).toBe('ALLOW');
        }
    });

    it('BLOCK when stall recovery in progress', () => {
        const input = baseInput();
        input.isInRecovery = true;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toContain('stall-recovery-in-progress');
    });

    it('BLOCK when ledger is stalled', () => {
        const input = baseInput();
        input.lastLedgerCloseMs = Date.now() - 120_000; // 2 minutes stale
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/ledger-stalled/);
    });

    it('BLOCK when health score below threshold', () => {
        const input = baseInput();
        input.lastLedgerCloseMs = Date.now() - 3_000;
        input.health = {
            ...healthyResult(),
            score: 30,
            healthy: false,
            signals: {
                ...healthyResult().signals,
                tape: { name: 'tape', score: 0, reasons: ['no-tape-events'] },
                book: { name: 'book', score: 20, reasons: ['book-stale:50000ms'] },
            },
        };
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/health-below-threshold/);
        // Should include signal-level reasons for degraded signals
        expect(result.reasons.some(r => r.includes('signal-tape'))).toBe(true);
        expect(result.reasons.some(r => r.includes('signal-book'))).toBe(true);
    });

    it('respects custom minHealthScore', () => {
        const input = baseInput();
        input.health = { ...healthyResult(), score: 80, healthy: true };
        // Default threshold 50 → ALLOW
        expect(evaluateExecutionGate(input).verdict).toBe('ALLOW');
        // Raise threshold to 90 → BLOCK
        expect(evaluateExecutionGate(input, { ...DEFAULT_GATE_CONFIG, minHealthScore: 90 }).verdict).toBe('BLOCK');
    });

    it('checks precedence: shutdown wins over everything', () => {
        const input = baseInput();
        input.isShuttingDown = true;
        input.isConnected = false;
        input.pairSwitchState = 'SWITCHING';
        input.isInRecovery = true;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toEqual(['shutdown-in-progress']);
    });

    // ─── Runtime FSM state checks ────────────────────────────────────────

    it('BLOCK when runtimeState is BOOTING', () => {
        const input = baseInput();
        input.runtimeState = 'BOOTING';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/runtime-not-ready:BOOTING/);
    });

    it('BLOCK when runtimeState is SYNCING_LEDGER', () => {
        const input = baseInput();
        input.runtimeState = 'SYNCING_LEDGER';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/runtime-not-ready/);
    });

    it('BLOCK when runtimeState is SUBSCRIBING_FEEDS', () => {
        const input = baseInput();
        input.runtimeState = 'SUBSCRIBING_FEEDS';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/runtime-not-ready/);
    });

    it('BLOCK when runtimeState is WARMING_MARKET_CACHE', () => {
        const input = baseInput();
        input.runtimeState = 'WARMING_MARKET_CACHE';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/runtime-not-ready/);
    });

    it('BLOCK when runtimeState is DEGRADED', () => {
        const input = baseInput();
        input.runtimeState = 'DEGRADED';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/runtime-not-ready:DEGRADED/);
    });

    it('BLOCK when runtimeState is RECOVERING', () => {
        const input = baseInput();
        input.runtimeState = 'RECOVERING';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/runtime-not-ready:RECOVERING/);
    });

    it('BLOCK when runtimeState is HALTED', () => {
        const input = baseInput();
        input.runtimeState = 'HALTED';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/runtime-not-ready:HALTED/);
    });

    it('ALLOW when runtimeState is READY', () => {
        const input = baseInput();
        input.runtimeState = 'READY';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('ALLOW');
    });

    it('runtime-not-ready takes precedence over feed/health but not shutdown', () => {
        // shutdown still wins
        const input1 = baseInput();
        input1.runtimeState = 'DEGRADED';
        input1.isShuttingDown = true;
        const r1 = evaluateExecutionGate(input1);
        expect(r1.reasons).toEqual(['shutdown-in-progress']);

        // runtime-not-ready wins over feed disconnect
        const input2 = baseInput();
        input2.runtimeState = 'WARMING_MARKET_CACHE';
        input2.isConnected = false;
        const r2 = evaluateExecutionGate(input2);
        expect(r2.reasons[0]).toMatch(/runtime-not-ready/);
    });
});
