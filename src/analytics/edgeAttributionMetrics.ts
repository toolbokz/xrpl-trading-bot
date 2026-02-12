export type EdgeSide = 'buy' | 'sell';

export interface EdgeAttributionMetricInput {
    side: EdgeSide;
    midDecision?: number | null;
    bidDecision?: number | null;
    askDecision?: number | null;
    fillPrice?: number | null;
    baseFilled?: number | null;
    strategyFair?: number | null;
    midDecision1m?: number | null;
    midDecision5m?: number | null;
    midFill1m?: number | null;
    midFill5m?: number | null;
}

export interface EdgeAttributionMetrics {
    signalEdgeBpsExAnte: number | null;
    signalEdgeBpsExPost1m: number | null;
    signalEdgeBpsExPost5m: number | null;
    executionEdgeBpsVsMid: number | null;
    executionEdgeBpsVsBbo: number | null;
    driftBps1m: number | null;
    driftBps5m: number | null;
    pnlExecQuote: number | null;
    pnlDriftQuote1m: number | null;
    pnlTotalQuote1m: number | null;
    pnlDriftQuote5m: number | null;
    pnlTotalQuote5m: number | null;
    hasDecisionSnapshot: boolean;
    hasHorizon1m: boolean;
    hasHorizon5m: boolean;
}

const PNL_IDENTITY_EPS = 1e-8;

function isPositive(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sideDir(side: EdgeSide): 1 | -1 {
    return side === 'buy' ? 1 : -1;
}

function bboForSide(side: EdgeSide, bidDecision: number | null | undefined, askDecision: number | null | undefined): number | null {
    if (side === 'buy') {
        return isPositive(askDecision) ? askDecision : null;
    }
    return isPositive(bidDecision) ? bidDecision : null;
}

export function computeSignalEdgeBpsExAnte(
    side: EdgeSide,
    strategyFair: number | null | undefined,
    midDecision: number | null | undefined
): number | null {
    if (!isPositive(strategyFair) || !isPositive(midDecision)) return null;
    return sideDir(side) * ((strategyFair - midDecision) / midDecision) * 10_000;
}

export function computeSignalEdgeBpsExPost(
    side: EdgeSide,
    midDecision: number | null | undefined,
    midDecisionH: number | null | undefined
): number | null {
    if (!isPositive(midDecision) || !isPositive(midDecisionH)) return null;
    return sideDir(side) * ((midDecisionH - midDecision) / midDecision) * 10_000;
}

export function computeExecutionEdgeBpsVsMid(
    side: EdgeSide,
    midDecision: number | null | undefined,
    fillPrice: number | null | undefined
): number | null {
    if (!isPositive(midDecision) || !isPositive(fillPrice)) return null;
    return sideDir(side) * ((midDecision - fillPrice) / midDecision) * 10_000;
}

export function computeExecutionEdgeBpsVsBbo(
    side: EdgeSide,
    midDecision: number | null | undefined,
    bidDecision: number | null | undefined,
    askDecision: number | null | undefined,
    fillPrice: number | null | undefined
): number | null {
    if (!isPositive(midDecision) || !isPositive(fillPrice)) return null;
    const bbo = bboForSide(side, bidDecision, askDecision);
    if (!isPositive(bbo)) return null;
    return sideDir(side) * ((bbo - fillPrice) / midDecision) * 10_000;
}

export function computeDriftBps(
    side: EdgeSide,
    midDecision: number | null | undefined,
    midFillH: number | null | undefined
): number | null {
    if (!isPositive(midDecision) || !isPositive(midFillH)) return null;
    return sideDir(side) * ((midFillH - midDecision) / midDecision) * 10_000;
}

export function computePnlExecQuote(
    side: EdgeSide,
    midDecision: number | null | undefined,
    fillPrice: number | null | undefined,
    baseFilled: number | null | undefined
): number | null {
    if (!isPositive(midDecision) || !isPositive(fillPrice) || !isPositive(baseFilled)) return null;
    return sideDir(side) * (midDecision - fillPrice) * baseFilled;
}

export function computePnlDriftQuote(
    side: EdgeSide,
    midDecision: number | null | undefined,
    midFillH: number | null | undefined,
    baseFilled: number | null | undefined
): number | null {
    if (!isPositive(midDecision) || !isPositive(midFillH) || !isPositive(baseFilled)) return null;
    return sideDir(side) * (midFillH - midDecision) * baseFilled;
}

function addNullable(a: number | null, b: number | null): number | null {
    if (a == null || b == null) return null;
    return a + b;
}

export function validatePnlIdentity(execPnl: number | null, driftPnl: number | null, totalPnl: number | null): boolean {
    if (execPnl == null || driftPnl == null || totalPnl == null) return true;
    return Math.abs((execPnl + driftPnl) - totalPnl) <= PNL_IDENTITY_EPS;
}

export function buildEdgeAttributionMetrics(input: EdgeAttributionMetricInput): EdgeAttributionMetrics {
    const signalEdgeBpsExAnte = computeSignalEdgeBpsExAnte(input.side, input.strategyFair ?? null, input.midDecision ?? null);
    const signalEdgeBpsExPost1m = computeSignalEdgeBpsExPost(input.side, input.midDecision ?? null, input.midDecision1m ?? null);
    const signalEdgeBpsExPost5m = computeSignalEdgeBpsExPost(input.side, input.midDecision ?? null, input.midDecision5m ?? null);

    const executionEdgeBpsVsMid = computeExecutionEdgeBpsVsMid(input.side, input.midDecision ?? null, input.fillPrice ?? null);
    const executionEdgeBpsVsBbo = computeExecutionEdgeBpsVsBbo(
        input.side,
        input.midDecision ?? null,
        input.bidDecision ?? null,
        input.askDecision ?? null,
        input.fillPrice ?? null
    );

    const driftBps1m = computeDriftBps(input.side, input.midDecision ?? null, input.midFill1m ?? null);
    const driftBps5m = computeDriftBps(input.side, input.midDecision ?? null, input.midFill5m ?? null);

    const pnlExecQuote = computePnlExecQuote(input.side, input.midDecision ?? null, input.fillPrice ?? null, input.baseFilled ?? null);
    const pnlDriftQuote1m = computePnlDriftQuote(input.side, input.midDecision ?? null, input.midFill1m ?? null, input.baseFilled ?? null);
    const pnlDriftQuote5m = computePnlDriftQuote(input.side, input.midDecision ?? null, input.midFill5m ?? null, input.baseFilled ?? null);

    const pnlTotalQuote1m = addNullable(pnlExecQuote, pnlDriftQuote1m);
    const pnlTotalQuote5m = addNullable(pnlExecQuote, pnlDriftQuote5m);

    return {
        signalEdgeBpsExAnte,
        signalEdgeBpsExPost1m,
        signalEdgeBpsExPost5m,
        executionEdgeBpsVsMid,
        executionEdgeBpsVsBbo,
        driftBps1m,
        driftBps5m,
        pnlExecQuote,
        pnlDriftQuote1m,
        pnlTotalQuote1m,
        pnlDriftQuote5m,
        pnlTotalQuote5m,
        hasDecisionSnapshot: isPositive(input.midDecision),
        hasHorizon1m: isPositive(input.midFill1m),
        hasHorizon5m: isPositive(input.midFill5m),
    };
}
