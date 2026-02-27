import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAnalyticsCache } from '../_cache';

const { mockGetExecutionQualityAnalytics } = vi.hoisted(() => ({
    mockGetExecutionQualityAnalytics: vi.fn(),
}));

vi.mock('../../../../../analytics/feedbackEngine', () => ({
    feedbackEngine: {
        getExecutionQualityAnalytics: mockGetExecutionQualityAnalytics,
    },
}));

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

import handler from '../execution-quality';

function createMockReq(query: Record<string, string | string[]> = {}) {
    return {
        method: 'GET',
        query,
        requestId: 'test-req-eq-001',
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

const defaultAnalytics = {
    summary: {
        events: 2,
        fills: 1,
        rejects: 1,
        partials: 0,
        coverage1m: 1,
        coverage5m: 0,
        avgSlippageBpsVsIntent: 12,
        avgSlippageBpsVsMid: 8,
        avgSlippageBpsVsBbo: 6,
        avgEffSpreadBps: 10,
        avgRealizedSpreadBps1m: 4,
        avgRealizedSpreadBps5m: null,
        avgImpactBps1m: 6,
        avgImpactBps5m: null,
        avgFillRatio: 1,
        avgDecisionToSubmitMs: 30,
        avgSubmitToValidatedMs: 200,
        avgDecisionToValidatedMs: 230,
        repriceAppliedRate: 0,
    },
    series: [],
    histograms: {
        slippageBps: [],
        spreadBps: [],
        postTradeDriftBps: [],
    },
    breakdowns: {
        byPair: [],
        byStrategy: [],
        bySide: [],
        byRegime: [],
    },
    anomalies: {
        suspiciousSlippageSpikes: 0,
        partialFillAnomalies: 0,
        quoteBaseIntegrityViolations: 0,
    },
    slippageRealismDiagnostics: [],
    totalEventsRaw: 3,
    totalEventsAnalyzed: 2,
    excludedCounts: {
        noExecutionEvidence: 1,
        excludedByStrategy: 0,
        paperTrades: 0,
    },
};

describe('GET /api/analytics/execution-quality', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invalidateAnalyticsCache('analytics:');
        mockGetExecutionQualityAnalytics.mockReturnValue(defaultAnalytics);
    });

    it('returns execution quality analytics payload', () => {
        const req = createMockReq({ pairKey: 'XRP/RLUSD' });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.requestId).toBe('test-req-eq-001');
        expect(res.body.summary).toEqual(defaultAnalytics.summary);
        expect(res.body.histograms).toEqual(defaultAnalytics.histograms);
        expect(res.body.breakdowns).toEqual(defaultAnalytics.breakdowns);
        expect(res.body.anomalies).toEqual(defaultAnalytics.anomalies);
        expect(res.body.totalEventsRaw).toBe(3);
        expect(res.body.totalEventsAnalyzed).toBe(2);
        expect(res.body.excludedCounts).toEqual({
            noExecutionEvidence: 1,
            excludedByStrategy: 0,
            paperTrades: 0,
        });
    });

    it('parses filters and forwards them to feedbackEngine with safe defaults', () => {
        const req = createMockReq({
            pairKey: 'XRP/524C555344000000000000000000000000000000',
            sinceMs: '1770000000000',
            strategy: 'scalper',
            side: 'sell',
            source: 'bot',
            bucketMs: '300000',
        });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetExecutionQualityAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/524C555344000000000000000000000000000000',
            sinceMs: 1770000000000,
            strategy: 'scalper',
            side: 'sell',
            source: 'bot',
            bucketMs: 300000,
            includeNonExecutionEvidence: false,
            excludeStrategies: ['account-ingestion'],
        });
    });

    it('supports legacy pair/window query params', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-12T00:00:00.000Z'));
        const expectedSinceMs = Date.now() - 60000;
        const req = createMockReq({
            pair: 'XRP/RLUSD',
            window: '60000',
        });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetExecutionQualityAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/RLUSD',
            sinceMs: expectedSinceMs,
            includeNonExecutionEvidence: false,
            excludeStrategies: ['account-ingestion'],
        });
        vi.useRealTimers();
    });

    it('supports includeNonExecutionEvidence=true opt-in', () => {
        const req = createMockReq({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: 'true',
        });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetExecutionQualityAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: true,
            excludeStrategies: ['account-ingestion'],
        });
    });

    it('applies excludeStrategies when includeStrategies is not supplied', () => {
        const req = createMockReq({
            pairKey: 'XRP/RLUSD',
            excludeStrategies: 'account-ingestion,manual-import',
        });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetExecutionQualityAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: false,
            excludeStrategies: ['account-ingestion', 'manual-import'],
        });
    });

    it('gives includeStrategies precedence over excludeStrategies', () => {
        const req = createMockReq({
            pairKey: 'XRP/RLUSD',
            includeStrategies: 'scalper,amm-arb',
            excludeStrategies: 'account-ingestion,scalper',
        });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetExecutionQualityAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/RLUSD',
            includeNonExecutionEvidence: false,
            includeStrategies: ['amm-arb', 'scalper'],
            excludeStrategies: [],
        });
    });

    it('uses analytics cache for repeated identical filters', () => {
        const req1 = createMockReq({
            pairKey: 'XRP/RLUSD',
            sinceMs: '1770000000000',
            bucketMs: '60000',
        });
        const req2 = createMockReq({
            pairKey: 'XRP/RLUSD',
            sinceMs: '1770000000000',
            bucketMs: '60000',
        });
        const res1 = createMockRes();
        const res2 = createMockRes();

        handler(req1, res1);
        handler(req2, res2);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
        expect(mockGetExecutionQualityAnalytics).toHaveBeenCalledTimes(1);
    });
});
