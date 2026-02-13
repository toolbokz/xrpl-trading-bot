import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAnalyticsCache } from '../../_cache';

const { mockGetRegimeHeatmap } = vi.hoisted(() => ({
    mockGetRegimeHeatmap: vi.fn(),
}));

vi.mock('../../../../../../analytics/feedbackEngine', () => ({
    feedbackEngine: {
        getRegimeHeatmap: mockGetRegimeHeatmap,
    },
}));

vi.mock('../../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

import handler from '../heatmap';

function createMockReq(query: Record<string, string> = {}) {
    return {
        method: 'GET',
        query,
        requestId: 'test-req-heatmap-001',
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

describe('GET /api/analytics/regimes/heatmap cache', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invalidateAnalyticsCache('analytics:');
        mockGetRegimeHeatmap.mockReturnValue({
            global: {},
            perStrategy: {},
            meta: {
                lookbackHours: 24,
                minTrades: 5,
                totalTrades: 0,
                computedAt: Date.now(),
            },
        });
    });

    it('reuses cached response for identical filters', () => {
        const req1 = createMockReq({ hours: '24', minTrades: '5', byStrategy: 'true' });
        const req2 = createMockReq({ hours: '24', minTrades: '5', byStrategy: 'true' });
        const res1 = createMockRes();
        const res2 = createMockRes();

        handler(req1, res1);
        handler(req2, res2);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
        expect(mockGetRegimeHeatmap).toHaveBeenCalledTimes(1);
    });
});
