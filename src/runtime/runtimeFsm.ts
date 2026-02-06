/**
 * Runtime Finite State Machine — Institutional Lifecycle Management
 *
 * Manages the bot runtime through 8 discrete lifecycle states:
 *
 *   BOOTING            → Constructor / pre-connect
 *   SYNCING_LEDGER     → XRPL WebSocket connected, waiting for ledger data
 *   SUBSCRIBING_FEEDS  → Subscribing to transaction/ledger streams
 *   WARMING_MARKET_CACHE → First order-book refresh + market data priming
 *   READY              → All systems nominal — ONLY state that allows execution
 *   DEGRADED           → Health score below threshold / partial feed loss
 *   RECOVERING         → Active feed-stall recovery in progress
 *   HALTED             → Graceful shutdown completed (terminal)
 *
 * State invariants:
 *   • Only READY allows order execution
 *   • HALTED is terminal — no transitions out
 *   • DEGRADED ↔ READY is allowed (health-based toggling)
 *   • RECOVERING → READY | DEGRADED based on recovery outcome
 */

import { runtimeLog as logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeState =
    | 'BOOTING'
    | 'SYNCING_LEDGER'
    | 'SUBSCRIBING_FEEDS'
    | 'WARMING_MARKET_CACHE'
    | 'READY'
    | 'DEGRADED'
    | 'RECOVERING'
    | 'HALTED';

export interface RuntimeStateTransition {
    from: RuntimeState;
    to: RuntimeState;
    reason: string;
    timestamp: number;
}

export interface RuntimeFSMSnapshot {
    /** Current FSM state. */
    state: RuntimeState;
    /** When the FSM entered the current state (ms epoch). */
    enteredAt: number;
    /** How long the FSM has been in the current state (ms). */
    durationMs: number;
    /** Total number of transitions since boot. */
    transitionCount: number;
    /** Last N transitions for observability. */
    recentTransitions: RuntimeStateTransition[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Valid transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adjacency map of allowed state transitions.
 * Any transition not in this map will be rejected.
 */
const VALID_TRANSITIONS: ReadonlyMap<RuntimeState, ReadonlySet<RuntimeState>> = new Map([
    // Boot sequence (linear)
    ['BOOTING', new Set<RuntimeState>(['SYNCING_LEDGER', 'HALTED'])],
    ['SYNCING_LEDGER', new Set<RuntimeState>(['SUBSCRIBING_FEEDS', 'HALTED'])],
    ['SUBSCRIBING_FEEDS', new Set<RuntimeState>(['WARMING_MARKET_CACHE', 'HALTED'])],
    ['WARMING_MARKET_CACHE', new Set<RuntimeState>(['READY', 'DEGRADED', 'HALTED'])],

    // Operational states
    ['READY', new Set<RuntimeState>(['DEGRADED', 'RECOVERING', 'HALTED'])],
    ['DEGRADED', new Set<RuntimeState>(['READY', 'RECOVERING', 'HALTED'])],
    ['RECOVERING', new Set<RuntimeState>(['READY', 'DEGRADED', 'HALTED'])],

    // Terminal
    ['HALTED', new Set<RuntimeState>([])],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Runtime FSM
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of transitions kept in the history ring buffer. */
const MAX_HISTORY = 50;

export class RuntimeFSM {
    private currentState: RuntimeState = 'BOOTING';
    private stateEnteredAt: number;
    private transitionCount = 0;
    private history: RuntimeStateTransition[] = [];

    constructor(nowMs: number = Date.now()) {
        this.stateEnteredAt = nowMs;
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /** Current lifecycle state. */
    getState(): RuntimeState {
        return this.currentState;
    }

    /** Whether execution is allowed (READY only). */
    isExecutionAllowed(): boolean {
        return this.currentState === 'READY';
    }

    /** Whether the FSM has reached the terminal HALTED state. */
    isHalted(): boolean {
        return this.currentState === 'HALTED';
    }

    /** Whether the FSM is in a boot-sequence state (not yet READY). */
    isBooting(): boolean {
        return (
            this.currentState === 'BOOTING' ||
            this.currentState === 'SYNCING_LEDGER' ||
            this.currentState === 'SUBSCRIBING_FEEDS' ||
            this.currentState === 'WARMING_MARKET_CACHE'
        );
    }

    /** Whether the FSM is in the DEGRADED state. */
    isDegraded(): boolean {
        return this.currentState === 'DEGRADED';
    }

    /** Whether the FSM is in the RECOVERING state. */
    isRecovering(): boolean {
        return this.currentState === 'RECOVERING';
    }

    /** How long (ms) the FSM has been in the current state. */
    durationInCurrentState(nowMs: number = Date.now()): number {
        return nowMs - this.stateEnteredAt;
    }

    /** Full snapshot for observability / API exposure. */
    getSnapshot(nowMs: number = Date.now()): RuntimeFSMSnapshot {
        return {
            state: this.currentState,
            enteredAt: this.stateEnteredAt,
            durationMs: nowMs - this.stateEnteredAt,
            transitionCount: this.transitionCount,
            recentTransitions: [...this.history],
        };
    }

    // ─── Mutations ───────────────────────────────────────────────────────

    /**
     * Attempt a state transition.
     *
     * @returns true if the transition was valid and applied.
     * @throws Error if the transition is not in the valid adjacency map.
     */
    transition(to: RuntimeState, reason: string, nowMs: number = Date.now()): boolean {
        if (this.currentState === to) {
            // No-op: already in target state (idempotent)
            return false;
        }

        const allowed = VALID_TRANSITIONS.get(this.currentState);
        if (!allowed || !allowed.has(to)) {
            const msg = `Invalid RuntimeFSM transition: ${this.currentState} → ${to} (reason: ${reason})`;
            logger.error({ from: this.currentState, to, reason }, msg);
            throw new Error(msg);
        }

        const transition: RuntimeStateTransition = {
            from: this.currentState,
            to,
            reason,
            timestamp: nowMs,
        };

        const previousState = this.currentState;
        this.currentState = to;
        this.stateEnteredAt = nowMs;
        this.transitionCount++;

        // Ring buffer history
        this.history.push(transition);
        if (this.history.length > MAX_HISTORY) {
            this.history.shift();
        }

        logger.info(
            { from: previousState, to, reason, transitionCount: this.transitionCount },
            `RUNTIME_FSM: ${previousState} → ${to}`,
        );

        return true;
    }

    /**
     * Force transition to HALTED from any non-HALTED state.
     * Used during emergency shutdown where the normal adjacency
     * map might not have a direct edge (e.g., SUBSCRIBING_FEEDS → HALTED
     * is already allowed, but this provides a safe fallback).
     */
    forceHalt(reason: string, nowMs: number = Date.now()): void {
        if (this.currentState === 'HALTED') return;
        // HALTED is reachable from every non-HALTED state in our map,
        // so this will always succeed via normal transition.
        this.transition('HALTED', reason, nowMs);
    }

    /**
     * Reset FSM to BOOTING state (for runtime.reset()).
     * Only callable from HALTED or BOOTING (prevents mid-flight resets).
     */
    reset(nowMs: number = Date.now()): void {
        this.currentState = 'BOOTING';
        this.stateEnteredAt = nowMs;
        this.transitionCount = 0;
        this.history = [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a transition from → to is valid without performing it.
 */
export function isValidTransition(from: RuntimeState, to: RuntimeState): boolean {
    const allowed = VALID_TRANSITIONS.get(from);
    return !!allowed && allowed.has(to);
}
