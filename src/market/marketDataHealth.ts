/**
 * Market Data Health — Multi-Signal Quorum Validator
 *
 * Enforces a truth layer over all market data before execution is allowed.
 * Computes a composite health score from four independent signal dimensions:
 *
 *   Signal A — Trade Tape freshness & monotonicity
 *   Signal B — Order Book structural validity (bid < ask, depth, spread)
 *   Signal C — Ledger progress (index increasing, close-time stable)
 *   Signal D — Balance / snapshot freshness
 *
 * The quorum score (0–100) is consumed by ExecutionGate to allow/block trades
 * and by FeedStallRecovery to trigger staged reconnection.
 */

import { OrderBookState } from '../utils/types';
import { BOOK_CROSS_EPS_ABS } from './bookValidationEpsilon';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (all times in ms unless noted)
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketHealthConfig {
    /** Max age of the most recent trade-tape event before penalty (default 30 000 ms) */
    tapeFreshnessThresholdMs: number;
    /** Hard cut-off — tape older than this → score 0 for signal A (default 120 000 ms) */
    tapeDeadThresholdMs: number;
    /** Max age of order-book update (default 10 000 ms) */
    bookFreshnessThresholdMs: number;
    /** Hard cut-off for book staleness (default 30 000 ms) */
    bookDeadThresholdMs: number;
    /** Maximum acceptable spread in bps (default 500) */
    maxSpreadBps: number;
    /** Minimum number of depth levels on each side (default 1) */
    minDepthLevels: number;
    /** Max time since last ledger close before penalty (default 15 000 ms) */
    ledgerFreshnessThresholdMs: number;
    /** Hard cut-off for ledger staleness (default 60 000 ms) */
    ledgerDeadThresholdMs: number;
    /** Max age of balance snapshot (default 30 000 ms) */
    balanceFreshnessThresholdMs: number;
    /** Weights for the four signals (must sum to 1.0) */
    weights: {
        tape: number;
        book: number;
        ledger: number;
        balance: number;
    };
}

export const DEFAULT_HEALTH_CONFIG: MarketHealthConfig = {
    tapeFreshnessThresholdMs: 30_000,
    tapeDeadThresholdMs: 120_000,
    bookFreshnessThresholdMs: 10_000,
    bookDeadThresholdMs: 30_000,
    maxSpreadBps: 500,
    minDepthLevels: 1,
    ledgerFreshnessThresholdMs: 15_000,
    ledgerDeadThresholdMs: 60_000,
    balanceFreshnessThresholdMs: 30_000,
    weights: { tape: 0.25, book: 0.35, ledger: 0.25, balance: 0.15 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Signal inputs — each caller supplies the latest snapshots
// ─────────────────────────────────────────────────────────────────────────────

export interface TapeSignalInput {
    /** Timestamp of the most recent trade event (ms epoch). 0 if no events. */
    lastEventMs: number;
    /** Number of events in the rolling window. */
    eventCount: number;
    /** Whether timestamps are strictly monotonic (no backward jumps). */
    isMonotonic: boolean;
    /** Latest trade price (used for book-range check). 0 if unknown. */
    lastPrice: number;
}

export interface BookSignalInput {
    /** Best bid price. 0 if empty. */
    bestBid: number;
    /** Best ask price. 0 if empty. */
    bestAsk: number;
    /** Spread in basis points. */
    spreadBps: number;
    /** Number of bid levels. */
    bidDepthLevels: number;
    /** Number of ask levels. */
    askDepthLevels: number;
    /** Timestamp of last book update (ms epoch). */
    lastUpdatedMs: number;
}

export interface LedgerSignalInput {
    /** Current validated ledger index. */
    ledgerIndex: number;
    /** Previous validated ledger index (from last tick). */
    previousLedgerIndex: number;
    /** Timestamp of last ledger close event (ms epoch). */
    lastCloseMs: number;
}

export interface BalanceSignalInput {
    /** Timestamp of the most recent balance snapshot (ms epoch). */
    lastSnapshotMs: number;
    /** Ledger index at which balance was fetched. */
    snapshotLedgerIndex: number;
    /** Current validated ledger index (for consistency check). */
    currentLedgerIndex: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal scores (each 0–100)
// ─────────────────────────────────────────────────────────────────────────────

export interface SignalScore {
    name: string;
    score: number;
    reasons: string[];
}

export interface MarketHealthResult {
    /** Composite quorum score (0–100). */
    score: number;
    /** Is the market data considered healthy for execution? */
    healthy: boolean;
    /** Per-signal breakdown. */
    signals: {
        tape: SignalScore;
        book: SignalScore;
        ledger: SignalScore;
        balance: SignalScore;
    };
    /** Timestamp when this result was computed. */
    computedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Linear penalty: returns 100 when age ≤ 0, 0 when age ≥ deadThreshold,
 * linearly interpolated between freshThreshold and deadThreshold.
 */
const freshnessPenalty = (ageMs: number, freshMs: number, deadMs: number): number => {
    if (ageMs <= 0) return 100;
    if (ageMs <= freshMs) return 100;
    if (ageMs >= deadMs) return 0;
    // Linear interpolation between freshMs (100) and deadMs (0)
    return clamp(Math.round(100 * (1 - (ageMs - freshMs) / (deadMs - freshMs))), 0, 100);
};

// ─────────────────────────────────────────────────────────────────────────────
// Signal scorers
// ─────────────────────────────────────────────────────────────────────────────

export function scoreTapeSignal(
    input: TapeSignalInput,
    bookBestBid: number,
    bookBestAsk: number,
    nowMs: number,
    config: MarketHealthConfig,
): SignalScore {
    const reasons: string[] = [];
    let score = 100;

    // Freshness
    if (input.lastEventMs === 0 || input.eventCount === 0) {
        score = 0;
        reasons.push('no-tape-events');
        return { name: 'tape', score, reasons };
    }

    const age = nowMs - input.lastEventMs;
    const freshnessScore = freshnessPenalty(age, config.tapeFreshnessThresholdMs, config.tapeDeadThresholdMs);
    if (freshnessScore < 100) {
        reasons.push(`tape-stale:${Math.round(age)}ms`);
    }
    score = Math.min(score, freshnessScore);

    // Monotonicity
    if (!input.isMonotonic) {
        score = Math.max(0, score - 20);
        reasons.push('timestamp-not-monotonic');
    }

    // Price within book range
    if (input.lastPrice > 0 && bookBestBid > 0 && bookBestAsk > 0) {
        const margin = (bookBestAsk - bookBestBid) * 2; // allow 2x spread deviation
        if (input.lastPrice < bookBestBid - margin || input.lastPrice > bookBestAsk + margin) {
            score = Math.max(0, score - 30);
            reasons.push(`price-outside-book:${input.lastPrice.toFixed(6)}`);
        }
    }

    if (reasons.length === 0) reasons.push('ok');
    return { name: 'tape', score: clamp(score, 0, 100), reasons };
}

export function scoreBookSignal(
    input: BookSignalInput,
    nowMs: number,
    config: MarketHealthConfig,
): SignalScore {
    const reasons: string[] = [];
    let score = 100;

    // Structural: bid < ask (allow epsilon-level touching/crossing noise)
    const cross = input.bestBid - input.bestAsk;
    if (input.bestBid > 0 && input.bestAsk > 0 && cross > BOOK_CROSS_EPS_ABS) {
        score = 0;
        reasons.push('bid-not-less-than-ask');
        return { name: 'book', score, reasons };
    }

    // Depth
    if (input.bidDepthLevels < config.minDepthLevels || input.askDepthLevels < config.minDepthLevels) {
        score = Math.max(0, score - 40);
        reasons.push(`insufficient-depth:bids=${input.bidDepthLevels},asks=${input.askDepthLevels}`);
    }

    // Spread sanity
    if (input.spreadBps > config.maxSpreadBps) {
        score = Math.max(0, score - 30);
        reasons.push(`spread-excessive:${input.spreadBps.toFixed(1)}bps`);
    }

    // Freshness
    if (input.lastUpdatedMs === 0) {
        score = 0;
        reasons.push('book-never-updated');
        return { name: 'book', score, reasons };
    }

    const age = nowMs - input.lastUpdatedMs;
    const freshnessScore = freshnessPenalty(age, config.bookFreshnessThresholdMs, config.bookDeadThresholdMs);
    if (freshnessScore < 100) {
        reasons.push(`book-stale:${Math.round(age)}ms`);
    }
    score = Math.min(score, freshnessScore);

    if (reasons.length === 0) reasons.push('ok');
    return { name: 'book', score: clamp(score, 0, 100), reasons };
}

export function scoreLedgerSignal(
    input: LedgerSignalInput,
    nowMs: number,
    config: MarketHealthConfig,
): SignalScore {
    const reasons: string[] = [];
    let score = 100;

    // Ledger progress
    if (input.ledgerIndex <= 0) {
        score = 0;
        reasons.push('no-ledger-data');
        return { name: 'ledger', score, reasons };
    }

    if (input.previousLedgerIndex > 0 && input.ledgerIndex <= input.previousLedgerIndex) {
        score = Math.max(0, score - 40);
        reasons.push(`ledger-stalled:idx=${input.ledgerIndex}`);
    }

    // Close time freshness
    if (input.lastCloseMs > 0) {
        const age = nowMs - input.lastCloseMs;
        const freshnessScore = freshnessPenalty(age, config.ledgerFreshnessThresholdMs, config.ledgerDeadThresholdMs);
        if (freshnessScore < 100) {
            reasons.push(`ledger-close-stale:${Math.round(age)}ms`);
        }
        score = Math.min(score, freshnessScore);
    } else {
        score = Math.max(0, score - 20);
        reasons.push('no-ledger-close-time');
    }

    if (reasons.length === 0) reasons.push('ok');
    return { name: 'ledger', score: clamp(score, 0, 100), reasons };
}

export function scoreBalanceSignal(
    input: BalanceSignalInput,
    nowMs: number,
    config: MarketHealthConfig,
): SignalScore {
    const reasons: string[] = [];
    let score = 100;

    // Freshness
    if (input.lastSnapshotMs === 0) {
        score = 0;
        reasons.push('no-balance-snapshot');
        return { name: 'balance', score, reasons };
    }

    const age = nowMs - input.lastSnapshotMs;
    if (age > config.balanceFreshnessThresholdMs) {
        score = Math.max(0, score - 40);
        reasons.push(`balance-stale:${Math.round(age)}ms`);
    }

    // Ledger consistency: balance was fetched from a recent ledger
    if (input.currentLedgerIndex > 0 && input.snapshotLedgerIndex > 0) {
        const gap = input.currentLedgerIndex - input.snapshotLedgerIndex;
        if (gap > 10) {
            score = Math.max(0, score - 30);
            reasons.push(`balance-ledger-gap:${gap}`);
        }
    }

    if (reasons.length === 0) reasons.push('ok');
    return { name: 'balance', score: clamp(score, 0, 100), reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite scorer
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketHealthInput {
    tape: TapeSignalInput;
    book: BookSignalInput;
    ledger: LedgerSignalInput;
    balance: BalanceSignalInput;
}

/**
 * Compute composite market data health from all four signals.
 * Returns a weighted score (0–100) and per-signal breakdown.
 *
 * Health threshold (default 50) is the minimum score required for execution.
 */
export function computeMarketDataHealth(
    input: MarketHealthInput,
    config: MarketHealthConfig = DEFAULT_HEALTH_CONFIG,
    healthThreshold: number = 50,
    nowMs: number = Date.now(),
): MarketHealthResult {
    const tapeScore = scoreTapeSignal(input.tape, input.book.bestBid, input.book.bestAsk, nowMs, config);
    const bookScore = scoreBookSignal(input.book, nowMs, config);
    const ledgerScore = scoreLedgerSignal(input.ledger, nowMs, config);
    const balanceScore = scoreBalanceSignal(input.balance, nowMs, config);

    const composite = Math.round(
        tapeScore.score * config.weights.tape +
        bookScore.score * config.weights.book +
        ledgerScore.score * config.weights.ledger +
        balanceScore.score * config.weights.balance,
    );

    const score = clamp(composite, 0, 100);

    return {
        score,
        healthy: score >= healthThreshold,
        signals: {
            tape: tapeScore,
            book: bookScore,
            ledger: ledgerScore,
            balance: balanceScore,
        },
        computedAt: nowMs,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: build signal inputs from runtime objects
// ─────────────────────────────────────────────────────────────────────────────

export function buildBookSignalFromState(state: OrderBookState): BookSignalInput {
    return {
        bestBid: state.bids[0]?.price ?? 0,
        bestAsk: state.asks[0]?.price ?? 0,
        spreadBps: state.spread,
        bidDepthLevels: state.bids.length,
        askDepthLevels: state.asks.length,
        lastUpdatedMs: state.lastUpdated,
    };
}
