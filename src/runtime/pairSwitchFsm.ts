/**
 * Pair Switch FSM — 12-State Deterministic Pair Switching
 *
 * Guarantees safe pair transitions with no data mixing, no ghost feeds,
 * and no execution during the switch window.
 *
 * States:
 *   READY                      → Nominal — execution allowed
 *   FREEZE_EXECUTION           → Tick processing blocked
 *   UNSUBSCRIBE_OLD_FEEDS      → Old pair streams detached
 *   DESTROY_PAIR_CONTEXT       → Old context fully destroyed
 *   RESET_PAIR_METRICS_WINDOWS → Rolling windows / cached snapshots wiped
 *   CREATE_NEW_PAIR_CONTEXT    → New context allocated
 *   SUBSCRIBE_NEW_FEEDS        → New pair streams attached
 *   WAIT_FIRST_BOOK            → Awaiting first valid order-book snapshot
 *   WAIT_FIRST_TAPE            → Awaiting first tape event (or timeout)
 *   REFRESH_BALANCES           → Fetching base + quote balances
 *   VALIDATE_DATA_TRUTH        → Health, snapshot, and quorum validation
 *   FAILED                     → Terminal failure (rollback expected)
 *
 * Execution is ONLY allowed in the READY state.
 * Every non-READY state produces structured events.
 */

import { runtimeLog as logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PairSwitchPhase =
    | 'READY'
    | 'FREEZE_EXECUTION'
    | 'UNSUBSCRIBE_OLD_FEEDS'
    | 'DESTROY_PAIR_CONTEXT'
    | 'RESET_PAIR_METRICS_WINDOWS'
    | 'CREATE_NEW_PAIR_CONTEXT'
    | 'SUBSCRIBE_NEW_FEEDS'
    | 'WAIT_FIRST_BOOK'
    | 'WAIT_FIRST_TAPE'
    | 'REFRESH_BALANCES'
    | 'VALIDATE_DATA_TRUTH'
    | 'FAILED';

export interface PairSwitchTransition {
    from: PairSwitchPhase;
    to: PairSwitchPhase;
    reason: string;
    timestamp: number;
}

export interface PairSwitchFsmSnapshot {
    phase: PairSwitchPhase;
    enteredAt: number;
    durationMs: number;
    transitionCount: number;
    sourcePair: string | null;
    targetPair: string | null;
    recentTransitions: PairSwitchTransition[];
}

/** Events emitted during pair switching for observability. */
export type PairSwitchEventType =
    | 'PAIR_SWITCH_START'
    | 'PAIR_SWITCH_EXECUTION_FROZEN'
    | 'PAIR_SWITCH_FEEDS_DETACHED'
    | 'PAIR_SWITCH_CONTEXT_DESTROYED'
    | 'PAIR_SWITCH_METRICS_RESET'
    | 'PAIR_SWITCH_CONTEXT_CREATED'
    | 'PAIR_SWITCH_FEEDS_ACTIVE'
    | 'PAIR_SWITCH_BOOK_RECEIVED'
    | 'PAIR_SWITCH_TAPE_RECEIVED'
    | 'PAIR_SWITCH_BALANCES_REFRESHED'
    | 'PAIR_SWITCH_DATA_VALIDATED'
    | 'PAIR_SWITCH_READY'
    | 'PAIR_SWITCH_FAILED';

export interface PairSwitchEvent {
    type: PairSwitchEventType;
    phase: PairSwitchPhase;
    sourcePair: string | null;
    targetPair: string | null;
    timestamp: number;
    detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Valid transitions — deterministic forward-only flow + FAILED escape
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TRANSITIONS: ReadonlyMap<PairSwitchPhase, ReadonlySet<PairSwitchPhase>> = new Map([
    ['READY',                      new Set<PairSwitchPhase>(['FREEZE_EXECUTION'])],
    ['FREEZE_EXECUTION',           new Set<PairSwitchPhase>(['UNSUBSCRIBE_OLD_FEEDS', 'FAILED'])],
    ['UNSUBSCRIBE_OLD_FEEDS',      new Set<PairSwitchPhase>(['DESTROY_PAIR_CONTEXT', 'FAILED'])],
    ['DESTROY_PAIR_CONTEXT',       new Set<PairSwitchPhase>(['RESET_PAIR_METRICS_WINDOWS', 'FAILED'])],
    ['RESET_PAIR_METRICS_WINDOWS', new Set<PairSwitchPhase>(['CREATE_NEW_PAIR_CONTEXT', 'FAILED'])],
    ['CREATE_NEW_PAIR_CONTEXT',    new Set<PairSwitchPhase>(['SUBSCRIBE_NEW_FEEDS', 'FAILED'])],
    ['SUBSCRIBE_NEW_FEEDS',        new Set<PairSwitchPhase>(['WAIT_FIRST_BOOK', 'FAILED'])],
    ['WAIT_FIRST_BOOK',            new Set<PairSwitchPhase>(['WAIT_FIRST_TAPE', 'FAILED'])],
    ['WAIT_FIRST_TAPE',            new Set<PairSwitchPhase>(['REFRESH_BALANCES', 'FAILED'])],
    ['REFRESH_BALANCES',           new Set<PairSwitchPhase>(['VALIDATE_DATA_TRUTH', 'FAILED'])],
    ['VALIDATE_DATA_TRUTH',        new Set<PairSwitchPhase>(['READY', 'FAILED'])],
    ['FAILED',                     new Set<PairSwitchPhase>(['READY'])],
]);

// ─────────────────────────────────────────────────────────────────────────────
// FSM Class
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum history entries to keep. */
const MAX_HISTORY = 30;

export class PairSwitchFsm {
    private phase: PairSwitchPhase = 'READY';
    private phaseEnteredAt: number;
    private transitionCount = 0;
    private history: PairSwitchTransition[] = [];
    private sourcePair: string | null = null;
    private targetPair: string | null = null;
    /** Callback invoked on every transition for observability. */
    private onEvent: ((event: PairSwitchEvent) => void) | null = null;

    constructor(nowMs: number = Date.now()) {
        this.phaseEnteredAt = nowMs;
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /** Current phase. */
    getPhase(): PairSwitchPhase {
        return this.phase;
    }

    /** Whether execution is safe (only true in READY). */
    isReady(): boolean {
        return this.phase === 'READY';
    }

    /** Whether a switch is in progress (any non-READY, non-FAILED state). */
    isSwitching(): boolean {
        return this.phase !== 'READY' && this.phase !== 'FAILED';
    }

    /** Whether the FSM is in a terminal FAILED state. */
    isFailed(): boolean {
        return this.phase === 'FAILED';
    }

    /** Duration in current phase (ms). */
    durationInPhase(nowMs: number = Date.now()): number {
        return nowMs - this.phaseEnteredAt;
    }

    /** The pair we're switching from. */
    getSourcePair(): string | null {
        return this.sourcePair;
    }

    /** The pair we're switching to. */
    getTargetPair(): string | null {
        return this.targetPair;
    }

    /** Full snapshot for observability / API. */
    getSnapshot(nowMs: number = Date.now()): PairSwitchFsmSnapshot {
        return {
            phase: this.phase,
            enteredAt: this.phaseEnteredAt,
            durationMs: nowMs - this.phaseEnteredAt,
            transitionCount: this.transitionCount,
            sourcePair: this.sourcePair,
            targetPair: this.targetPair,
            recentTransitions: [...this.history],
        };
    }

    // ─── Mutations ───────────────────────────────────────────────────────

    /**
     * Register an event callback for observability.
     */
    setEventHandler(handler: (event: PairSwitchEvent) => void): void {
        this.onEvent = handler;
    }

    /**
     * Begin a pair switch.
     * Must be called from READY. Sets source/target pairs.
     */
    beginSwitch(sourcePair: string, targetPair: string, nowMs: number = Date.now()): void {
        if (this.phase !== 'READY') {
            throw new Error(`Cannot begin pair switch: FSM in ${this.phase}, expected READY`);
        }
        this.sourcePair = sourcePair;
        this.targetPair = targetPair;
        this.advance('FREEZE_EXECUTION', 'pair-switch-initiated', nowMs);
    }

    /**
     * Advance to the next phase in the forward-only flow.
     * Validates the transition is legal.
     */
    advance(to: PairSwitchPhase, reason: string, nowMs: number = Date.now()): void {
        if (this.phase === to) return; // idempotent

        const allowed = VALID_TRANSITIONS.get(this.phase);
        if (!allowed || !allowed.has(to)) {
            const msg = `Invalid PairSwitchFsm transition: ${this.phase} → ${to} (reason: ${reason})`;
            logger.error({ from: this.phase, to, reason }, msg);
            throw new Error(msg);
        }

        const prev = this.phase;
        this.phase = to;
        this.phaseEnteredAt = nowMs;
        this.transitionCount++;

        const transition: PairSwitchTransition = {
            from: prev,
            to,
            reason,
            timestamp: nowMs,
        };

        this.history.push(transition);
        if (this.history.length > MAX_HISTORY) {
            this.history.shift();
        }

        logger.info(
            { from: prev, to, reason, sourcePair: this.sourcePair, targetPair: this.targetPair },
            `PAIR_SWITCH_FSM: ${prev} → ${to}`,
        );

        // Emit structured event
        this.emitEvent(to, reason, nowMs);
    }

    /**
     * Transition to FAILED from any non-READY state.
     */
    fail(reason: string, nowMs: number = Date.now()): void {
        if (this.phase === 'READY') return; // nothing to fail
        if (this.phase === 'FAILED') return; // already failed

        this.advance('FAILED', reason, nowMs);
    }

    /**
     * Recover from FAILED → READY (after rollback completes).
     */
    recover(reason: string, nowMs: number = Date.now()): void {
        if (this.phase !== 'FAILED') {
            throw new Error(`Cannot recover: FSM in ${this.phase}, expected FAILED`);
        }
        this.advance('READY', reason, nowMs);
        this.sourcePair = null;
        this.targetPair = null;
    }

    /**
     * Complete the switch: VALIDATE_DATA_TRUTH → READY.
     */
    complete(reason: string = 'switch-complete', nowMs: number = Date.now()): void {
        if (this.phase !== 'VALIDATE_DATA_TRUTH') {
            throw new Error(`Cannot complete: FSM in ${this.phase}, expected VALIDATE_DATA_TRUTH`);
        }
        this.advance('READY', reason, nowMs);
        this.sourcePair = null;
        this.targetPair = null;
    }

    /**
     * Reset FSM to READY (for runtime reset/shutdown).
     */
    reset(nowMs: number = Date.now()): void {
        this.phase = 'READY';
        this.phaseEnteredAt = nowMs;
        this.transitionCount = 0;
        this.history = [];
        this.sourcePair = null;
        this.targetPair = null;
    }

    // ─── Internal ────────────────────────────────────────────────────────

    private emitEvent(phase: PairSwitchPhase, detail: string, nowMs: number): void {
        const eventMap: Record<PairSwitchPhase, PairSwitchEventType> = {
            FREEZE_EXECUTION: 'PAIR_SWITCH_START',
            UNSUBSCRIBE_OLD_FEEDS: 'PAIR_SWITCH_EXECUTION_FROZEN',
            DESTROY_PAIR_CONTEXT: 'PAIR_SWITCH_FEEDS_DETACHED',
            RESET_PAIR_METRICS_WINDOWS: 'PAIR_SWITCH_CONTEXT_DESTROYED',
            CREATE_NEW_PAIR_CONTEXT: 'PAIR_SWITCH_METRICS_RESET',
            SUBSCRIBE_NEW_FEEDS: 'PAIR_SWITCH_CONTEXT_CREATED',
            WAIT_FIRST_BOOK: 'PAIR_SWITCH_FEEDS_ACTIVE',
            WAIT_FIRST_TAPE: 'PAIR_SWITCH_BOOK_RECEIVED',
            REFRESH_BALANCES: 'PAIR_SWITCH_TAPE_RECEIVED',
            VALIDATE_DATA_TRUTH: 'PAIR_SWITCH_BALANCES_REFRESHED',
            READY: 'PAIR_SWITCH_READY',
            FAILED: 'PAIR_SWITCH_FAILED',
        };

        const type = eventMap[phase];
        if (!type) return;

        const event: PairSwitchEvent = {
            type,
            phase,
            sourcePair: this.sourcePair,
            targetPair: this.targetPair,
            timestamp: nowMs,
            detail,
        };

        this.onEvent?.(event);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a PairSwitchPhase transition is valid.
 */
export function isValidPairSwitchTransition(from: PairSwitchPhase, to: PairSwitchPhase): boolean {
    const allowed = VALID_TRANSITIONS.get(from);
    return !!allowed && allowed.has(to);
}
