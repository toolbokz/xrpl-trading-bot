import { describe, expect, it } from 'vitest';
import {
    buildEdgeAttributionMetrics,
    computeExecutionEdgeBpsVsMid,
    computeSignalEdgeBpsExPost,
    validatePnlIdentity,
} from '../edgeAttributionMetrics';

describe('edge attribution metrics', () => {
    it('computes BUY and SELL execution edge signs correctly', () => {
        const buyBetter = computeExecutionEdgeBpsVsMid('buy', 1.35, 1.34);
        const buyWorse = computeExecutionEdgeBpsVsMid('buy', 1.35, 1.36);
        const sellBetter = computeExecutionEdgeBpsVsMid('sell', 1.35, 1.36);
        const sellWorse = computeExecutionEdgeBpsVsMid('sell', 1.35, 1.34);

        expect(buyBetter).toBeGreaterThan(0);
        expect(buyWorse).toBeLessThan(0);
        expect(sellBetter).toBeGreaterThan(0);
        expect(sellWorse).toBeLessThan(0);
    });

    it('computes ex-post signal edge with side-correct sign', () => {
        const buyUpMove = computeSignalEdgeBpsExPost('buy', 1.35, 1.36);
        const buyDownMove = computeSignalEdgeBpsExPost('buy', 1.35, 1.34);
        const sellDownMove = computeSignalEdgeBpsExPost('sell', 1.35, 1.34);
        const sellUpMove = computeSignalEdgeBpsExPost('sell', 1.35, 1.36);

        expect(buyUpMove).toBeGreaterThan(0);
        expect(buyDownMove).toBeLessThan(0);
        expect(sellDownMove).toBeGreaterThan(0);
        expect(sellUpMove).toBeLessThan(0);
    });

    it('satisfies pnl identity: total = exec + drift', () => {
        const metrics = buildEdgeAttributionMetrics({
            side: 'buy',
            midDecision: 1.35,
            fillPrice: 1.352,
            baseFilled: 1,
            midFill1m: 1.354,
            midFill5m: 1.356,
        });

        expect(validatePnlIdentity(
            metrics.pnlExecQuote,
            metrics.pnlDriftQuote1m,
            metrics.pnlTotalQuote1m,
        )).toBe(true);
        expect(validatePnlIdentity(
            metrics.pnlExecQuote,
            metrics.pnlDriftQuote5m,
            metrics.pnlTotalQuote5m,
        )).toBe(true);
    });

    it('handles missing horizon snapshots with coverage flags and null metrics', () => {
        const metrics = buildEdgeAttributionMetrics({
            side: 'sell',
            midDecision: 1.35,
            fillPrice: 1.34,
            baseFilled: 0.5,
            midFill1m: null,
            midFill5m: null,
        });

        expect(metrics.hasDecisionSnapshot).toBe(true);
        expect(metrics.hasHorizon1m).toBe(false);
        expect(metrics.hasHorizon5m).toBe(false);
        expect(metrics.driftBps1m).toBeNull();
        expect(metrics.driftBps5m).toBeNull();
        expect(metrics.pnlDriftQuote1m).toBeNull();
        expect(metrics.pnlTotalQuote1m).toBeNull();
    });
});
