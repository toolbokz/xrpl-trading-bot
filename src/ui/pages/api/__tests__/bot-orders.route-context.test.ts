import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockMarkApiRouteContext,
    mockClearApiRouteContext,
    mockValidateBody,
    mockLogSensitiveAction,
} = vi.hoisted(() => ({
    mockMarkApiRouteContext: vi.fn(),
    mockClearApiRouteContext: vi.fn(),
    mockValidateBody: vi.fn(),
    mockLogSensitiveAction: vi.fn(),
}));

vi.mock('../../../../xrpl/guard', () => ({
    markApiRouteContext: mockMarkApiRouteContext,
    clearApiRouteContext: mockClearApiRouteContext,
    runWithRequestContext: async (callback: () => Promise<unknown> | unknown) => await callback(),
}));

vi.mock('../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
    logSensitiveAction: mockLogSensitiveAction,
}));

vi.mock('../../../../config', () => ({
    loadConfig: () => ({
        xrpl: {
            endpoint: 'wss://unit-test',
        },
    }),
}));

vi.mock('../../../lib/xrplClient', () => ({
    getSharedClient: vi.fn(),
}));

vi.mock('../../../lib/runtimeHooks', () => ({
    ensureRuntimeHooks: vi.fn(),
}));

vi.mock('../../../lib/validation/schemas', () => ({
    validateBody: mockValidateBody,
    ordersUpdateSchema: {},
    ordersCancelSchema: {},
}));

vi.mock('../../../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

import handler from '../bot/orders';

function createReq() {
    return {
        method: 'POST',
        parsedBody: {
            autoManageEnabled: true,
            stalenessThresholdSec: 45,
        },
        requestId: 'test-orders-route-context',
    } as any;
}

function createRes(options: { throwOnStatus?: boolean } = {}) {
    const res: any = {
        statusCode: 0,
        body: null,
        status(code: number) {
            if (options.throwOnStatus) {
                throw new Error('status failed');
            }
            res.statusCode = code;
            return res;
        },
        json(payload: unknown) {
            res.body = payload;
            return res;
        },
    };
    return res;
}

describe('Pages API route context wrapper: /api/bot/orders', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLogSensitiveAction.mockResolvedValue(undefined);
    });

    it('marks and clears API route context for a normal request', async () => {
        mockValidateBody.mockReturnValue({
            success: true,
            data: {
                autoManageEnabled: true,
                stalenessThresholdSec: 45,
            },
        });

        const req = createReq();
        const res = createRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockMarkApiRouteContext).toHaveBeenCalledTimes(1);
        expect(mockClearApiRouteContext).toHaveBeenCalledTimes(1);
    });

    it('clears API route context even when the handler throws', async () => {
        mockValidateBody.mockReturnValue({
            success: false,
            errors: ['invalid-body'],
        });

        const req = createReq();
        const res = createRes({ throwOnStatus: true });

        await expect(handler(req, res)).rejects.toThrow('status failed');
        expect(mockMarkApiRouteContext).toHaveBeenCalledTimes(1);
        expect(mockClearApiRouteContext).toHaveBeenCalledTimes(1);
    });
});
