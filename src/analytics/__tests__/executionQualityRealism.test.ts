import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('execution quality slippage realism', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.FEEDBACK_DB_PATH = ':memory:';
        process.env.SLIPPAGE_REALISM_FILL_FRESHNESS_MS = '500';
        process.env.SLIPPAGE_REALISM_FILL_FRESHNESS_MS_XRPL = '12000';
    });

    afterEach(async () => {
        const engine = await import('../feedbackEngine');
        engine.feedbackEngine.shutdown();
        const db = await import('../feedbackDb');
        db.closeFeedbackDb();
    });

    it('uses corrected expected baseline for negative slippage rate instead of legacy slippage column', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'REALISM_TX_1',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            source: 'bot',
            venue: 'XRPL',
            status: 'FILLED',
            expectedPrice: 1.406,
            expectedPriceSource: 'bbo',
            baselineTs: 1_000_000,
            fillTs: 1_007_000,
            slippageBaselineUsed: 'best_ask',
            priceConvention: 'quote_per_base',
            fillPrice: 1.407, // adverse for BUY
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.407,
            // Intentionally wrong legacy value; analytics should ignore for realism rate.
            slippageBpsVsIntent: -99,
            decisionTs: 1_000_000,
            submitTs: 1_000_050,
            validatedTs: 1_007_000,
        });

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'REALISM_TX_2',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            source: 'bot',
            venue: 'XRPL',
            status: 'FILLED',
            expectedPrice: 1.406,
            expectedPriceSource: 'bbo',
            baselineTs: 1_000_000,
            fillTs: 1_006_000,
            slippageBaselineUsed: 'best_ask',
            priceConvention: 'quote_per_base',
            fillPrice: 1.405, // improved for BUY
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.405,
            slippageBpsVsIntent: -99,
            decisionTs: 1_000_000,
            submitTs: 1_000_050,
            validatedTs: 1_006_000,
        });

        const analytics = feedbackEngine.getExecutionQualityAnalytics({ pairKey: 'XRP/RLUSD' });
        expect(analytics.summary.fills).toBe(2);
        expect(analytics.summary.negSlippageSampleCount).toBe(2);
        expect(analytics.summary.negSlippageRate).toBeCloseTo(0.5, 8);
    });

    it('does not mark XRPL 6-8s validated fills as stale under XRPL threshold', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'XRPL_STALE_OK',
            pairKey: 'XRP/RLUSD',
            side: 'sell',
            source: 'bot',
            venue: 'XRPL',
            status: 'FILLED',
            expectedPrice: 1.404,
            expectedPriceSource: 'bbo',
            baselineTs: 2_000_000,
            fillTs: 2_007_500, // 7.5s
            slippageBaselineUsed: 'best_bid',
            priceConvention: 'quote_per_base',
            fillPrice: 1.403,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.403,
            decisionTs: 2_000_000,
            submitTs: 2_000_120,
            validatedTs: 2_007_500,
        });

        const analytics = feedbackEngine.getExecutionQualityAnalytics({ pairKey: 'XRP/RLUSD' });
        expect(analytics.summary.staleFillSnapshotSampleCount).toBe(1);
        expect(analytics.summary.staleFillSnapshotRate).toBe(0);
    });

    it('marks truly delayed XRPL snapshots stale and emits realism diagnostics', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'XRPL_STALE_BAD',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            source: 'bot',
            venue: 'XRPL',
            status: 'FILLED',
            expectedPrice: 1.406,
            expectedPriceSource: 'bbo',
            baselineTs: 3_000_000,
            fillTs: 3_013_500, // 13.5s > 12s threshold
            slippageBaselineUsed: 'best_ask',
            priceConvention: 'quote_per_base',
            fillPrice: 1.4065,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.4065,
            decisionTs: 3_000_000,
            submitTs: 3_000_100,
            validatedTs: 3_013_500,
        });

        const analytics = feedbackEngine.getExecutionQualityAnalytics({ pairKey: 'XRP/RLUSD' });
        expect(analytics.summary.staleFillSnapshotSampleCount).toBe(1);
        expect(analytics.summary.staleFillSnapshotRate).toBe(1);

        const diag = analytics.slippageRealismDiagnostics.find((d) => d.txHash === 'XRPL_STALE_BAD');
        expect(diag).toBeTruthy();
        expect(diag?.reason).toBe('stale_snapshot');
        expect(diag?.slippage_baseline_used).toBe('best_ask');
        expect(diag?.baseline_ts_ms).toBe(3_000_000);
        expect(diag?.fill_ts_ms).toBe(3_013_500);
        expect(diag?.delta_ms).toBe(13_500);
        expect(diag?.convention).toBe('quote_per_base');
    });

    it('treats missing baseline as NO_DATA for slippage realism rates', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'REALISM_NO_BASELINE',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            source: 'bot',
            venue: 'XRPL',
            status: 'FILLED',
            expectedPrice: null,
            expectedPriceSource: 'fallback_intent',
            fillPrice: 1.407,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.407,
            slippageBpsVsIntent: -120,
            decisionTs: 4_000_000,
            submitTs: 4_000_100,
            validatedTs: 4_008_000,
        });

        const analytics = feedbackEngine.getExecutionQualityAnalytics({ pairKey: 'XRP/RLUSD' });
        expect(analytics.summary.fills).toBe(1);
        expect(analytics.summary.negSlippageSampleCount).toBe(0);
        expect(analytics.summary.negSlippageNoDataCount).toBe(1);
        expect(analytics.summary.negSlippageRate).toBe(0);
        expect(analytics.summary.staleFillSnapshotSampleCount).toBe(0);
        expect(analytics.summary.staleFillSnapshotNoDataCount).toBe(1);
        expect(analytics.summary.staleFillSnapshotRate).toBe(0);

        const diag = analytics.slippageRealismDiagnostics.find((d) => d.txHash === 'REALISM_NO_BASELINE');
        expect(diag?.reason).toBe('missing_baseline');
    });
});
