import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAnalyticsCache } from '../_cache';

const { mockGetEdgeAttributionAnalytics } = vi.hoisted(() => ({
    mockGetEdgeAttributionAnalytics: vi.fn(),
}));

vi.mock('../../../../../analytics/feedbackEngine', () => ({
    feedbackEngine: {
        getEdgeAttributionAnalytics: mockGetEdgeAttributionAnalytics,
    },
}));

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

import handler from '../edge-attribution';

function createMockReq(query: Record<string, string> = {}) {
    return {
        method: 'GET',
        query,
        requestId: 'test-req-edge-001',
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
        coverageDecision: 1,
        coverage1m: 1,
        coverage5m: 0.5,
        avgSignalEdgeBpsExAnte: 12,
        avgSignalEdgeBpsExPost1m: -8,
        avgSignalEdgeBpsExPost5m: -4,
        avgExecutionEdgeBpsVsMid: 6,
        avgExecutionEdgeBpsVsBbo: 3,
        avgDriftBps1m: -9,
        avgDriftBps5m: -5,
        avgPnlExecQuote: 0.002,
        avgPnlTotalQuote1m: -0.001,
        avgPnlTotalQuote5m: -0.0005,
    },
    series: [],
    histograms: {
        executionEdgeBps: [],
        driftBps: [],
    },
    breakdowns: {
        byPair: [],
        byStrategy: [],
        bySide: [],
        byRegime: [],
    },
    topTrades: {
        worstExecution: [],
        adverseSelection: [],
    },
};

describe('GET /api/analytics/edge-attribution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invalidateAnalyticsCache('analytics:');
        mockGetEdgeAttributionAnalytics.mockReturnValue(defaultAnalytics);
    });

    it('returns edge attribution analytics payload', () => {
        const req = createMockReq({ pairKey: 'XRP/RLUSD' });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.requestId).toBe('test-req-edge-001');
        expect(res.body.summary).toEqual(defaultAnalytics.summary);
        expect(res.body.histograms).toEqual(defaultAnalytics.histograms);
        expect(res.body.breakdowns).toEqual(defaultAnalytics.breakdowns);
        expect(res.body.topTrades).toEqual(defaultAnalytics.topTrades);
    });

    it('parses filters and forwards them to feedbackEngine', () => {
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
        expect(mockGetEdgeAttributionAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/524C555344000000000000000000000000000000',
            sinceMs: 1770000000000,
            strategy: 'scalper',
            side: 'sell',
            source: 'bot',
            bucketMs: 300000,
            paperMode: false,
        });
    });

    it('supports pair alias query parameter', () => {
        const req = createMockReq({
            pair: 'XRP/RLUSD',
            side: 'buy',
        });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetEdgeAttributionAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            paperMode: false,
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
        expect(mockGetEdgeAttributionAnalytics).toHaveBeenCalledTimes(1);
    });
});
