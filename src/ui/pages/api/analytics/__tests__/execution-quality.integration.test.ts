import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createMockReq(query: Record<string, string> = {}) {
    return {
        method: 'GET',
        query,
        requestId: 'test-req-eq-int-001',
    } as any;
}

function createMockRes() {
    const res: any = {
        statusCode: 0,
        body: null,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(data: any) {
            res.body = data;
            return res;
        },
    };
    return res;
}

describe('GET /api/analytics/execution-quality integration filtering', () => {
    beforeEach(async () => {
        vi.resetModules();
        process.env.FEEDBACK_DB_PATH = ':memory:';
        vi.doMock('../../../../lib/localApi', () => ({
            withLocalApi: (handler: Function) => handler,
        }));
        const { invalidateAnalyticsCache } = await import('../_cache');
        invalidateAnalyticsCache('analytics:');
    });

    afterEach(async () => {
        const engine = await import('../../../../../analytics/feedbackEngine');
        engine.feedbackEngine.shutdown();
        const db = await import('../../../../../analytics/feedbackDb');
        db.closeFeedbackDb();
        const { invalidateAnalyticsCache } = await import('../_cache');
        invalidateAnalyticsCache('analytics:');
    });

    it('filters to execution evidence by default and supports include/exclude strategy params', async () => {
        const { feedbackEngine } = await import('../../../../../analytics/feedbackEngine');
        const { default: handler } = await import('../execution-quality');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_API_INT_EXEC',
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
        });

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_API_INT_INGEST',
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

        const defaultReq = createMockReq({ pairKey: 'XRP/RLUSD' });
        const defaultRes = createMockRes();
        handler(defaultReq, defaultRes);

        expect(defaultRes.statusCode).toBe(200);
        expect(defaultRes.body.totalEventsRaw).toBe(3);
        expect(defaultRes.body.totalEventsAnalyzed).toBe(1);
        expect(defaultRes.body.excludedCounts).toEqual({
            noExecutionEvidence: 1,
            excludedByStrategy: 1,
            paperTrades: 0,
        });

        const includeEvidenceReq = createMockReq({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: 'true',
        });
        const includeEvidenceRes = createMockRes();
        handler(includeEvidenceReq, includeEvidenceRes);

        expect(includeEvidenceRes.statusCode).toBe(200);
        expect(includeEvidenceRes.body.totalEventsRaw).toBe(3);
        expect(includeEvidenceRes.body.totalEventsAnalyzed).toBe(2);
        expect(includeEvidenceRes.body.excludedCounts).toEqual({
            noExecutionEvidence: 0,
            excludedByStrategy: 1,
            paperTrades: 0,
        });

        const excludeStrategiesReq = createMockReq({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: 'true',
            excludeStrategies: 'scalper',
        });
        const excludeStrategiesRes = createMockRes();
        handler(excludeStrategiesReq, excludeStrategiesRes);

        expect(excludeStrategiesRes.statusCode).toBe(200);
        expect(excludeStrategiesRes.body.totalEventsAnalyzed).toBe(1);
        expect(excludeStrategiesRes.body.excludedCounts).toEqual({
            noExecutionEvidence: 0,
            excludedByStrategy: 2,
            paperTrades: 0,
        });

        const includeStrategiesReq = createMockReq({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: 'true',
            includeStrategies: 'scalper',
            excludeStrategies: 'scalper,account-ingestion',
        });
        const includeStrategiesRes = createMockRes();
        handler(includeStrategiesReq, includeStrategiesRes);

        expect(includeStrategiesRes.statusCode).toBe(200);
        expect(includeStrategiesRes.body.totalEventsAnalyzed).toBe(2);
        expect(includeStrategiesRes.body.excludedCounts).toEqual({
            noExecutionEvidence: 0,
            excludedByStrategy: 1,
            paperTrades: 0,
        });
    });
});
