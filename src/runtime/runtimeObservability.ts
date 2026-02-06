/**
 * Runtime Observability — Structured Telemetry for Institutional Monitoring
 *
 * Exposes a single `RuntimeTelemetry` snapshot that aggregates all runtime
 * health dimensions into one serialisable structure for API routes,
 * dashboards, and external monitoring integrations.
 *
 * Consumers:
 *   • API route `/api/health` for readiness/liveness probes
 *   • Dashboard `MarketDataHealthPanel` and `RuntimeStatePanel`
 *   • External log/metric pipelines (structured JSON)
 */

import { RuntimeState, RuntimeFSMSnapshot } from './runtimeFsm';
import { ExecutionGateResult } from '../execution/executionGate';
import { MarketHealthResult } from '../market/marketDataHealth';
import { FeedStallState, StallRecoveryStage } from '../market/feedStallRecovery';
import { PairSwitchState } from './tradingRuntime';
import { PairSwitchPhase } from './pairSwitchFsm';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FeedHealthTelemetry {
    /** Whether the XRPL WebSocket is connected. */
    connected: boolean;
    /** Whether the WebSocket is in a reconnecting state. */
    reconnecting: boolean;
    /** Timestamp of last order-book update received (ms epoch). */
    lastBookUpdateMs: number;
    /** Timestamp of last trade-tape event received (ms epoch). */
    lastTapeUpdateMs: number;
    /** Timestamp of last validated ledger advance (ms epoch). */
    lastLedgerAdvanceMs: number;
    /** Current feed-stall recovery stage. */
    stallRecoveryStage: StallRecoveryStage;
    /** Whether stall recovery is actively executing. */
    stallRecoveryActive: boolean;
    /** Total recovery attempts since last healthy state. */
    stallRecoveryAttempts: number;
}

export interface LedgerTelemetry {
    /** Current validated ledger index. */
    ledgerIndex: number;
    /** Previous validated ledger index (from prior tick). */
    previousLedgerIndex: number;
    /** Timestamp of last ledger close event (ms epoch). */
    lastCloseMs: number;
    /** Age of the last ledger close (ms). */
    ledgerAgeMs: number;
}

export interface BalanceTelemetry {
    /** Timestamp of last balance snapshot (ms epoch). */
    lastSnapshotMs: number;
    /** Ledger index at which balance was fetched. */
    snapshotLedgerIndex: number;
    /** Age of the balance snapshot (ms). */
    snapshotAgeMs: number;
}

export interface RuntimeTelemetry {
    /** Current runtime lifecycle FSM state. */
    runtimeState: RuntimeState;
    /** Full FSM snapshot with transition history. */
    fsm: RuntimeFSMSnapshot;
    /** Pair-switch FSM state. */
    pairSwitchState: PairSwitchState;
    /** 12-state pair-switch FSM phase. */
    pairSwitchPhase: PairSwitchPhase;
    /** Feed health dimensions. */
    feed: FeedHealthTelemetry;
    /** Ledger progress telemetry. */
    ledger: LedgerTelemetry;
    /** Balance snapshot telemetry. */
    balance: BalanceTelemetry;
    /** Latest market data health quorum result. */
    marketHealth: MarketHealthResult | null;
    /** Latest execution gate verdict. */
    executionGate: ExecutionGateResult | null;
    /** Timestamp when this telemetry snapshot was assembled (ms epoch). */
    assembledAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeTelemetryInput {
    fsmSnapshot: RuntimeFSMSnapshot;
    pairSwitchState: PairSwitchState;
    pairSwitchPhase?: PairSwitchPhase;
    isConnected: boolean;
    isReconnecting: boolean;
    feedStallState: FeedStallState | null;
    ledgerIndex: number;
    previousLedgerIndex: number;
    lastLedgerCloseMs: number;
    lastBalanceSnapshotMs: number;
    lastBalanceLedgerIndex: number;
    lastBookUpdateMs: number;
    lastTapeUpdateMs: number;
    lastLedgerAdvanceMs: number;
    marketHealth: MarketHealthResult | null;
    executionGate: ExecutionGateResult | null;
}

/**
 * Assemble a complete RuntimeTelemetry snapshot from raw runtime state.
 * This is a pure function — no side effects.
 */
export function buildRuntimeTelemetry(
    input: RuntimeTelemetryInput,
    nowMs: number = Date.now(),
): RuntimeTelemetry {
    const feedStall = input.feedStallState;

    return {
        runtimeState: input.fsmSnapshot.state,
        fsm: input.fsmSnapshot,
        pairSwitchState: input.pairSwitchState,
        pairSwitchPhase: input.pairSwitchPhase ?? 'READY',
        feed: {
            connected: input.isConnected,
            reconnecting: input.isReconnecting,
            lastBookUpdateMs: input.lastBookUpdateMs,
            lastTapeUpdateMs: input.lastTapeUpdateMs,
            lastLedgerAdvanceMs: input.lastLedgerAdvanceMs,
            stallRecoveryStage: feedStall?.stage ?? 'HEALTHY',
            stallRecoveryActive: feedStall?.recovering ?? false,
            stallRecoveryAttempts: feedStall?.recoveryAttempts ?? 0,
        },
        ledger: {
            ledgerIndex: input.ledgerIndex,
            previousLedgerIndex: input.previousLedgerIndex,
            lastCloseMs: input.lastLedgerCloseMs,
            ledgerAgeMs: input.lastLedgerCloseMs > 0 ? nowMs - input.lastLedgerCloseMs : 0,
        },
        balance: {
            lastSnapshotMs: input.lastBalanceSnapshotMs,
            snapshotLedgerIndex: input.lastBalanceLedgerIndex,
            snapshotAgeMs: input.lastBalanceSnapshotMs > 0 ? nowMs - input.lastBalanceSnapshotMs : 0,
        },
        marketHealth: input.marketHealth,
        executionGate: input.executionGate,
        assembledAt: nowMs,
    };
}
