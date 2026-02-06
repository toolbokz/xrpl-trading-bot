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
});
