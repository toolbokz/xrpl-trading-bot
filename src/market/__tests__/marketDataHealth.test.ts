import { describe, it, expect } from 'vitest';
import {
    computeMarketDataHealth,
    scoreTapeSignal,
    scoreBookSignal,
    scoreLedgerSignal,
    scoreBalanceSignal,
    DEFAULT_HEALTH_CONFIG,
    MarketHealthConfig,
    TapeSignalInput,
    BookSignalInput,
    LedgerSignalInput,
    BalanceSignalInput,
    buildBookSignalFromState,
} from '../marketDataHealth';
import { OrderBookState } from '../../utils/types';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const cfg = DEFAULT_HEALTH_CONFIG;

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

// ─────────────────────────────────────────────────────────────────────────────
// Signal A — Trade Tape
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreTapeSignal', () => {
    it('scores 100 when tape is fresh and monotonic', () => {
        const result = scoreTapeSignal(freshTape(), 0.50, 0.51, NOW, cfg);
        expect(result.score).toBe(100);
        expect(result.reasons).toContain('ok');
    });

    it('scores 0 when no tape events', () => {
        const input: TapeSignalInput = { lastEventMs: 0, eventCount: 0, isMonotonic: true, lastPrice: 0 };
        const result = scoreTapeSignal(input, 0.50, 0.51, NOW, cfg);
        expect(result.score).toBe(0);
        expect(result.reasons).toContain('no-tape-events');
    });

    it('penalizes stale tape', () => {
        const input = freshTape();
        input.lastEventMs = NOW - 60_000; // 60s old — between fresh (30s) and dead (120s)
        const result = scoreTapeSignal(input, 0.50, 0.51, NOW, cfg);
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThan(100);
    });

    it('scores 0 when tape exceeds dead threshold', () => {
        const input = freshTape();
        input.lastEventMs = NOW - 200_000;
        const result = scoreTapeSignal(input, 0.50, 0.51, NOW, cfg);
        expect(result.score).toBe(0);
    });

    it('penalizes non-monotonic timestamps', () => {
        const input = freshTape();
        input.isMonotonic = false;
        const result = scoreTapeSignal(input, 0.50, 0.51, NOW, cfg);
        expect(result.score).toBe(80);
        expect(result.reasons).toContain('timestamp-not-monotonic');
    });

    it('penalizes price outside book range', () => {
        const input = freshTape();
        input.lastPrice = 1.50; // way outside bid=0.50 ask=0.51
        const result = scoreTapeSignal(input, 0.50, 0.51, NOW, cfg);
        expect(result.score).toBe(70);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal B — Order Book
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreBookSignal', () => {
    it('scores 100 when book is healthy', () => {
        const result = scoreBookSignal(freshBook(), NOW, cfg);
        expect(result.score).toBe(100);
        expect(result.reasons).toContain('ok');
    });

    it('scores 0 when bid >= ask (crossed book)', () => {
        const input = freshBook();
        input.bestBid = 0.52;
        input.bestAsk = 0.50;
        const result = scoreBookSignal(input, NOW, cfg);
        expect(result.score).toBe(0);
        expect(result.reasons).toContain('bid-not-less-than-ask');
    });

    it('penalizes insufficient depth', () => {
        const input = freshBook();
        input.bidDepthLevels = 0;
        input.askDepthLevels = 0;
        const result = scoreBookSignal(input, NOW, cfg);
        expect(result.score).toBeLessThan(100);
        expect(result.reasons[0]).toMatch(/insufficient-depth/);
    });

    it('penalizes excessive spread', () => {
        const input = freshBook();
        input.spreadBps = 600;
        const result = scoreBookSignal(input, NOW, cfg);
        expect(result.score).toBeLessThan(100);
        expect(result.reasons[0]).toMatch(/spread-excessive/);
    });

    it('scores 0 when book was never updated', () => {
        const input = freshBook();
        input.lastUpdatedMs = 0;
        const result = scoreBookSignal(input, NOW, cfg);
        expect(result.score).toBe(0);
        expect(result.reasons).toContain('book-never-updated');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal C — Ledger Progress
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreLedgerSignal', () => {
    it('scores 100 when ledger is progressing', () => {
        const result = scoreLedgerSignal(freshLedger(), NOW, cfg);
        expect(result.score).toBe(100);
        expect(result.reasons).toContain('ok');
    });

    it('scores 0 when no ledger data', () => {
        const input: LedgerSignalInput = { ledgerIndex: 0, previousLedgerIndex: 0, lastCloseMs: 0 };
        const result = scoreLedgerSignal(input, NOW, cfg);
        expect(result.score).toBe(0);
        expect(result.reasons).toContain('no-ledger-data');
    });

    it('penalizes stalled ledger (index not increasing)', () => {
        const input: LedgerSignalInput = { ledgerIndex: 100, previousLedgerIndex: 100, lastCloseMs: NOW - 2_000 };
        const result = scoreLedgerSignal(input, NOW, cfg);
        expect(result.score).toBe(60);
        expect(result.reasons[0]).toMatch(/ledger-stalled/);
    });

    it('penalizes stale ledger close time', () => {
        const input = freshLedger();
        input.lastCloseMs = NOW - 40_000; // between fresh (15s) and dead (60s)
        const result = scoreLedgerSignal(input, NOW, cfg);
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThan(100);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal D — Balance Freshness
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreBalanceSignal', () => {
    it('scores 100 when balance is fresh', () => {
        const result = scoreBalanceSignal(freshBalance(), NOW, cfg);
        expect(result.score).toBe(100);
        expect(result.reasons).toContain('ok');
    });

    it('scores 0 when no balance snapshot', () => {
        const input: BalanceSignalInput = { lastSnapshotMs: 0, snapshotLedgerIndex: 0, currentLedgerIndex: 100 };
        const result = scoreBalanceSignal(input, NOW, cfg);
        expect(result.score).toBe(0);
        expect(result.reasons).toContain('no-balance-snapshot');
    });

    it('penalizes stale balance', () => {
        const input = freshBalance();
        input.lastSnapshotMs = NOW - 60_000;
        const result = scoreBalanceSignal(input, NOW, cfg);
        expect(result.score).toBe(60);
    });

    it('penalizes ledger gap', () => {
        const input = freshBalance();
        input.snapshotLedgerIndex = 50;
        input.currentLedgerIndex = 100;
        const result = scoreBalanceSignal(input, NOW, cfg);
        expect(result.score).toBe(70);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Composite Health Score
// ─────────────────────────────────────────────────────────────────────────────

describe('computeMarketDataHealth', () => {
    it('returns 100 and healthy when all signals are fresh', () => {
        const result = computeMarketDataHealth(
            { tape: freshTape(), book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            cfg,
            50,
            NOW,
        );
        expect(result.score).toBe(100);
        expect(result.healthy).toBe(true);
        expect(result.signals.tape.score).toBe(100);
        expect(result.signals.book.score).toBe(100);
        expect(result.signals.ledger.score).toBe(100);
        expect(result.signals.balance.score).toBe(100);
    });

    it('returns unhealthy when all signals are dead', () => {
        const result = computeMarketDataHealth(
            {
                tape: { lastEventMs: 0, eventCount: 0, isMonotonic: true, lastPrice: 0 },
                book: { bestBid: 0, bestAsk: 0, spreadBps: 0, bidDepthLevels: 0, askDepthLevels: 0, lastUpdatedMs: 0 },
                ledger: { ledgerIndex: 0, previousLedgerIndex: 0, lastCloseMs: 0 },
                balance: { lastSnapshotMs: 0, snapshotLedgerIndex: 0, currentLedgerIndex: 0 },
            },
            cfg,
            50,
            NOW,
        );
        expect(result.score).toBe(0);
        expect(result.healthy).toBe(false);
    });

    it('crosses threshold exactly at 50', () => {
        // Construct a case where weighted composite is exactly at boundary
        const result = computeMarketDataHealth(
            { tape: freshTape(), book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            cfg,
            100, // require perfect health
            NOW,
        );
        expect(result.healthy).toBe(true); // all signals are 100

        const result2 = computeMarketDataHealth(
            { tape: freshTape(), book: freshBook(), ledger: freshLedger(), balance: freshBalance() },
            cfg,
            101, // impossible threshold
            NOW,
        );
        expect(result2.healthy).toBe(false);
    });

    it('weights signals correctly', () => {
        // Kill tape only (weight 0.25 → composite ≈ 75)
        const result = computeMarketDataHealth(
            {
                tape: { lastEventMs: 0, eventCount: 0, isMonotonic: true, lastPrice: 0 },
                book: freshBook(),
                ledger: freshLedger(),
                balance: freshBalance(),
            },
            cfg,
            50,
            NOW,
        );
        expect(result.score).toBe(75);
        expect(result.healthy).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildBookSignalFromState
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBookSignalFromState', () => {
    it('converts OrderBookState to BookSignalInput', () => {
        const state: OrderBookState = {
            bids: [
                { price: 0.50, quantity: 100, quality: 2, isBuy: true, raw: {} as any },
                { price: 0.49, quantity: 200, quality: 2.04, isBuy: true, raw: {} as any },
            ],
            asks: [
                { price: 0.51, quantity: 100, quality: 1.96, isBuy: false, raw: {} as any },
            ],
            spread: 196,
            lastUpdated: NOW,
        };
        const result = buildBookSignalFromState(state);
        expect(result.bestBid).toBe(0.50);
        expect(result.bestAsk).toBe(0.51);
        expect(result.spreadBps).toBe(196);
        expect(result.bidDepthLevels).toBe(2);
        expect(result.askDepthLevels).toBe(1);
        expect(result.lastUpdatedMs).toBe(NOW);
    });
});
