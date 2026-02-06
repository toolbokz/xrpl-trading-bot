/**
 * Pair Payload Standard — Global API Envelope
 *
 * Every runtime-backed endpoint wraps its data in this envelope.
 * Guarantees callers can verify pair affinity, freshness, and execution
 * eligibility without parsing domain-specific fields.
 *
 * Required fields:  pairKey · asOfMs · stalenessMs
 * Recommended:      executionAllowed · runtimeState
 */

import type { RuntimeState } from '../../../src/runtime/runtimeFsm';

// ─────────────────────────────────────────────────────────────────────────────
// Core envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard wrapper for all pair-keyed API payloads.
 *
 * @template T  Domain-specific data shape (e.g. FlowMetrics, MarketHealthResult)
 */
export interface PairPayload<T> {
    /** Trading pair key — e.g. "XRP/RLUSD". */
    pairKey: string;

    /** Epoch ms when the data was captured / last updated. */
    asOfMs: number;

    /**
     * How stale the data is relative to the time the response was built (ms).
     * Computed as `Date.now() - asOfMs` on the server side.
     */
    stalenessMs: number;

    /** Whether the execution gate currently allows trading. */
    executionAllowed: boolean;

    /** Current runtime FSM state (BOOTING, WARMING, READY, …). */
    runtimeState: RuntimeState | null;

    /** Domain-specific payload. `null` when data is unavailable. */
    data: T | null;

    /** Auto-injected request correlation ID. */
    requestId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder helper (server-side only)
// ─────────────────────────────────────────────────────────────────────────────

export interface PairPayloadMeta {
    pairKey: string;
    asOfMs: number;
    executionAllowed: boolean;
    runtimeState: RuntimeState | null;
    requestId: string;
}

/**
 * Build a standard PairPayload envelope.
 * Called from API route handlers; keeps construction logic in one place.
 */
export function buildPairPayload<T>(
    meta: PairPayloadMeta,
    data: T | null,
): PairPayload<T> {
    const now = Date.now();
    return {
        pairKey: meta.pairKey,
        asOfMs: meta.asOfMs,
        stalenessMs: Math.max(0, now - meta.asOfMs),
        executionAllowed: meta.executionAllowed,
        runtimeState: meta.runtimeState,
        data,
        requestId: meta.requestId,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side guard helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Default maximum age (ms) before the frontend considers a payload stale. */
export const DEFAULT_MAX_STALENESS_MS = 30_000;

/**
 * Returns `true` if the payload matches the expected pair and is fresh enough.
 */
export function isPairPayloadUsable<T>(
    payload: PairPayload<T>,
    expectedPairKey: string,
    maxStalenessMs: number = DEFAULT_MAX_STALENESS_MS,
): boolean {
    if (payload.pairKey !== expectedPairKey) return false;
    // Recompute staleness on the client for additional safety
    const clientStaleness = Date.now() - payload.asOfMs;
    if (clientStaleness > maxStalenessMs) return false;
    return true;
}
