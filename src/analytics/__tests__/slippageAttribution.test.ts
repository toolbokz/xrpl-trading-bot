/**
 * Tests for slippage attribution decomposition.
 */

import { describe, it, expect } from 'vitest';
import {
    attributeSlippage,
    summarizeAttribution,
    type SlippageAttribution,
} from '../../analytics/slippageAttribution';
import type { ExecutionFill } from '../../analytics/executionQuality';

function makeFill(overrides: Partial<ExecutionFill> = {}): ExecutionFill {
    const now = Date.now();
    return {
        correlationId: 'corr-1',
        pairKey: 'XRP/RLUSD',
        strategy: 'scalper',
        side: 'buy',
        decisionTimeMs: now - 200,
        submitTimeMs: now - 150,
        ledgerAcceptedTimeMs: now - 50,
        fillTimeMs: now,
        arrivalMid: 2.50,
        expectedPrice: 2.50,
        fillPrice: 2.51,
        postFillMid: 2.505,
        slippageBps: 40,
        spreadCostBps: 40,
        impactProxyBps: 20,
        fillRatio: 1,
        isMaker: false,
        wasReplaced: false,
        txHash: null,
        ledgerIndex: 1000,
        executionSource: 'orderbook',
        ...overrides,
    };
}

describe('attributeSlippage', () => {
    it('decomposes slippage into components', () => {
        const fill = makeFill();
        const attr = attributeSlippage(fill, 1.2);

        expect(attr.spreadCostBps).toBeGreaterThanOrEqual(0);
        expect(attr.impactBps).toBeGreaterThanOrEqual(0);
        expect(attr.feeCostBps).toBe(1.2);
        expect(attr.totalSlippageBps).toBeGreaterThan(0);
        expect(typeof attr.residualBps).toBe('number');
    });

    it('handles zero slippage (perfect fill)', () => {
        const fill = makeFill({
            arrivalMid: 2.50,
            fillPrice: 2.50,
            postFillMid: 2.50,
            expectedPrice: 2.50,
            slippageBps: 0,
            spreadCostBps: 0,
            impactProxyBps: 0,
        });
        const attr = attributeSlippage(fill, 0);

        expect(attr.spreadCostBps).toBe(0);
        expect(attr.impactBps).toBe(0);
        expect(attr.timingDelayBps).toBe(0);
        expect(attr.feeCostBps).toBe(0);
    });

    it('identifies timing cost for maker fills', () => {
        const fill = makeFill({
            isMaker: true,
            arrivalMid: 2.50,
            fillPrice: 2.48,
            postFillMid: 2.49,
        });
        const attr = attributeSlippage(fill, 0);
        expect(typeof attr.timingDelayBps).toBe('number');
    });
});

describe('summarizeAttribution', () => {
    it('summarizes multiple fills', () => {
        const fills = [
            makeFill({ fillPrice: 2.51, slippageBps: 40 }),
            makeFill({ fillPrice: 2.52, slippageBps: 80, correlationId: 'corr-2' }),
        ];
        const summary = summarizeAttribution(fills, 1.2);

        expect(summary.fillCount).toBe(2);
        expect(summary.meanSlippageBps).not.toBe(0);
        expect(summary.dominantComponent).toBeDefined();
        expect(['spread', 'impact', 'timing', 'fee', 'residual']).toContain(summary.dominantComponent);
    });

    it('handles empty fills', () => {
        const summary = summarizeAttribution([], 1.2);
        expect(summary.fillCount).toBe(0);
        expect(summary.meanSlippageBps).toBe(0);
    });
});
