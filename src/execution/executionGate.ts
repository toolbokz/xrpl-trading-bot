/**
 * Execution Gate — Market Data Truth Enforcement
 *
 * Evaluates whether the runtime is in a safe state for order execution.
 * Integrates MarketDataHealth quorum with runtime lifecycle state
 * (pair-switching, feed reconnecting, shutdown, etc.).
 *
 * Strategies call `evaluate()` before placing any on-ledger action.
 * The gate returns a deterministic ALLOW / BLOCK verdict with structured reasons.
 */

import { MarketHealthResult } from '../market/marketDataHealth';
import { PairSwitchState } from '../runtime/tradingRuntime';
import { RuntimeState } from '../runtime/runtimeFsm';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GateVerdict = 'ALLOW' | 'BLOCK';

export interface ExecutionGateResult {
    verdict: GateVerdict;
    reasons: string[];
    healthScore: number;
    /** Time of evaluation (ms epoch) */
    evaluatedAt: number;
}

export interface ExecutionGateConfig {
    /** Minimum health score required for execution (default 50) */
    minHealthScore: number;
    /** Maximum ledger staleness before blocking (default 60 000 ms) */
    maxLedgerStalenessMs: number;
}

export const DEFAULT_GATE_CONFIG: ExecutionGateConfig = {
    minHealthScore: 50,
    maxLedgerStalenessMs: 60_000,
};

export interface ExecutionGateInput {
    /** Current runtime lifecycle FSM state. Execution only allowed in READY. */
    runtimeState: RuntimeState;
    /** Latest market data health result from MarketDataHealth scorer. */
    health: MarketHealthResult;
    /** Whether the XRPL WebSocket is currently connected. */
    isConnected: boolean;
    /** Whether the XRPL WebSocket is in a reconnecting state. */
    isReconnecting: boolean;
    /** Current pair-switch FSM state from TradingRuntime. */
    pairSwitchState: PairSwitchState;
    /** Whether a runtime shutdown is in progress. */
    isShuttingDown: boolean;
    /** Whether the stall recovery system is currently in recovery mode. */
    isInRecovery: boolean;
    /** Whether the risk engine has triggered a kill-switch / emergency shutdown. */
    isRiskShutdown: boolean;
    /** Whether the latest market snapshot passed structural validation. */
    dataValid: boolean;
    /** Reasons the snapshot failed validation (empty when dataValid is true). */
    dataInvalidReasons: string[];
    /** Current ledger index (0 if unknown). */
    ledgerIndex: number;
    /** Time of last ledger close (ms epoch, 0 if unknown). */
    lastLedgerCloseMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate whether execution should be allowed based on runtime state
 * and market data health.
 *
 * Block precedence (checked top-to-bottom, first match wins):
 * 1. Shutdown in progress
 * 2. Runtime FSM not in READY state
 * 3. Feed disconnected / reconnecting
 * 4. Pair switch in progress
 * 5. Stall recovery in progress
 * 6. Risk engine kill-switch
 * 7. Snapshot structural validation failed
 * 8. Ledger stalled
 * 9. Health quorum below threshold
 */
export function evaluateExecutionGate(
    input: ExecutionGateInput,
    config: ExecutionGateConfig = DEFAULT_GATE_CONFIG,
): ExecutionGateResult {
    const nowMs = Date.now();
    const reasons: string[] = [];

    // 1. Shutdown
    if (input.isShuttingDown) {
        reasons.push('shutdown-in-progress');
        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    // 2. Runtime FSM not READY
    if (input.runtimeState !== 'READY') {
        reasons.push(`runtime-not-ready:${input.runtimeState}`);
        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    // 3. Feed disconnected / reconnecting
    if (!input.isConnected) {
        reasons.push('feed-disconnected');
    }
    if (input.isReconnecting) {
        reasons.push('feed-reconnecting');
    }
    if (reasons.length > 0) {
        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    // 4. Pair switching
    if (input.pairSwitchState === 'SWITCHING' || input.pairSwitchState === 'SYNCING') {
        reasons.push(`pair-switch-state:${input.pairSwitchState}`);
        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    // 5. Stall recovery
    if (input.isInRecovery) {
        reasons.push('stall-recovery-in-progress');
        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    // 6. Risk engine kill-switch
    if (input.isRiskShutdown) {
        reasons.push('risk-engine-blocked');
        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    // 7. Snapshot structural validation
    if (!input.dataValid) {
        reasons.push('snapshot-invalid');
        for (const r of input.dataInvalidReasons) {
            reasons.push(`data:${r}`);
        }
        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    // 8. Ledger staleness
    if (input.lastLedgerCloseMs > 0) {
        const ledgerAge = nowMs - input.lastLedgerCloseMs;
        if (ledgerAge > config.maxLedgerStalenessMs) {
            reasons.push(`ledger-stalled:${Math.round(ledgerAge)}ms`);
            return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
        }
    }

    // 9. Health quorum
    if (input.health.score < config.minHealthScore) {
        reasons.push(`health-below-threshold:${input.health.score}<${config.minHealthScore}`);

        // Add signal-level reasons for observability
        for (const [key, signal] of Object.entries(input.health.signals)) {
            if (signal.score < 50) {
                reasons.push(`signal-${key}:${signal.score}[${signal.reasons.join(',')}]`);
            }
        }

        return { verdict: 'BLOCK', reasons, healthScore: input.health.score, evaluatedAt: nowMs };
    }

    return { verdict: 'ALLOW', reasons: ['all-checks-passed'], healthScore: input.health.score, evaluatedAt: nowMs };
}
