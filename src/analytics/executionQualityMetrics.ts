import { computeCanonicalSlippageBps } from './slippageMath';

export type ExecutionSide = 'buy' | 'sell';

export interface LatencyInput {
    decisionTs: number | null | undefined;
    submitTs: number | null | undefined;
    validatedTs: number | null | undefined;
}

export interface LatencyMetrics {
    decisionToSubmitMs: number | null;
    submitToValidatedMs: number | null;
    decisionToValidatedMs: number | null;
}

export interface ExecutionQualityMetricInput {
    side: ExecutionSide;
    intentPrice?: number | null;
    midAtDecision?: number | null;
    bboAtDecision?: number | null;
    decisionPrice?: number | null;
    fillPrice?: number | null;
    amountBase?: number | null;
    filledBase?: number | null;
    midAfter1m?: number | null;
    midAfter5m?: number | null;
}

export interface ExecutionQualityMetrics {
    slippageBpsVsIntent: number | null;
    slippageBpsVsMid: number | null;
    slippageBpsVsBbo: number | null;
    effSpreadBps: number | null;
    realizedSpreadBps1m: number | null;
    realizedSpreadBps5m: number | null;
    impactBps1m: number | null;
    impactBps5m: number | null;
    implShortfallQuote: number | null;
    fillRatio: number | null;
}

function hasPositive(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sideSign(side: ExecutionSide): number {
    return side === 'buy' ? 1 : -1;
}

export function computeEffectiveSpreadBps(
    side: ExecutionSide,
    fillPrice: number | null | undefined,
    midAtDecision: number | null | undefined
): number | null {
    if (!hasPositive(fillPrice) || !hasPositive(midAtDecision)) return null;
    return 2 * sideSign(side) * ((fillPrice - midAtDecision) / midAtDecision) * 10_000;
}

export function computeRealizedSpreadBps(
    side: ExecutionSide,
    fillPrice: number | null | undefined,
    midAtDecision: number | null | undefined,
    midAfter: number | null | undefined
): number | null {
    if (!hasPositive(fillPrice) || !hasPositive(midAtDecision) || !hasPositive(midAfter)) return null;
    return 2 * sideSign(side) * ((fillPrice - midAfter) / midAtDecision) * 10_000;
}

export function computeImpactBps(
    side: ExecutionSide,
    midAtDecision: number | null | undefined,
    midAfter: number | null | undefined
): number | null {
    if (!hasPositive(midAtDecision) || !hasPositive(midAfter)) return null;
    return 2 * sideSign(side) * ((midAfter - midAtDecision) / midAtDecision) * 10_000;
}

export function computeImplementationShortfallQuote(
    side: ExecutionSide,
    decisionPrice: number | null | undefined,
    fillPrice: number | null | undefined,
    filledBase: number | null | undefined
): number | null {
    if (!hasPositive(decisionPrice) || !hasPositive(fillPrice) || !hasPositive(filledBase)) return null;
    if (side === 'buy') {
        return (fillPrice - decisionPrice) * filledBase;
    }
    return (decisionPrice - fillPrice) * filledBase;
}

export function computeFillRatio(
    amountBase: number | null | undefined,
    filledBase: number | null | undefined
): number | null {
    if (!hasPositive(amountBase) || filledBase == null || !Number.isFinite(filledBase) || filledBase < 0) return null;
    return Math.max(0, Math.min(1, filledBase / amountBase));
}

export function computeLatencyMetrics(input: LatencyInput): LatencyMetrics {
    const decisionToSubmitMs =
        hasPositive(input.decisionTs ?? null) && hasPositive(input.submitTs ?? null) && (input.submitTs as number) >= (input.decisionTs as number)
            ? (input.submitTs as number) - (input.decisionTs as number)
            : null;

    const submitToValidatedMs =
        hasPositive(input.submitTs ?? null) && hasPositive(input.validatedTs ?? null) && (input.validatedTs as number) >= (input.submitTs as number)
            ? (input.validatedTs as number) - (input.submitTs as number)
            : null;

    const decisionToValidatedMs =
        hasPositive(input.decisionTs ?? null) && hasPositive(input.validatedTs ?? null) && (input.validatedTs as number) >= (input.decisionTs as number)
            ? (input.validatedTs as number) - (input.decisionTs as number)
            : null;

    return {
        decisionToSubmitMs,
        submitToValidatedMs,
        decisionToValidatedMs,
    };
}

export function buildExecutionQualityMetrics(input: ExecutionQualityMetricInput): ExecutionQualityMetrics {
    const slippageBpsVsIntent = hasPositive(input.intentPrice) && hasPositive(input.fillPrice)
        ? computeCanonicalSlippageBps(input.side, input.intentPrice, input.fillPrice)
        : null;

    const slippageBpsVsMid = hasPositive(input.midAtDecision) && hasPositive(input.fillPrice)
        ? computeCanonicalSlippageBps(input.side, input.midAtDecision, input.fillPrice)
        : null;

    const slippageBpsVsBbo = hasPositive(input.bboAtDecision) && hasPositive(input.fillPrice)
        ? computeCanonicalSlippageBps(input.side, input.bboAtDecision, input.fillPrice)
        : null;

    const effSpreadBps = computeEffectiveSpreadBps(input.side, input.fillPrice, input.midAtDecision);
    const realizedSpreadBps1m = computeRealizedSpreadBps(input.side, input.fillPrice, input.midAtDecision, input.midAfter1m);
    const realizedSpreadBps5m = computeRealizedSpreadBps(input.side, input.fillPrice, input.midAtDecision, input.midAfter5m);
    const impactBps1m = computeImpactBps(input.side, input.midAtDecision, input.midAfter1m);
    const impactBps5m = computeImpactBps(input.side, input.midAtDecision, input.midAfter5m);

    const implShortfallQuote = computeImplementationShortfallQuote(
        input.side,
        input.decisionPrice,
        input.fillPrice,
        input.filledBase
    );
    const fillRatio = computeFillRatio(input.amountBase, input.filledBase);

    return {
        slippageBpsVsIntent,
        slippageBpsVsMid,
        slippageBpsVsBbo,
        effSpreadBps,
        realizedSpreadBps1m,
        realizedSpreadBps5m,
        impactBps1m,
        impactBps5m,
        implShortfallQuote,
        fillRatio,
    };
}
