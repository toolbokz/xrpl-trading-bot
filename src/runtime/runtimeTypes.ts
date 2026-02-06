/**
 * Runtime Types — Shared type definitions for the runtime subsystem.
 *
 * Houses types that are consumed across multiple modules to avoid
 * heavyweight imports from tradingRuntime.ts. Modules that only need
 * types should import from here instead.
 */

import type { PairSwitchPhase } from './pairSwitchFsm';

// ─────────────────────────────────────────────────────────────────────────────
// Pair-switch types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use PairSwitchPhase from pairSwitchFsm.ts for the 12-state FSM.
 * Kept for backward compatibility with tests and external consumers.
 */
export type PairSwitchState = 'IDLE' | 'SWITCHING' | 'SYNCING' | 'READY' | 'FAILED';

/** Structured pair-switch lifecycle event for observability */
export interface PairSwitchEvent {
    event: string;
    pairKey: string;
    previousPairKey?: string | undefined;
    timestamp: number;
    switchState: PairSwitchState;
    /** The 12-state FSM phase (if orchestrator is active). */
    switchPhase?: PairSwitchPhase | undefined;
    detail?: string | undefined;
}

/** Return type for setActivePair() — includes async pending state. */
export interface PairSwitchResult {
    success: boolean;
    activePair: string;
    /** True while the orchestrator is still completing async phases. */
    pending: boolean;
    /** Unique ID for this switch attempt (present when pending=true). */
    switchId?: string;
    error?: string;
}

/** Full pair-switch status snapshot — source of truth for readiness. */
export interface PairSwitchStatus {
    activePair: string;
    /** True while orchestrator async phases are in flight. */
    pending: boolean;
    /** Unique ID of the current/last switch attempt. */
    switchId: string | null;
    /** Target pair key of the pending switch. */
    targetPairKey: string | null;
    /** Last error from a failed switch (null on success). */
    lastError: string | null;
    /** @deprecated Legacy 5-state FSM. */
    legacyState: PairSwitchState;
    /** Current 12-state orchestrator phase. */
    orchestratorPhase: PairSwitchPhase;
    /** Whether the orchestrator FSM is in READY state. */
    orchestratorReady: boolean;
}
