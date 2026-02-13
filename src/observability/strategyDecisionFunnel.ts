import { FlowRegime } from '../market/flowMetrics';

export interface StrategyDecisionFunnel {
    strategyTicks: number;
    candidatesBuilt: number;
    rejectedCount: number;
    rejectedByReason: Record<string, number>;
    approvedCount: number;
    submitAttemptCount: number;
    submitSuccessCount: number;
    submitFailCount: number;
    lastSubmitError: string | null;
    lastTxHash: string | null;
}

export interface StrategyApprovalEvent {
    side?: 'buy' | 'sell';
    sizeBase?: number;
    expectedPriceSource?: string;
    [key: string]: unknown;
}

export interface StrategyRejectEvent {
    reasonCode: string;
    [key: string]: unknown;
}

export interface StrategyFunnelRecorder {
    markCandidateBuilt: () => void;
    markRejected: (reasonCode: string, detail?: Record<string, unknown>) => void;
    markApproved: (event?: StrategyApprovalEvent) => void;
}

export type StrategyDecisionFunnelMap = Record<string, StrategyDecisionFunnel>;

export interface StrategySubmitTelemetryEvent {
    strategy: string;
    pairKey: string;
    stage: 'attempt' | 'success' | 'fail';
    txHash?: string | null;
    errorCode?: string | null;
}

export interface StrategyEventContext {
    pairKey: string;
    regime: FlowRegime | null;
    spreadBps: number | null;
    healthScore: number | null;
    fsmState: string;
}

export function createStrategyDecisionFunnel(): StrategyDecisionFunnel {
    return {
        strategyTicks: 0,
        candidatesBuilt: 0,
        rejectedCount: 0,
        rejectedByReason: {},
        approvedCount: 0,
        submitAttemptCount: 0,
        submitSuccessCount: 0,
        submitFailCount: 0,
        lastSubmitError: null,
        lastTxHash: null,
    };
}

export function cloneStrategyDecisionFunnelMap(
    map: StrategyDecisionFunnelMap,
): StrategyDecisionFunnelMap {
    const out: StrategyDecisionFunnelMap = {};
    for (const [strategy, funnel] of Object.entries(map)) {
        out[strategy] = {
            ...funnel,
            rejectedByReason: { ...funnel.rejectedByReason },
        };
    }
    return out;
}

/**
 * Apply submit-path telemetry to a single strategy funnel.
 * Pure helper used by runtime aggregation and tests.
 */
export function applySubmitTelemetryToFunnel(
    funnel: StrategyDecisionFunnel,
    event: StrategySubmitTelemetryEvent,
): void {
    if (event.stage === 'attempt') {
        funnel.submitAttemptCount += 1;
        return;
    }

    if (event.stage === 'success') {
        funnel.submitSuccessCount += 1;
        if (event.txHash) {
            funnel.lastTxHash = event.txHash;
        }
        funnel.lastSubmitError = null;
        return;
    }

    funnel.submitFailCount += 1;
    funnel.lastSubmitError = event.errorCode ?? 'submit-failed';
}
