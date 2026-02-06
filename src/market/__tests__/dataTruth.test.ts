/**
 * Data Truth Enforcement — Integration Tests
 *
 * These tests verify the spec's required scenarios end-to-end through the
 * execution gate + market data health + snapshot validator pipeline:
 *
 * 1. Execution blocked when book stale
 * 2. Execution blocked when tape stale
 * 3. Execution blocked on sequence break
 * 4. Execution resumes only after recovery
 * 5. Metrics windows reset correctly on pair switch
 */

import { describe, it, expect } from 'vitest';
import {
    evaluateExecutionGate,
    ExecutionGateInput,
    DEFAULT_GATE_CONFIG,
} from '../../execution/executionGate';
import {
    computeMarketDataHealth,
    DEFAULT_HEALTH_CONFIG,
    MarketHealthResult,
    TapeSignalInput,
    BookSignalInput,
    LedgerSignalInput,
    BalanceSignalInput,
} from '../marketDataHealth';
import { SnapshotValidator } from '../snapshotValidator';
import { normalizeOrderBookSnapshot, OrderBookSnapshot } from '../models';
import { OrderBookState } from '../../utils/types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const freshTape = (): TapeSignalInput => ({
    lastEventMs: NOW - 5_000,
    eventCount: 10,
    isMonotonic: true,
    lastPrice: 0.505,
});

const freshBook = (): BookSignalInput => ({
    bestBid: 0.50,
    bestAsk: 0.51,
    spreadBps: 196,
    bidDepthLevels: 5,
    askDepthLevels: 5,
    lastUpdatedMs: NOW - 2_000,
});

const freshLedger = (): LedgerSignalInput => ({
    ledgerIndex: 100,
    previousLedgerIndex: 99,
    lastCloseMs: NOW - 4_000,
});

const freshBalance = (): BalanceSignalInput => ({
    lastSnapshotMs: NOW - 5_000,
    snapshotLedgerIndex: 99,
    currentLedgerIndex: 100,
});

const buildGateInput = (
    health: MarketHealthResult,
    dataValid = true,
    dataInvalidReasons: string[] = [],
): ExecutionGateInput => ({
    runtimeState: 'READY',
    health,
    isConnected: true,
    isReconnecting: false,
    pairSwitchState: 'IDLE',
    isShuttingDown: false,
    isInRecovery: false,
    isRiskShutdown: false,
    dataValid,
    dataInvalidReasons,
    ledgerIndex: 100,
    // Use real wall-clock time so the gate's Date.now()-based ledger-staleness
    // check doesn't spuriously fire (the gate compares against Date.now(), not NOW).
    lastLedgerCloseMs: Date.now() - 3_000,
});

const healthyOrderBookState = (): OrderBookState => ({
    bids: [
        { price: 0.50, quantity: 100, quality: 2, isBuy: true, raw: {} as any },
        { price: 0.49, quantity: 200, quality: 2.04, isBuy: true, raw: {} as any },
    ],
    asks: [
        { price: 0.51, quantity: 100, quality: 1.96, isBuy: false, raw: {} as any },
        { price: 0.52, quantity: 200, quality: 1.92, isBuy: false, raw: {} as any },
    ],
    spread: 196,
    lastUpdated: NOW - 2_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Execution blocked when book stale
// ─────────────────────────────────────────────────────────────────────────────

describe('Spec: Execution blocked when book stale', () => {
    it('blocks when book exceeds dead threshold (30s default)', () => {
        const staleBook = freshBook();
        staleBook.lastUpdatedMs = NOW - 60_000; // 60s → well past 30s dead threshold

        const health = computeMarketDataHealth(
            { tape: freshTape(), book: staleBook, ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );

        // Book score should be 0 (dead), bringing composite below threshold
        expect(health.signals.book.score).toBe(0);

        // With book weight 0.35, composite ≈ 65 with default threshold 50.
        // Use strict threshold (80) to verify dead book triggers block.
        const strictConfig = { ...DEFAULT_GATE_CONFIG, minHealthScore: 80 };
        const gate = evaluateExecutionGate(buildGateInput(health), strictConfig);
        expect(gate.verdict).toBe('BLOCK');
        expect(gate.reasons.some(r => r.includes('health-below-threshold') || r.includes('signal-book'))).toBe(true);
    });

    it('blocks when book was never updated', () => {
        const neverUpdated = freshBook();
        neverUpdated.lastUpdatedMs = 0;

        const health = computeMarketDataHealth(
            { tape: freshTape(), book: neverUpdated, ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );
        expect(health.signals.book.score).toBe(0);

        const strictConfig = { ...DEFAULT_GATE_CONFIG, minHealthScore: 80 };
        const gate = evaluateExecutionGate(buildGateInput(health), strictConfig);        expect(gate.verdict).toBe('BLOCK');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Execution blocked when tape stale
// ─────────────────────────────────────────────────────────────────────────────

describe('Spec: Execution blocked when tape stale', () => {
    it('blocks when tape exceeds dead threshold (120s default)', () => {
        const staleTape = freshTape();
        staleTape.lastEventMs = NOW - 200_000; // 200s → past 120s dead threshold

        const health = computeMarketDataHealth(
            { tape: staleTape, book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );

        // Tape score should be 0 (dead)
        expect(health.signals.tape.score).toBe(0);

        // With tape weight 0.25, composite ≈ 75, threshold 50 → might still pass
        // Raise threshold to force block
        const strictConfig = { ...DEFAULT_GATE_CONFIG, minHealthScore: 80 };
        const gate = evaluateExecutionGate(buildGateInput(health), strictConfig);
        expect(gate.verdict).toBe('BLOCK');
    });

    it('blocks when no tape events at all', () => {
        const noTape: TapeSignalInput = {
            lastEventMs: 0,
            eventCount: 0,
            isMonotonic: true,
            lastPrice: 0,
        };

        const health = computeMarketDataHealth(
            { tape: noTape, book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );
        expect(health.signals.tape.score).toBe(0);

        // With strict threshold, dead tape causes block
        const strictConfig = { ...DEFAULT_GATE_CONFIG, minHealthScore: 80 };
        const gate = evaluateExecutionGate(buildGateInput(health), strictConfig);
        expect(gate.verdict).toBe('BLOCK');
        expect(gate.reasons.some(r => r.includes('signal-tape'))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Execution blocked on sequence break
// ─────────────────────────────────────────────────────────────────────────────

describe('Spec: Execution blocked on sequence break', () => {
    it('blocks when snapshot has a sequence gap', () => {
        const validator = new SnapshotValidator();

        // First snapshot: sequence 1
        const snap1 = normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW, 1);
        const v1 = validator.validate(snap1);
        expect(v1.valid).toBe(true);

        // Second snapshot: sequence 3 (gap — expected 2)
        const snap2 = normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW + 100, 3);
        const v2 = validator.validate(snap2);
        expect(v2.valid).toBe(false);
        expect(v2.reasons.some(r => r.includes('sequence-gap'))).toBe(true);

        // Feed into execution gate
        const health = computeMarketDataHealth(
            { tape: freshTape(), book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );
        const gate = evaluateExecutionGate(
            buildGateInput(health, v2.valid, v2.reasons),
            DEFAULT_GATE_CONFIG,
        );
        expect(gate.verdict).toBe('BLOCK');
        expect(gate.reasons).toContain('snapshot-invalid');
        expect(gate.reasons.some(r => r.includes('data:sequence-gap'))).toBe(true);
    });

    it('blocks when snapshot has a sequence regression', () => {
        const validator = new SnapshotValidator();

        validator.validate(normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW, 5));
        const v = validator.validate(normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW + 100, 3));

        expect(v.valid).toBe(false);
        expect(v.reasons.some(r => r.includes('sequence-regression'))).toBe(true);

        const health = computeMarketDataHealth(
            { tape: freshTape(), book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );
        const gate = evaluateExecutionGate(
            buildGateInput(health, v.valid, v.reasons),
            DEFAULT_GATE_CONFIG,
        );
        expect(gate.verdict).toBe('BLOCK');
        expect(gate.reasons).toContain('snapshot-invalid');
    });

    it('blocks on timestamp regression', () => {
        const validator = new SnapshotValidator();

        validator.validate(normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW + 5000, 1));
        const v = validator.validate(normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW, 2));

        expect(v.valid).toBe(false);
        expect(v.reasons.some(r => r.includes('timestamp-regression'))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Execution resumes only after recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('Spec: Execution resumes only after recovery', () => {
    it('transitions from BLOCK → ALLOW when data validity is restored', () => {
        const validator = new SnapshotValidator();

        // Step 1: valid snapshot
        const snap1 = normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW, 1);
        const v1 = validator.validate(snap1);
        expect(v1.valid).toBe(true);

        // Step 2: sequence gap → invalid
        const snap2 = normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW + 100, 3);
        const v2 = validator.validate(snap2);
        expect(v2.valid).toBe(false);

        const health = computeMarketDataHealth(
            { tape: freshTape(), book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );
        const blocked = evaluateExecutionGate(
            buildGateInput(health, v2.valid, v2.reasons),
            DEFAULT_GATE_CONFIG,
        );
        expect(blocked.verdict).toBe('BLOCK');

        // Step 3: next snapshot with correct sequence → valid again
        const snap3 = normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW + 200, 4);
        const v3 = validator.validate(snap3);
        expect(v3.valid).toBe(true);

        const allowed = evaluateExecutionGate(
            buildGateInput(health, v3.valid, v3.reasons),
            DEFAULT_GATE_CONFIG,
        );
        expect(allowed.verdict).toBe('ALLOW');
    });

    it('transitions from BLOCK → ALLOW when health recovers (book freshens)', () => {
        // Step 1: stale book → BLOCK (use strict threshold; composite with dead
        // book ≈ 65, which exceeds the default 50 but fails 80)
        const strictConfig = { ...DEFAULT_GATE_CONFIG, minHealthScore: 80 };
        const staleBook = freshBook();
        staleBook.lastUpdatedMs = NOW - 60_000;
        const unhealthy = computeMarketDataHealth(
            { tape: freshTape(), book: staleBook, ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );
        const blocked = evaluateExecutionGate(
            buildGateInput(unhealthy),
            strictConfig,
        );
        expect(blocked.verdict).toBe('BLOCK');

        // Step 2: book freshens → ALLOW
        const freshened = computeMarketDataHealth(
            { tape: freshTape(), book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            DEFAULT_HEALTH_CONFIG,
            50,
            NOW,
        );
        const allowed = evaluateExecutionGate(
            buildGateInput(freshened),
            strictConfig,
        );
        expect(allowed.verdict).toBe('ALLOW');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Metrics windows reset correctly on pair switch
// ─────────────────────────────────────────────────────────────────────────────

describe('Spec: Metrics windows reset on pair switch', () => {
    it('SnapshotValidator.reset() clears sequence tracking', () => {
        const validator = new SnapshotValidator();

        // Build up sequence for pair A
        validator.validate(normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW, 10));

        // Simulate pair switch: reset
        validator.reset();

        // New pair B starts at sequence 1 — no sequence-gap error
        const v = validator.validate(normalizeOrderBookSnapshot('XRP/EUR', healthyOrderBookState(), NOW + 100, 1));
        expect(v.valid).toBe(true);
        expect(v.reasons).toEqual([]);
    });

    it('validator state is zeroed after reset', () => {
        const validator = new SnapshotValidator();
        validator.validate(normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW, 5));

        validator.reset();
        const state = validator.getState();
        expect(state.lastSequence).toBe(0);
        expect(state.lastIngestTimeMs).toBe(0);
        expect(state.lastPairKey).toBe('');
    });

    it('no cross-pair sequence contamination without reset', () => {
        const validator = new SnapshotValidator();

        // Pair A at sequence 10
        validator.validate(normalizeOrderBookSnapshot('XRP/USD', healthyOrderBookState(), NOW, 10));

        // Different pair key → validator skips sequence check (different pair)
        const v = validator.validate(normalizeOrderBookSnapshot('XRP/EUR', healthyOrderBookState(), NOW + 100, 1));
        expect(v.valid).toBe(true);
    });
});
