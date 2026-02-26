import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAnalyticsCache } from '../_cache';

const { mockQuerySnapshots, mockComputeAdverseSelectionRate, mockQueryTradeEvents, mockComputeAdverseSelectionRateFromTrades } = vi.hoisted(() => ({
    mockQuerySnapshots: vi.fn(),
    mockComputeAdverseSelectionRate: vi.fn(),
    mockQueryTradeEvents: vi.fn(),
    mockComputeAdverseSelectionRateFromTrades: vi.fn(),
}));

vi.mock('../../../../../analytics/feedbackDb', () => ({
    querySnapshots: mockQuerySnapshots,
    queryTradeEvents: mockQueryTradeEvents,
}));

vi.mock('../../../../../analytics/feedbackEngine', () => ({
    computeAdverseSelectionRate: mockComputeAdverseSelectionRate,
    computeAdverseSelectionRateFromTrades: mockComputeAdverseSelectionRateFromTrades,
}));

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

import handler from '../adverse-selection-rate';

function createMockReq(query: Record<string, string> = {}) {
    return {
        method: 'GET',
        query,
        requestId: 'test-req-adr-001',
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

describe('GET /api/analytics/adverse-selection-rate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invalidateAnalyticsCache('analytics:');
        mockQuerySnapshots.mockReturnValue([{ id: '1' }]);
        mockComputeAdverseSelectionRate.mockReturnValue({
            sampleCount: 10,
            adverseCount: 3,
            adverseRate: 0.3,
        });
        mockQueryTradeEvents.mockReturnValue([]);
        mockComputeAdverseSelectionRateFromTrades.mockReturnValue({
            sampleCount: 0,
            adverseCount: 0,
            adverseRate: 0,
        });
    });

    it('returns adverse selection metrics', () => {
        const req = createMockReq({ pairKey: 'XRP/RLUSD' });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.adverseRate).toBe(0.3);
        expect(res.body.sampleCount).toBe(10);
        expect(res.body.adverseCount).toBe(3);
    });

    it('uses cache for identical filters', () => {
        const req1 = createMockReq({ pairKey: 'XRP/RLUSD', windowMs: '60000' });
        const req2 = createMockReq({ pairKey: 'XRP/RLUSD', windowMs: '60000' });
        const res1 = createMockRes();
        const res2 = createMockRes();

        handler(req1, res1);
        handler(req2, res2);

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);
        expect(mockQuerySnapshots).toHaveBeenCalledTimes(1);
        expect(mockComputeAdverseSelectionRate).toHaveBeenCalledTimes(1);
    });
});
