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
    pairSwitchState: 'READY',
    isShuttingDown: false,
    isInRecovery: false,
    isRiskShutdown: false,
    dataValid: true,
    dataInvalidReasons: [],
    ledgerIndex: 100,
    lastLedgerCloseMs: Date.now() - 3_000,
    lastBalanceSnapshotMs: Date.now() - 5_000,
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

    it('BLOCK during pair switch (FREEZE_EXECUTION)', () => {
        const input = baseInput();
        input.pairSwitchState = 'FREEZE_EXECUTION';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/pair-switch-phase/);
    });

    it('BLOCK during pair switch (WAIT_FIRST_BOOK)', () => {
        const input = baseInput();
        input.pairSwitchState = 'WAIT_FIRST_BOOK';
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
    });

    it('ALLOW only when pair switch phase is READY', () => {
        const readyInput = baseInput();
        readyInput.pairSwitchState = 'READY';
        expect(evaluateExecutionGate(readyInput).verdict).toBe('ALLOW');
    });

    it('BLOCK when pair switch phase is FAILED', () => {
        const input = baseInput();
        input.pairSwitchState = 'FAILED';
        expect(evaluateExecutionGate(input).verdict).toBe('BLOCK');
    });

    it('BLOCK for every non-READY pair switch phase', () => {
        const nonReadyPhases = [
            'FREEZE_EXECUTION', 'UNSUBSCRIBE_OLD_FEEDS', 'DESTROY_PAIR_CONTEXT',
            'RESET_PAIR_METRICS_WINDOWS', 'CREATE_NEW_PAIR_CONTEXT', 'SUBSCRIBE_NEW_FEEDS',
            'WAIT_FIRST_BOOK', 'WAIT_FIRST_TAPE', 'REFRESH_BALANCES',
            'VALIDATE_DATA_TRUTH', 'FAILED',
        ] as const;
        for (const phase of nonReadyPhases) {
            const input = baseInput();
            input.pairSwitchState = phase;
            const result = evaluateExecutionGate(input);
            expect(result.verdict).toBe('BLOCK');
            expect(result.reasons[0]).toContain(`pair-switch-phase:${phase}`);
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
        input.pairSwitchState = 'FREEZE_EXECUTION';
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

    // ─── Risk engine kill-switch checks ──────────────────────────────────

    it('BLOCK when risk engine is shutdown', () => {
        const input = baseInput();
        input.isRiskShutdown = true;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toContain('risk-engine-blocked');
    });

    it('risk-engine-blocked yields to stall-recovery (higher priority)', () => {
        const input = baseInput();
        input.isInRecovery = true;
        input.isRiskShutdown = true;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        // stall recovery is check 5, risk is check 6 — stall wins
        expect(result.reasons).toEqual(['stall-recovery-in-progress']);
    });

    it('risk-engine-blocked takes precedence over ledger-stalled', () => {
        const input = baseInput();
        input.isRiskShutdown = true;
        input.lastLedgerCloseMs = Date.now() - 120_000; // stale ledger
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toEqual(['risk-engine-blocked']);
    });

    // ─── Snapshot validation checks ──────────────────────────────────────

    it('BLOCK when snapshot data is invalid', () => {
        const input = baseInput();
        input.dataValid = false;
        input.dataInvalidReasons = ['sequence-gap:expected=5,got=7'];
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toContain('snapshot-invalid');
        expect(result.reasons).toContain('data:sequence-gap:expected=5,got=7');
    });

    it('snapshot-invalid yields to risk-engine-blocked (higher priority)', () => {
        const input = baseInput();
        input.isRiskShutdown = true;
        input.dataValid = false;
        input.dataInvalidReasons = ['crossed-book'];
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons).toEqual(['risk-engine-blocked']);
    });

    it('snapshot-invalid takes precedence over ledger-stalled', () => {
        const input = baseInput();
        input.dataValid = false;
        input.dataInvalidReasons = ['nan-or-infinite:bestBid=NaN'];
        input.lastLedgerCloseMs = Date.now() - 120_000;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toBe('snapshot-invalid');
    });

    // ─── Balance staleness checks ────────────────────────────────────────

    it('BLOCK when balance snapshot is stale (>120s)', () => {
        const input = baseInput();
        input.lastBalanceSnapshotMs = Date.now() - 150_000; // 150s > 120s default
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/^balance-stale:/);
    });

    it('ALLOW when balance snapshot is fresh (<120s)', () => {
        const input = baseInput();
        input.lastBalanceSnapshotMs = Date.now() - 60_000; // 60s < 120s default
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('ALLOW');
    });

    it('ALLOW when lastBalanceSnapshotMs is 0 (not yet set)', () => {
        const input = baseInput();
        input.lastBalanceSnapshotMs = 0;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('ALLOW');
    });

    it('respects custom maxBalanceStalenessMs', () => {
        const input = baseInput();
        input.lastBalanceSnapshotMs = Date.now() - 40_000; // 40s
        // Default 120s → ALLOW
        expect(evaluateExecutionGate(input).verdict).toBe('ALLOW');
        // Lower threshold to 30s → BLOCK
        const result = evaluateExecutionGate(input, {
            ...DEFAULT_GATE_CONFIG,
            maxBalanceStalenessMs: 30_000,
        });
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/^balance-stale:/);
    });

    it('balance-stale yields to snapshot-invalid (higher priority)', () => {
        const input = baseInput();
        input.dataValid = false;
        input.dataInvalidReasons = ['crossed-book'];
        input.lastBalanceSnapshotMs = Date.now() - 200_000;
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toBe('snapshot-invalid');
    });

    it('balance-stale takes precedence over ledger-stalled', () => {
        const input = baseInput();
        input.lastBalanceSnapshotMs = Date.now() - 200_000; // stale balance
        input.lastLedgerCloseMs = Date.now() - 200_000;     // stale ledger
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/^balance-stale:/);
    });

    it('balance-stale takes precedence over health-below-threshold', () => {
        const input = baseInput();
        input.lastBalanceSnapshotMs = Date.now() - 200_000;
        input.health = { ...healthyResult(), score: 10, healthy: false };
        const result = evaluateExecutionGate(input);
        expect(result.verdict).toBe('BLOCK');
        expect(result.reasons[0]).toMatch(/^balance-stale:/);
    });
});
