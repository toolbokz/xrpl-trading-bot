/**
 * Observability Event Bus — Structured Event Stream for Forensic Debugging
 *
 * Provides a deterministic, pair-scoped, structured event stream for all
 * critical runtime state transitions. Events are collected in a ring buffer
 * and exposed via API for dashboards, monitoring, and forensic replay.
 *
 * Design principles:
 *   • Runtime-sourced: every event originates from actual runtime state
 *   • Deterministic: same inputs → same events, no randomness
 *   • Pair-scoped: every event carries pairKey context
 *   • Dedup-guarded: sequential identical events are suppressed
 *   • Forensic: full replay trace via ordered ring buffer
 *   • Non-invasive: only adds logging hooks, never rewrites runtime
 *
 * Required structured events (per spec):
 *   FSM_TRANSITION          — runtime lifecycle FSM state change
 *   PAIR_SWITCH_START       — pair switch initiated
 *   PAIR_SWITCH_READY       — pair switch completed, execution can resume
 *   EXECUTION_BLOCKED       — execution gate denied tick
 *   EXECUTION_ALLOWED       — execution gate allowed tick (after block)
 *   FEED_STALE              — feed stall detected
 *   FEED_RECOVERED          — feed recovered from stall
 *   XRPL_RECONNECTED        — WebSocket reconnected
 *   XRPL_DISCONNECTED       — WebSocket disconnected
 *   RISK_BLOCK              — hard risk guard blocked execution
 *   DATA_INVALIDATED        — snapshot structural validation failed
 */

// ─────────────────────────────────────────────────────────────────────────────
// Event types
// ─────────────────────────────────────────────────────────────────────────────

export const OBSERVABILITY_EVENT_TYPES = [
    'FSM_TRANSITION',
    'PAIR_SWITCH_START',
    'PAIR_SWITCH_READY',
    'PAIR_SWITCH_FAILED',
    'EXECUTION_BLOCKED',
    'EXECUTION_ALLOWED',
    'FEED_STALE',
    'FEED_RECOVERED',
    'XRPL_RECONNECTED',
    'XRPL_DISCONNECTED',
    'RISK_BLOCK',
    'DATA_INVALIDATED',
    'BALANCE_STALE',
    'BALANCE_REFRESHED',
    'RESOLVER_CACHE_MISS',
    'AVAILABILITY_SCAN_COMPLETE',
    'TRUSTLINE_GOVERNANCE',
    'SCANNER_DEGRADED',
    'SCANNER_RECOVERED',
    'FAIR_VALUE_UPDATED',
    'STRATEGY_REJECTED',
    'STRATEGY_APPROVED',
    'SUBMIT_ATTEMPT',
    'SUBMIT_SUCCESS',
    'SUBMIT_FAIL',
    'ORDER_PLACED',
    'ORDER_FILLED',
] as const;

export type ObservabilityEventType = typeof OBSERVABILITY_EVENT_TYPES[number];

/**
 * Canonical structured event — the unit of observability.
 */
export interface ObservabilityEvent {
    /** Monotonic sequence number within the bus (never resets except on clear). */
    seq: number;
    /** Event type (one of the canonical set). */
    eventType: ObservabilityEventType;
    /** ISO 8601 timestamp (deterministic from runtime clock). */
    timestamp: string;
    /** Epoch ms (for numeric comparisons). */
    timestampMs: number;
    /** Active trading pair key (e.g. "XRP/RLUSD"). */
    pairKey: string;
    /** Current runtime FSM state at event time. */
    runtimeState: string;
    /** Execution correlation ID (when event relates to a specific trade). */
    correlationId: string | null;
    /** Event-specific detail payload. */
    detail: Record<string, unknown>;
}

/**
 * Dedup key — used to suppress sequential identical events.
 */
type DedupKey = string;

/**
 * Configuration for the ObservabilityBus.
 */
export interface ObservabilityBusConfig {
    /** Max events in the ring buffer (default: 500). */
    maxEvents: number;
    /** Minimum interval (ms) between same-type events for dedup (default: 0 = no time-based dedup). */
    dedupIntervalMs: number;
}

const DEFAULT_BUS_CONFIG: ObservabilityBusConfig = {
    maxEvents: 500,
    dedupIntervalMs: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Bus
// ─────────────────────────────────────────────────────────────────────────────

export class ObservabilityBus {
    private readonly config: ObservabilityBusConfig;
    private events: ObservabilityEvent[] = [];
    private seq = 0;
    private lastDedupKeys = new Map<ObservabilityEventType, { key: DedupKey; ts: number }>();
    /** Whether execution was blocked on previous evaluation (for EXECUTION_ALLOWED edge detection). */
    private wasBlocked = false;

    constructor(config: Partial<ObservabilityBusConfig> = {}) {
        this.config = { ...DEFAULT_BUS_CONFIG, ...config };
    }

    // ─── Emission ────────────────────────────────────────────────────────

    /**
     * Emit a structured observability event.
     *
     * Dedup: if the dedup key matches the previous event of the same type
     * (and within dedupIntervalMs), the event is suppressed.
     *
     * @returns The emitted event, or null if suppressed by dedup.
     */
    emit(params: {
        eventType: ObservabilityEventType;
        pairKey: string;
        runtimeState: string;
        correlationId?: string | null | undefined;
        detail?: Record<string, unknown> | undefined;
        nowMs?: number | undefined;
    }): ObservabilityEvent | null {
        const nowMs = params.nowMs ?? Date.now();
        const detail = params.detail ?? {};

        // ── Dedup check ──────────────────────────────────────────────────
        const dedupKey = buildDedupKey(params.eventType, params.pairKey, detail);
        const lastEntry = this.lastDedupKeys.get(params.eventType);
        if (lastEntry && lastEntry.key === dedupKey) {
            if (this.config.dedupIntervalMs <= 0 || (nowMs - lastEntry.ts) < this.config.dedupIntervalMs) {
                return null; // suppressed
            }
        }
        this.lastDedupKeys.set(params.eventType, { key: dedupKey, ts: nowMs });

        // ── Build event ──────────────────────────────────────────────────
        this.seq += 1;
        const event: ObservabilityEvent = {
            seq: this.seq,
            eventType: params.eventType,
            timestamp: new Date(nowMs).toISOString(),
            timestampMs: nowMs,
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            correlationId: params.correlationId ?? null,
            detail,
        };

        this.events.push(event);
        if (this.events.length > this.config.maxEvents) {
            this.events = this.events.slice(-this.config.maxEvents);
        }

        return event;
    }

    // ─── Convenience emitters ────────────────────────────────────────────

    /**
     * Emit FSM_TRANSITION event.
     */
    emitFsmTransition(params: {
        from: string;
        to: string;
        reason: string;
        pairKey: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'FSM_TRANSITION',
            pairKey: params.pairKey,
            runtimeState: params.to,
            detail: { from: params.from, to: params.to, reason: params.reason },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit PAIR_SWITCH_START event.
     */
    emitPairSwitchStart(params: {
        fromPair: string;
        toPair: string;
        runtimeState: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'PAIR_SWITCH_START',
            pairKey: params.toPair,
            runtimeState: params.runtimeState,
            detail: { fromPair: params.fromPair, toPair: params.toPair },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit PAIR_SWITCH_READY event.
     */
    emitPairSwitchReady(params: {
        pairKey: string;
        runtimeState: string;
        durationMs?: number;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'PAIR_SWITCH_READY',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { durationMs: params.durationMs ?? 0 },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit PAIR_SWITCH_FAILED event.
     */
    emitPairSwitchFailed(params: {
        pairKey: string;
        runtimeState: string;
        error: string;
        switchId?: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'PAIR_SWITCH_FAILED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { error: params.error, switchId: params.switchId },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit BALANCE_STALE event (edge-triggered — dedup prevents repeats).
     */
    emitBalanceStale(params: {
        pairKey: string;
        runtimeState: string;
        stalenessMs: number;
        lastRefreshMs: number;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'BALANCE_STALE',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { stalenessMs: params.stalenessMs, lastRefreshMs: params.lastRefreshMs },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit BALANCE_REFRESHED event.
     */
    emitBalanceRefreshed(params: {
        pairKey: string;
        runtimeState: string;
        stalenessMs: number;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'BALANCE_REFRESHED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { stalenessMs: params.stalenessMs },
            nowMs: params.nowMs,
        });
    }

    /**
     * Evaluate execution gate verdict and emit EXECUTION_BLOCKED or
     * EXECUTION_ALLOWED on state transitions.
     *
     * - EXECUTION_BLOCKED: emitted on transition from allowed → blocked
     * - EXECUTION_ALLOWED: emitted on transition from blocked → allowed
     *
     * This ensures edge-only emission (no repeated BLOCKED/ALLOWED spam).
     */
    evaluateGateVerdict(params: {
        blocked: boolean;
        reasons: string[];
        healthScore: number;
        pairKey: string;
        runtimeState: string;
        correlationId?: string | null;
        nowMs?: number;
    }): ObservabilityEvent | null {
        const { blocked, reasons, healthScore, pairKey, runtimeState, correlationId, nowMs } = params;

        if (blocked && !this.wasBlocked) {
            this.wasBlocked = true;
            return this.emit({
                eventType: 'EXECUTION_BLOCKED',
                pairKey,
                runtimeState,
                correlationId,
                detail: { reasons, healthScore },
                nowMs,
            });
        }

        if (!blocked && this.wasBlocked) {
            this.wasBlocked = false;
            return this.emit({
                eventType: 'EXECUTION_ALLOWED',
                pairKey,
                runtimeState,
                detail: { healthScore },
                nowMs,
            });
        }

        return null;
    }

    /**
     * Emit FEED_STALE event.
     */
    emitFeedStale(params: {
        pairKey: string;
        runtimeState: string;
        stage: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'FEED_STALE',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { stage: params.stage },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit FEED_RECOVERED event.
     */
    emitFeedRecovered(params: {
        pairKey: string;
        runtimeState: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'FEED_RECOVERED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit XRPL_RECONNECTED event.
     */
    emitXrplReconnected(params: {
        pairKey: string;
        runtimeState: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'XRPL_RECONNECTED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit XRPL_DISCONNECTED event.
     */
    emitXrplDisconnected(params: {
        pairKey: string;
        runtimeState: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'XRPL_DISCONNECTED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit RISK_BLOCK event.
     */
    emitRiskBlock(params: {
        pairKey: string;
        runtimeState: string;
        reasons: string[];
        riskState: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'RISK_BLOCK',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { reasons: params.reasons, riskState: params.riskState },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit DATA_INVALIDATED event.
     */
    emitDataInvalidated(params: {
        pairKey: string;
        runtimeState: string;
        reasons: string[];
        sequence: number;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'DATA_INVALIDATED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { reasons: params.reasons, sequence: params.sequence },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit RESOLVER_CACHE_MISS when the execution pair resolver
     * cannot find a cached resolution and must re-resolve.
     */
    emitResolverCacheMiss(params: {
        pairKey: string;
        runtimeState: string;
        reason: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'RESOLVER_CACHE_MISS',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { reason: params.reason },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit AVAILABILITY_SCAN_COMPLETE when the availability scanner
     * finishes a probe cycle.
     */
    emitAvailabilityScanComplete(params: {
        pairKey: string;
        runtimeState: string;
        pairsScanned: number;
        pairsAvailable: number;
        durationMs: number;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'AVAILABILITY_SCAN_COMPLETE',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                pairsScanned: params.pairsScanned,
                pairsAvailable: params.pairsAvailable,
                durationMs: params.durationMs,
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit TRUSTLINE_GOVERNANCE when a trustline governance decision
     * is made (ALLOW, CREATE, BLOCK, SKIP).
     */
    emitTrustlineGovernance(params: {
        pairKey: string;
        runtimeState: string;
        decision: string;
        blockReasons: string[];
        created: string[];
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'TRUSTLINE_GOVERNANCE',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                decision: params.decision,
                blockReasons: params.blockReasons,
                created: params.created,
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit SCANNER_DEGRADED when background scanner health drops.
     */
    emitScannerDegraded(params: {
        pairKey: string;
        runtimeState: string;
        score: number;
        consecutiveFailures: number;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'SCANNER_DEGRADED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                score: params.score,
                consecutiveFailures: params.consecutiveFailures,
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit SCANNER_RECOVERED when background scanner health recovers.
     */
    emitScannerRecovered(params: {
        pairKey: string;
        runtimeState: string;
        score: number;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'SCANNER_RECOVERED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { score: params.score },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit FAIR_VALUE_UPDATED when external fair value is recomputed.
     */
    emitFairValueUpdated(params: {
        pairKey: string;
        runtimeState: string;
        confidence: number;
        sourcesUsed: number;
        divergenceBpsVsXrpRlusd: number | null;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'FAIR_VALUE_UPDATED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                confidence: params.confidence,
                sourcesUsed: params.sourcesUsed,
                divergenceBpsVsXrpRlusd: params.divergenceBpsVsXrpRlusd,
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit STRATEGY_REJECTED when a strategy exits early.
     */
    emitStrategyRejected(params: {
        pairKey: string;
        runtimeState: string;
        strategy: string;
        reasonCode: string;
        regime?: string | null;
        spreadBps?: number | null;
        healthScore?: number | null;
        detail?: Record<string, unknown>;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'STRATEGY_REJECTED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                strategy: params.strategy,
                reasonCode: params.reasonCode,
                regime: params.regime ?? null,
                spreadBps: params.spreadBps ?? null,
                healthScore: params.healthScore ?? null,
                ...(params.detail ?? {}),
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit STRATEGY_APPROVED when a strategy approves an order candidate.
     */
    emitStrategyApproved(params: {
        pairKey: string;
        runtimeState: string;
        strategy: string;
        side?: 'buy' | 'sell';
        sizeBase?: number;
        expectedPriceSource?: string;
        detail?: Record<string, unknown>;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'STRATEGY_APPROVED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                strategy: params.strategy,
                side: params.side,
                sizeBase: params.sizeBase,
                expectedPriceSource: params.expectedPriceSource,
                ...(params.detail ?? {}),
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit SUBMIT_ATTEMPT when the executor starts submission.
     */
    emitSubmitAttempt(params: {
        pairKey: string;
        runtimeState: string;
        strategy: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'SUBMIT_ATTEMPT',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: { strategy: params.strategy },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit SUBMIT_SUCCESS when the executor receives a successful ledger result.
     */
    emitSubmitSuccess(params: {
        pairKey: string;
        runtimeState: string;
        strategy: string;
        txHash?: string | null;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'SUBMIT_SUCCESS',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                strategy: params.strategy,
                txHash: params.txHash ?? null,
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit SUBMIT_FAIL when submission fails or is rejected.
     */
    emitSubmitFail(params: {
        pairKey: string;
        runtimeState: string;
        strategy: string;
        txHash?: string | null;
        errorCode?: string | null;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'SUBMIT_FAIL',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                strategy: params.strategy,
                txHash: params.txHash ?? null,
                errorCode: params.errorCode ?? null,
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit ORDER_PLACED for trade toast notifications.
     */
    emitOrderPlaced(params: {
        pairKey: string;
        runtimeState: string;
        side: 'BUY' | 'SELL';
        baseCurrency: string;
        quoteCurrency: string;
        baseAmount?: number;
        quoteAmount?: number;
        price?: number;
        feeQuote?: number;
        timestamp?: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'ORDER_PLACED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                type: 'ORDER_PLACED',
                side: params.side,
                pair: params.pairKey,
                baseCurrency: params.baseCurrency,
                quoteCurrency: params.quoteCurrency,
                baseAmount: params.baseAmount,
                quoteAmount: params.quoteAmount,
                price: params.price,
                feeQuote: params.feeQuote,
                timestamp: params.timestamp ?? new Date(params.nowMs ?? Date.now()).toISOString(),
            },
            nowMs: params.nowMs,
        });
    }

    /**
     * Emit ORDER_FILLED for trade toast notifications.
     */
    emitOrderFilled(params: {
        pairKey: string;
        runtimeState: string;
        side?: 'BUY' | 'SELL';
        baseCurrency: string;
        quoteCurrency: string;
        baseAmount?: number;
        quoteAmount?: number;
        price?: number;
        feeQuote?: number;
        pnlQuote?: number;
        timestamp?: string;
        nowMs?: number;
    }): ObservabilityEvent | null {
        return this.emit({
            eventType: 'ORDER_FILLED',
            pairKey: params.pairKey,
            runtimeState: params.runtimeState,
            detail: {
                type: 'ORDER_FILLED',
                side: params.side,
                pair: params.pairKey,
                baseCurrency: params.baseCurrency,
                quoteCurrency: params.quoteCurrency,
                baseAmount: params.baseAmount,
                quoteAmount: params.quoteAmount,
                price: params.price,
                feeQuote: params.feeQuote,
                pnlQuote: params.pnlQuote,
                timestamp: params.timestamp ?? new Date(params.nowMs ?? Date.now()).toISOString(),
            },
            nowMs: params.nowMs,
        });
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /**
     * Get all events in insertion order (oldest first).
     */
    getAll(): readonly ObservabilityEvent[] {
        return this.events;
    }

    /**
     * Get the N most recent events (newest first).
     */
    getRecent(limit: number = 50): ObservabilityEvent[] {
        return this.events.slice(-limit).reverse();
    }

    /**
     * Get events filtered by type.
     */
    getByType(eventType: ObservabilityEventType, limit: number = 50): ObservabilityEvent[] {
        const matching: ObservabilityEvent[] = [];
        for (let i = this.events.length - 1; i >= 0 && matching.length < limit; i--) {
            if (this.events[i]!.eventType === eventType) {
                matching.push(this.events[i]!);
            }
        }
        return matching;
    }

    /**
     * Get events filtered by pair key.
     */
    getByPair(pairKey: string, limit: number = 50): ObservabilityEvent[] {
        const matching: ObservabilityEvent[] = [];
        for (let i = this.events.length - 1; i >= 0 && matching.length < limit; i--) {
            if (this.events[i]!.pairKey === pairKey) {
                matching.push(this.events[i]!);
            }
        }
        return matching;
    }

    /**
     * Get events since a specific sequence number (for incremental polling).
     * Returns events with seq > afterSeq, in insertion order (oldest first).
     */
    getSince(afterSeq: number, limit: number = 100): ObservabilityEvent[] {
        const result: ObservabilityEvent[] = [];
        for (const event of this.events) {
            if (event.seq > afterSeq) {
                result.push(event);
                if (result.length >= limit) break;
            }
        }
        return result;
    }

    /**
     * Get events within a time range (for forensic replay).
     * Returns events in insertion order (oldest first).
     */
    getTimeRange(startMs: number, endMs: number): ObservabilityEvent[] {
        return this.events.filter(
            (e) => e.timestampMs >= startMs && e.timestampMs <= endMs,
        );
    }

    /**
     * Get the current sequence number (for incremental polling).
     */
    getSeq(): number {
        return this.seq;
    }

    /**
     * Get the count of events in the buffer.
     */
    getCount(): number {
        return this.events.length;
    }

    /**
     * Whether execution was blocked on the last gate evaluation.
     */
    isBlocked(): boolean {
        return this.wasBlocked;
    }

    /**
     * Get summary statistics for the event stream.
     */
    getSummary(): Record<ObservabilityEventType, number> {
        const counts = {} as Record<ObservabilityEventType, number>;
        for (const type of OBSERVABILITY_EVENT_TYPES) {
            counts[type] = 0;
        }
        for (const event of this.events) {
            counts[event.eventType]++;
        }
        return counts;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    /**
     * Clear all events and reset state.
     */
    clear(): void {
        this.events = [];
        this.seq = 0;
        this.lastDedupKeys.clear();
        this.wasBlocked = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic dedup key from event type, pair, and detail.
 * Uses a cheap approach: concatenate primitive values directly,
 * only falling back to JSON.stringify for non-primitive detail values.
 */
function buildDedupKey(
    eventType: ObservabilityEventType,
    pairKey: string,
    detail: Record<string, unknown>,
): DedupKey {
    const keys = Object.keys(detail);
    if (keys.length === 0) {
        return `${eventType}:${pairKey}:` as DedupKey;
    }
    keys.sort();
    let detailStr = '';
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const v = detail[k];
        // Fast path: primitives don't need JSON.stringify
        if (i > 0) detailStr += '|';
        detailStr += k;
        detailStr += '=';
        if (v === null || v === undefined || typeof v !== 'object') {
            detailStr += String(v);
        } else {
            detailStr += JSON.stringify(v);
        }
    }
    return `${eventType}:${pairKey}:${detailStr}`;
}
