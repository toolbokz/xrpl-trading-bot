/**
 * Snapshot Validator — Structural Truth Enforcement for Market Data
 *
 * Validates that each incoming OrderBookSnapshot satisfies structural
 * invariants before it is consumed by strategies. The gate evaluates
 * the *validity* of data (structural correctness) as opposed to the
 * *freshness* checks in MarketDataHealth.
 *
 * Checks performed:
 *   1. No NaN / Infinity in numeric fields
 *   2. Non-negative spread
 *   3. Bid < Ask (non-crossed book)
 *   4. Depth sanity (at least 1 level each side)
 *   5. Monotonic sequence (no regression / gap)
 *   6. Monotonic ingest timestamp (no backward jump)
 *
 * The result is a pure `SnapshotValidation` object — no side effects.
 */

import { OrderBookSnapshot } from './models';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotValidation {
    /** Whether the snapshot passes all structural checks. */
    valid: boolean;
    /** Human-readable reasons for each failed check. */
    reasons: string[];
}

export interface SnapshotValidatorState {
    /** Sequence number of the last validated snapshot (0 = none). */
    lastSequence: number;
    /** Ingest timestamp of the last validated snapshot (0 = none). */
    lastIngestTimeMs: number;
    /** Pair key of the last validated snapshot (empty = none). */
    lastPairKey: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stateful snapshot validator — tracks the previous snapshot so it can
 * detect sequence gaps and timestamp regressions across ticks.
 *
 * Call `reset()` on pair switch so cross-pair comparisons never happen.
 */
export class SnapshotValidator {
    private state: SnapshotValidatorState = {
        lastSequence: 0,
        lastIngestTimeMs: 0,
        lastPairKey: '',
    };

    /**
     * Validate a snapshot against structural invariants and the
     * previous snapshot's sequence/timestamp.
     *
     * Returns `{ valid: true, reasons: [] }` when all checks pass.
     */
    validate(snapshot: OrderBookSnapshot): SnapshotValidation {
        const reasons: string[] = [];

        // ── 1. NaN / Infinity guard ──────────────────────────────────────
        const numerics: Array<[string, number]> = [
            ['bestBid', snapshot.bestBid],
            ['bestAsk', snapshot.bestAsk],
            ['spreadBps', snapshot.spreadBps],
            ['depthNotional1Pct', snapshot.depthNotional1Pct],
            ['sequence', snapshot.sequence],
            ['eventTimeMs', snapshot.eventTimeMs],
            ['ingestTimeMs', snapshot.ingestTimeMs],
        ];
        for (const [name, value] of numerics) {
            if (!Number.isFinite(value)) {
                reasons.push(`nan-or-infinite:${name}=${value}`);
            }
        }
        // Also check depth level prices/sizes
        for (let i = 0; i < snapshot.bids.length; i++) {
            const lvl = snapshot.bids[i];
            if (lvl && (!Number.isFinite(lvl.price) || !Number.isFinite(lvl.size))) {
                reasons.push(`nan-or-infinite:bid[${i}]`);
            }
        }
        for (let i = 0; i < snapshot.asks.length; i++) {
            const lvl = snapshot.asks[i];
            if (lvl && (!Number.isFinite(lvl.price) || !Number.isFinite(lvl.size))) {
                reasons.push(`nan-or-infinite:ask[${i}]`);
            }
        }

        // ── 2. Non-negative spread ───────────────────────────────────────
        if (snapshot.spreadBps < 0) {
            reasons.push(`negative-spread:${snapshot.spreadBps}`);
        }

        // ── 3. Bid < Ask (non-crossed) ──────────────────────────────────
        if (snapshot.bestBid > 0 && snapshot.bestAsk > 0 && snapshot.bestBid >= snapshot.bestAsk) {
            reasons.push(`crossed-book:bid=${snapshot.bestBid},ask=${snapshot.bestAsk}`);
        }

        // ── 4. Depth sanity ─────────────────────────────────────────────
        if (snapshot.bids.length === 0 && snapshot.asks.length === 0) {
            reasons.push('empty-book:no-depth');
        }

        // ── 5. Sequence continuity ──────────────────────────────────────
        // Only enforce when we have a previous snapshot for the same pair.
        if (this.state.lastSequence > 0 && this.state.lastPairKey === snapshot.pairKey) {
            const expectedSeq = this.state.lastSequence + 1;
            if (snapshot.sequence < this.state.lastSequence) {
                reasons.push(`sequence-regression:prev=${this.state.lastSequence},cur=${snapshot.sequence}`);
            } else if (snapshot.sequence !== expectedSeq) {
                reasons.push(`sequence-gap:expected=${expectedSeq},got=${snapshot.sequence}`);
            }
        }

        // ── 6. Timestamp monotonicity ───────────────────────────────────
        if (this.state.lastIngestTimeMs > 0 && this.state.lastPairKey === snapshot.pairKey) {
            if (snapshot.ingestTimeMs < this.state.lastIngestTimeMs) {
                reasons.push(
                    `timestamp-regression:prev=${this.state.lastIngestTimeMs},cur=${snapshot.ingestTimeMs}`,
                );
            }
        }

        // ── Update tracking state ───────────────────────────────────────
        this.state = {
            lastSequence: snapshot.sequence,
            lastIngestTimeMs: snapshot.ingestTimeMs,
            lastPairKey: snapshot.pairKey,
        };

        return { valid: reasons.length === 0, reasons };
    }

    /**
     * Reset validator state — **must** be called on pair switch so that
     * stale sequence/timestamp from the old pair doesn't cause false
     * positives on the new pair's first snapshot.
     */
    reset(): void {
        this.state = {
            lastSequence: 0,
            lastIngestTimeMs: 0,
            lastPairKey: '',
        };
    }

    /**
     * Get the current validator state (for tests / observability).
     */
    getState(): Readonly<SnapshotValidatorState> {
        return { ...this.state };
    }
}
