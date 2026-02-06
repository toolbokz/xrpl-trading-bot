export type QualityGateAction = 'ALLOW' | 'DEFER' | 'REPRICE' | 'SKIP';

export interface QualityGateInput {
    pairKey: string;
    side: 'buy' | 'sell';
    urgency: 'low' | 'normal' | 'high';
    spreadBps: number;
    expectedImpactBps: number;
    feedStalenessMs: number;
    volatilityBps: number;
    depthNotional: number;
    slippageBudgetBps: number;
    expectedEdgeBps: number;
    feesBps: number;
}

export interface QualityGateDecision {
    action: QualityGateAction;
    reason: string;
    targetPriceAdjustmentBps?: number;
    ttlMs?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const safe = (value: number): number => (Number.isFinite(value) ? value : 0);

const urgencyStalenessLimit = (urgency: QualityGateInput['urgency']): number => {
    if (urgency === 'high') return 4_000;
    if (urgency === 'normal') return 2_000;
    return 1_000;
};

const urgencyDepthFloor = (urgency: QualityGateInput['urgency']): number => {
    if (urgency === 'high') return 250;
    if (urgency === 'normal') return 500;
    return 1_000;
};

const urgencyVolatilityLimit = (urgency: QualityGateInput['urgency']): number => {
    if (urgency === 'high') return 120;
    if (urgency === 'normal') return 90;
    return 60;
};

const ttlFor = (urgency: QualityGateInput['urgency']): number => {
    if (urgency === 'high') return 250;
    if (urgency === 'normal') return 500;
    return 1_000;
};

export const shouldCrossSpread = (args: {
    expectedEdgeBps: number;
    feesBps: number;
    slippageBudgetBps: number;
}): boolean => {
    const threshold = safe(args.feesBps) + safe(args.slippageBudgetBps);
    return safe(args.expectedEdgeBps) > threshold;
};

export const evaluateQualityGate = (input: QualityGateInput): QualityGateDecision => {
    const spreadBps = Math.max(0, safe(input.spreadBps));
    const impactBps = Math.max(0, safe(input.expectedImpactBps));
    const feesBps = Math.max(0, safe(input.feesBps));
    const stalenessMs = Math.max(0, safe(input.feedStalenessMs));
    const volatilityBps = Math.max(0, safe(input.volatilityBps));
    const depthNotional = Math.max(0, safe(input.depthNotional));
    const budgetBps = Math.max(0, safe(input.slippageBudgetBps));
    const edgeBps = safe(input.expectedEdgeBps);

    const projectedCostBps = spreadBps + impactBps + feesBps;
    const availableEdgeBps = edgeBps - feesBps;

    if (depthNotional < urgencyDepthFloor(input.urgency)) {
        return {
            action: 'SKIP',
            reason: `insufficient-depth:${depthNotional.toFixed(2)}`,
        };
    }

    if (stalenessMs > urgencyStalenessLimit(input.urgency)) {
        return {
            action: 'DEFER',
            reason: `feed-stale:${Math.round(stalenessMs)}ms`,
            ttlMs: ttlFor(input.urgency),
        };
    }

    if (volatilityBps > urgencyVolatilityLimit(input.urgency) && input.urgency === 'low') {
        return {
            action: 'DEFER',
            reason: `volatility-elevated:${volatilityBps.toFixed(1)}bps`,
            ttlMs: ttlFor(input.urgency),
        };
    }

    if (projectedCostBps > budgetBps + feesBps) {
        return {
            action: 'SKIP',
            reason: `slippage-budget-breached:${projectedCostBps.toFixed(2)}>${(budgetBps + feesBps).toFixed(2)}`,
        };
    }

    if (availableEdgeBps <= 0 || edgeBps <= projectedCostBps) {
        return {
            action: 'SKIP',
            reason: `insufficient-edge:${edgeBps.toFixed(2)}<=${projectedCostBps.toFixed(2)}`,
        };
    }

    const quoteWidenBps = clamp((spreadBps * 0.25) + (volatilityBps * 0.15) + (stalenessMs / 400), 0.5, 25);
    if (spreadBps > 40 || volatilityBps > 80) {
        return {
            action: 'REPRICE',
            reason: 'spread-or-volatility-regime-shift',
            targetPriceAdjustmentBps: quoteWidenBps,
            ttlMs: ttlFor(input.urgency),
        };
    }

    return {
        action: 'ALLOW',
        reason: shouldCrossSpread({
            expectedEdgeBps: edgeBps,
            feesBps,
            slippageBudgetBps: budgetBps,
        }) ? 'allow-crossing-if-needed' : 'maker-first-only',
    };
};
