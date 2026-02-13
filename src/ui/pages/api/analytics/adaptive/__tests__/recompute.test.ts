import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockInvalidate,
    mockTriggerUpdate,
    mockIsSchedulerRunning,
    mockIsAdaptiveEnabled,
} = vi.hoisted(() => ({
    mockInvalidate: vi.fn(),
    mockTriggerUpdate: vi.fn(),
    mockIsSchedulerRunning: vi.fn(),
    mockIsAdaptiveEnabled: vi.fn(),
}));

vi.mock('../../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

vi.mock('../../../../../../analytics/adaptiveScheduler', () => ({
    triggerUpdate: mockTriggerUpdate,
    isSchedulerRunning: mockIsSchedulerRunning,
}));

vi.mock('../../../../../../analytics/adaptiveConfig', () => ({
    isAdaptiveEnabled: mockIsAdaptiveEnabled,
}));

vi.mock('../../_cache', () => ({
    invalidateAnalyticsCache: mockInvalidate,
}));

import handler from '../recompute';

function createMockReq() {
    return {
        method: 'POST',
        query: {},
        requestId: 'test-req-adaptive-recompute-001',
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

describe('POST /api/analytics/adaptive/recompute', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsAdaptiveEnabled.mockReturnValue(true);
        mockIsSchedulerRunning.mockReturnValue(true);
    });

    it('invalidates analytics cache before recompute checks', () => {
        const req = createMockReq();
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockInvalidate).toHaveBeenCalledWith('analytics:');
        expect(mockTriggerUpdate).toHaveBeenCalledTimes(1);
    });

    it('still invalidates cache when adaptive is disabled', () => {
        mockIsAdaptiveEnabled.mockReturnValue(false);

        const req = createMockReq();
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockInvalidate).toHaveBeenCalledWith('analytics:');
        expect(mockTriggerUpdate).toHaveBeenCalledTimes(0);
    });
});
