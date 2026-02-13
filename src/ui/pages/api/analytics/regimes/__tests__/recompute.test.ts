import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvalidate, mockGetRuntime, mockGetEngine } = vi.hoisted(() => ({
    mockInvalidate: vi.fn(),
    mockGetRuntime: vi.fn(),
    mockGetEngine: vi.fn(),
}));

vi.mock('../../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

vi.mock('../../../../../lib/runtimeHooks', () => ({
    getRuntime: mockGetRuntime,
}));

vi.mock('../../../../../../analytics/regimePolicy', () => ({
    getRegimePolicyEngine: mockGetEngine,
}));

vi.mock('../../_cache', () => ({
    invalidateAnalyticsCache: mockInvalidate,
}));

import handler from '../recompute';

function createMockReq() {
    return {
        method: 'POST',
        query: {},
        requestId: 'test-req-regime-recompute-001',
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

describe('POST /api/analytics/regimes/recompute', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('invalidates analytics cache on recompute', () => {
        mockGetRuntime.mockReturnValue({
            recomputeRegimePolicy: () => ({ stats: { totalTrades: 1 } }),
        });

        const req = createMockReq();
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockInvalidate).toHaveBeenCalledWith('analytics:');
    });

    it('falls back to singleton engine when runtime is unavailable', () => {
        mockGetRuntime.mockReturnValue(null);
        mockGetEngine.mockReturnValue({
            recompute: () => ({ stats: { totalTrades: 2 } }),
        });

        const req = createMockReq();
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockInvalidate).toHaveBeenCalledWith('analytics:');
    });
});
