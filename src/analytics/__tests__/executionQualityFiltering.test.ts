import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('execution quality analytics filtering', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.FEEDBACK_DB_PATH = ':memory:';
    });

    afterEach(async () => {
        const engine = await import('../feedbackEngine');
        engine.feedbackEngine.shutdown();
        const db = await import('../feedbackDb');
        db.closeFeedbackDb();
    });

    it('excludes account-ingestion and no-evidence events by default', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_FILTER_EXEC',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.34,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.34,
            decisionTs: 1_000,
            submitTs: 1_010,
            submitResultEngine: 'tesSUCCESS',
            validatedTs: 1_100,
        });

        feedbackEngine.recordExecutionQualityEvent({
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.341,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.341,
            decisionTs: 2_000,
            validatedTs: 2_100,
        });

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_FILTER_INGESTION',
            pairKey: 'XRP/RLUSD',
            side: 'sell',
            strategy: 'account-ingestion',
            source: 'unknown',
            status: 'FILLED',
            fillPrice: 1.342,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.342,
            decisionTs: 3_000,
            submitTs: 3_010,
            submitResultEngine: 'tesSUCCESS',
            validatedTs: 3_100,
        });

        const analytics = feedbackEngine.getExecutionQualityAnalytics({ pairKey: 'XRP/RLUSD' });

        expect(analytics.totalEventsRaw).toBe(3);
        expect(analytics.totalEventsAnalyzed).toBe(1);
        expect(analytics.excludedCounts).toEqual({
            noExecutionEvidence: 1,
            excludedByStrategy: 1,
            paperTrades: 0,
        });
        expect(analytics.summary.events).toBe(1);
        expect(analytics.excludedCounts.noExecutionEvidence
            + analytics.excludedCounts.excludedByStrategy
            + analytics.excludedCounts.paperTrades).toBe(
                analytics.totalEventsRaw - analytics.totalEventsAnalyzed,
            );
    });

    it('includeNonExecutionEvidence=true restores no-evidence event inclusion', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_INCLUDE_EXEC',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.34,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.34,
            submitTs: 1_010,
            submitResultEngine: 'tesSUCCESS',
        });

        feedbackEngine.recordExecutionQualityEvent({
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.341,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.341,
        });

        const defaultAnalytics = feedbackEngine.getExecutionQualityAnalytics({ pairKey: 'XRP/RLUSD' });
        const expandedAnalytics = feedbackEngine.getExecutionQualityAnalytics({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: true,
        });

        expect(defaultAnalytics.totalEventsAnalyzed).toBe(1);
        expect(defaultAnalytics.excludedCounts.noExecutionEvidence).toBe(1);
        expect(expandedAnalytics.totalEventsAnalyzed).toBe(2);
        expect(expandedAnalytics.excludedCounts.noExecutionEvidence).toBe(0);
    });

    it('applies include/exclude strategy filters with include precedence', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_STRAT_SCALEPER_EXEC',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.34,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.34,
            submitTs: 1_010,
            submitResultEngine: 'tesSUCCESS',
        });

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_STRAT_INGESTION_EXEC',
            pairKey: 'XRP/RLUSD',
            side: 'sell',
            strategy: 'account-ingestion',
            source: 'unknown',
            status: 'FILLED',
            fillPrice: 1.342,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.342,
            submitTs: 3_010,
            submitResultEngine: 'tesSUCCESS',
        });

        feedbackEngine.recordExecutionQualityEvent({
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.341,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.341,
        });

        const excludedScalper = feedbackEngine.getExecutionQualityAnalytics({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: true,
            excludeStrategies: ['scalper'],
        });

        expect(excludedScalper.totalEventsAnalyzed).toBe(1);
        expect(excludedScalper.excludedCounts.excludedByStrategy).toBe(2);

        const includeWins = feedbackEngine.getExecutionQualityAnalytics({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: true,
            includeStrategies: ['scalper'],
            excludeStrategies: ['scalper', 'account-ingestion'],
        });

        expect(includeWins.totalEventsAnalyzed).toBe(2);
        expect(includeWins.excludedCounts.excludedByStrategy).toBe(1);
    });

    it('computes repriceAppliedRate in summary and bySide breakdowns', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_REPRICE_TRUE',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.34,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.34,
            submitTs: 1_000,
            submitResultEngine: 'tesSUCCESS',
            repriceApplied: true,
        });

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_REPRICE_FALSE',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            status: 'FILLED',
            fillPrice: 1.341,
            amountBase: 1,
            filledBase: 1,
            filledQuote: 1.341,
            submitTs: 2_000,
            submitResultEngine: 'tesSUCCESS',
            repriceApplied: false,
        });

        const analytics = feedbackEngine.getExecutionQualityAnalytics({ pairKey: 'XRP/RLUSD' });
        expect(analytics.summary.repriceAppliedRate).toBeCloseTo(0.5, 8);
        const buyBreakdown = analytics.breakdowns.bySide.find((row) => row.key === 'buy');
        expect(buyBreakdown?.repriceAppliedRate).toBeCloseTo(0.5, 8);
    });
});
