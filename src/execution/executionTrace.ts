export interface ExecutionTrace {
    correlationId: string;
    pairKey: string;
    strategy: string;
    decisionTimeMs: number;
    buildTimeMs?: number;
    submitTimeMs?: number;
    ledgerAcceptedTimeMs?: number;
    fillTimeMs?: number;
    expectedPrice: number;
    arrivalMid: number;
    postFillMid?: number;
    fillPrice?: number;
    slippageBps?: number;
    spreadCostBps?: number;
    impactProxyBps?: number;
}

export type ExecutionStage = 'build' | 'submit' | 'ledgerAccepted' | 'fill';

const floorMs = (value: number): number => Math.max(0, Math.floor(value));

const clampNumber = (value: number): number => {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return value;
};

const hashString = (value: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

export const makeCorrelationId = (seed: { pairKey: string; strategy: string; ts: number; nonce: number }): string => {
    const normalizedTs = floorMs(seed.ts);
    const normalizedNonce = floorMs(seed.nonce);
    const base = `${seed.pairKey}|${seed.strategy}|${normalizedTs}|${normalizedNonce}`;
    const digest = hashString(base);
    return `${normalizedTs}-${normalizedNonce}-${digest}`;
};

export const startExecutionTrace = (ctx: {
    correlationId: string;
    pairKey: string;
    strategy: string;
    arrivalMid: number;
    expectedPrice: number;
    decisionTimeMs: number;
}): ExecutionTrace => ({
    correlationId: ctx.correlationId,
    pairKey: ctx.pairKey,
    strategy: ctx.strategy,
    decisionTimeMs: floorMs(ctx.decisionTimeMs),
    arrivalMid: clampNumber(ctx.arrivalMid),
    expectedPrice: clampNumber(ctx.expectedPrice),
});

export const markTraceStage = (
    trace: ExecutionTrace,
    stage: ExecutionStage,
    ts: number,
): ExecutionTrace => {
    const normalizedTs = floorMs(ts);

    switch (stage) {
        case 'build':
            return { ...trace, buildTimeMs: normalizedTs };
        case 'submit':
            return { ...trace, submitTimeMs: normalizedTs };
        case 'ledgerAccepted':
            return { ...trace, ledgerAcceptedTimeMs: normalizedTs };
        case 'fill':
            return { ...trace, fillTimeMs: normalizedTs };
        default:
            return trace;
    }
};

const toBps = (numerator: number, denominator: number): number => {
    if (!Number.isFinite(denominator) || denominator <= 0) {
        return 0;
    }
    return Math.round(((numerator / denominator) * 10_000) * 100) / 100;
};

export const finalizeSlippage = (
    trace: ExecutionTrace,
    fillPrice: number,
    postFillMid: number,
): ExecutionTrace => {
    const safeFill = clampNumber(fillPrice);
    const safePostMid = clampNumber(postFillMid);
    const expected = clampNumber(trace.expectedPrice);
    const arrivalMid = clampNumber(trace.arrivalMid);

    const slippageBps = toBps(safeFill - expected, expected);
    const spreadCostBps = toBps(safeFill - arrivalMid, arrivalMid);
    const impactProxyBps = toBps(safePostMid - arrivalMid, arrivalMid);

    return {
        ...trace,
        fillPrice: safeFill,
        postFillMid: safePostMid,
        slippageBps,
        spreadCostBps,
        impactProxyBps,
    };
};
