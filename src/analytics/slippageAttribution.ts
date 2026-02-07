/**
 * Slippage Attribution — Decompose execution costs into components
 *
 * Breaks down total slippage into:
 *   - Spread cost: mid-to-fill price difference
 *   - Market impact: post-fill mid shift
 *   - Timing delay: cost of latency (decision-to-fill price drift)
 *   - Fee cost: on-ledger transaction fees
 *
 * Used by analytics to identify which cost component is largest and
 * feed back into strategy tuning.
 *
 * @module analytics/slippageAttribution
 */

import { ExecutionFill } from './executionQuality';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SlippageAttribution {
    /** Total slippage from expected to fill price (bps). */
    totalSlippageBps: number;
    /** Spread cost: fill price vs arrival mid (bps). */
    spreadCostBps: number;
    /** Market impact: post-fill mid vs arrival mid (bps). */
    impactBps: number;
    /** Timing delay cost: expected price drift during latency (bps). */
    timingDelayBps: number;
    /** Transaction fee component (bps, estimated). */
    feeCostBps: number;
    /** Residual (unexplained cost). */
    residualBps: number;
    /** Total latency decision→fill (ms). */
    totalLatencyMs: number;
    /** Whether the fill was favorable (negative slippage). */
    favorable: boolean;
}

export interface AttributionSummary {
    /** Number of fills analyzed. */
    fillCount: number;
    /** Mean total slippage (bps). */
    meanSlippageBps: number;
    /** Mean spread cost (bps). */
    meanSpreadCostBps: number;
    /** Mean impact (bps). */
    meanImpactBps: number;
    /** Mean timing delay (bps). */
    meanTimingDelayBps: number;
    /** Mean fee cost (bps). */
    meanFeeCostBps: number;
    /** Mean residual (bps). */
    meanResidualBps: number;
    /** % of fills that were favorable. */
    favorableRatio: number;
    /** Dominant cost component. */
    dominantComponent: 'spread' | 'impact' | 'timing' | 'fee' | 'residual';
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

const safeBps = (a: number, b: number): number => {
    if (!Number.isFinite(b) || b <= 0) return 0;
    const raw = ((a - b) / b) * 10_000;
    return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
};

/**
 * Compute slippage attribution for a single fill.
 */
export function attributeSlippage(
    fill: ExecutionFill,
    estimatedFeeBps: number = 0,
): SlippageAttribution {
    const totalSlippage = fill.slippageBps;
    const spreadCost = fill.spreadCostBps;
    const impact = fill.impactProxyBps;

    // Timing delay: how much price moved between decision and submit
    // approximated as (expected price at submit time - expected price at decision)
    const timingDelay = fill.submitTimeMs > fill.decisionTimeMs
        ? safeBps(fill.fillPrice, fill.expectedPrice) - spreadCost
        : 0;

    const feeCost = Math.max(0, estimatedFeeBps);
    const residual = totalSlippage - (spreadCost + Math.max(0, timingDelay) + feeCost);

    const totalLatency = fill.fillTimeMs - fill.decisionTimeMs;

    return {
        totalSlippageBps: totalSlippage,
        spreadCostBps: spreadCost,
        impactBps: impact,
        timingDelayBps: Math.max(0, timingDelay),
        feeCostBps: feeCost,
        residualBps: Math.round(residual * 100) / 100,
        totalLatencyMs: Math.max(0, totalLatency),
        favorable: totalSlippage < 0,
    };
}

/**
 * Compute attribution summary over a set of fills.
 */
export function summarizeAttribution(
    fills: ExecutionFill[],
    estimatedFeeBps: number = 0,
): AttributionSummary {
    if (fills.length === 0) {
        return {
            fillCount: 0,
            meanSlippageBps: 0,
            meanSpreadCostBps: 0,
            meanImpactBps: 0,
            meanTimingDelayBps: 0,
            meanFeeCostBps: 0,
            meanResidualBps: 0,
            favorableRatio: 0,
            dominantComponent: 'spread',
        };
    }

    const attributions = fills.map(f => attributeSlippage(f, estimatedFeeBps));
    const n = attributions.length;

    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

    const meanSlippage = sum(attributions.map(a => a.totalSlippageBps)) / n;
    const meanSpread = sum(attributions.map(a => a.spreadCostBps)) / n;
    const meanImpact = sum(attributions.map(a => a.impactBps)) / n;
    const meanTiming = sum(attributions.map(a => a.timingDelayBps)) / n;
    const meanFee = sum(attributions.map(a => a.feeCostBps)) / n;
    const meanResidual = sum(attributions.map(a => a.residualBps)) / n;
    const favorableCount = attributions.filter(a => a.favorable).length;

    // Determine dominant component by absolute mean
    const components: Array<{ name: AttributionSummary['dominantComponent']; value: number }> = [
        { name: 'spread', value: Math.abs(meanSpread) },
        { name: 'impact', value: Math.abs(meanImpact) },
        { name: 'timing', value: Math.abs(meanTiming) },
        { name: 'fee', value: Math.abs(meanFee) },
        { name: 'residual', value: Math.abs(meanResidual) },
    ];
    components.sort((a, b) => b.value - a.value);

    return {
        fillCount: n,
        meanSlippageBps: Math.round(meanSlippage * 100) / 100,
        meanSpreadCostBps: Math.round(meanSpread * 100) / 100,
        meanImpactBps: Math.round(meanImpact * 100) / 100,
        meanTimingDelayBps: Math.round(meanTiming * 100) / 100,
        meanFeeCostBps: Math.round(meanFee * 100) / 100,
        meanResidualBps: Math.round(meanResidual * 100) / 100,
        favorableRatio: Math.round((favorableCount / n) * 100) / 100,
        dominantComponent: components[0]!.name,
    };
}
