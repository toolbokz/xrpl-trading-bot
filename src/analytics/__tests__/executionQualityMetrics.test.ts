import { describe, expect, it } from 'vitest';
import {
    buildExecutionQualityMetrics,
    computeImplementationShortfallQuote,
    computeImpactBps,
    computeRealizedSpreadBps,
    computeEffectiveSpreadBps,
    computeLatencyMetrics,
} from '../executionQualityMetrics';

describe('executionQualityMetrics', () => {
    it('computes BUY metrics with canonical cost signs', () => {
        const metrics = buildExecutionQualityMetrics({
            side: 'buy',
            intentPrice: 1.35,
            midAtDecision: 1.35,
            bboAtDecision: 1.351,
            decisionPrice: 1.35,
            fillPrice: 1.352,
            amountBase: 1,
            filledBase: 1,
            midAfter1m: 1.353,
            midAfter5m: 1.349,
        });

        expect(metrics.slippageBpsVsIntent).toBeGreaterThan(0);
        expect(metrics.effSpreadBps).toBeGreaterThan(0);
        expect(metrics.impactBps1m).toBeGreaterThan(0);
        expect(metrics.implShortfallQuote).toBeGreaterThan(0);
        expect(metrics.fillRatio).toBe(1);
    });

    it('computes SELL metrics with canonical cost signs', () => {
        const metrics = buildExecutionQualityMetrics({
            side: 'sell',
            intentPrice: 1.35,
            midAtDecision: 1.35,
            bboAtDecision: 1.349,
            decisionPrice: 1.35,
            fillPrice: 1.348,
            amountBase: 2,
            filledBase: 2,
            midAfter1m: 1.352,
            midAfter5m: 1.347,
        });

        expect(metrics.slippageBpsVsIntent).toBeGreaterThan(0);
        expect(metrics.effSpreadBps).toBeGreaterThan(0);
        expect(metrics.impactBps1m).toBeLessThan(0);
        expect(metrics.implShortfallQuote).toBeGreaterThan(0);
        expect(metrics.fillRatio).toBe(1);
    });

    it('computes spread decomposition pieces deterministically', () => {
        const eff = computeEffectiveSpreadBps('buy', 1.352, 1.35);
        const realized = computeRealizedSpreadBps('buy', 1.352, 1.35, 1.353);
        const impact = computeImpactBps('buy', 1.35, 1.353);

        expect(eff).not.toBeNull();
        expect(realized).not.toBeNull();
        expect(impact).not.toBeNull();

        // Effective spread roughly decomposes to realized + impact.
        expect(Math.abs((eff ?? 0) - ((realized ?? 0) + (impact ?? 0)))).toBeLessThan(1e-6);
    });

    it('computes implementation shortfall with side-aware signs', () => {
        const buyCost = computeImplementationShortfallQuote('buy', 1.35, 1.36, 1);
        const sellCost = computeImplementationShortfallQuote('sell', 1.35, 1.34, 1);
        const buyImprovement = computeImplementationShortfallQuote('buy', 1.35, 1.34, 1);
        const sellImprovement = computeImplementationShortfallQuote('sell', 1.35, 1.36, 1);

        expect(buyCost).toBeGreaterThan(0);
        expect(sellCost).toBeGreaterThan(0);
        expect(buyImprovement).toBeLessThan(0);
        expect(sellImprovement).toBeLessThan(0);
    });

    it('computes latency spans from lifecycle timestamps', () => {
        const latency = computeLatencyMetrics({
            decisionTs: 1000,
            submitTs: 1050,
            validatedTs: 1250,
        });

        expect(latency.decisionToSubmitMs).toBe(50);
        expect(latency.submitToValidatedMs).toBe(200);
        expect(latency.decisionToValidatedMs).toBe(250);
    });

    it('uses fillTs for decision-to-fill while keeping submit-to-validate from validatedTs', () => {
        const latency = computeLatencyMetrics({
            decisionTs: 1000,
            submitTs: 1100,
            validatedTs: 5000,
            fillTs: 1600,
        });

        expect(latency.decisionToSubmitMs).toBe(100);
        expect(latency.submitToValidatedMs).toBe(3900);
        expect(latency.decisionToValidatedMs).toBe(600);
    });
});
