import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockMarkApiRouteContext,
    mockClearApiRouteContext,
    mockIsValidPairKey,
    mockGetCachedPrice,
} = vi.hoisted(() => ({
    mockMarkApiRouteContext: vi.fn(),
    mockClearApiRouteContext: vi.fn(),
    mockIsValidPairKey: vi.fn(),
    mockGetCachedPrice: vi.fn(),
}));

vi.mock('../../../../xrpl/guard', () => ({
    markApiRouteContext: mockMarkApiRouteContext,
    clearApiRouteContext: mockClearApiRouteContext,
    runWithRequestContext: async (callback: () => Promise<unknown> | unknown) => await callback(),
}));

vi.mock('../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

vi.mock('../../../../config', () => ({
    loadConfig: () => ({
        xrpl: {
            endpoint: 'wss://unit-test',
        },
    }),
}));

vi.mock('../../../../market/instrumentRegistry', () => ({
    findInstrument: vi.fn(),
    isValidPairKey: mockIsValidPairKey,
}));

vi.mock('../../../lib/xrplClient', () => ({
    getSharedClient: vi.fn(),
    getCachedPrice: mockGetCachedPrice,
    setCachedPrice: vi.fn(),
}));

vi.mock('../../../../analytics/logger', () => ({
    logger: {
        error: vi.fn(),
    },
}));

import handler from '../bot/price';

function createReq() {
    return {
        method: 'GET',
        query: {
            pair: 'BAD/PAIR',
        },
        requestId: 'test-price-route-context',
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

describe('Pages API route context wrapper: /api/bot/price', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsValidPairKey.mockReturnValue(false);
        mockGetCachedPrice.mockReturnValue(null);
    });

    it('marks and clears API route context for a normal request', async () => {
        const req = createReq();
        const res = createRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(mockMarkApiRouteContext).toHaveBeenCalledTimes(1);
        expect(mockClearApiRouteContext).toHaveBeenCalledTimes(1);
    });

    it('clears API route context even when the handler throws', async () => {
        const req = createReq();
        const res = createRes({ throwOnStatus: true });

        await expect(handler(req, res)).rejects.toThrow('status failed');
        expect(mockMarkApiRouteContext).toHaveBeenCalledTimes(1);
        expect(mockClearApiRouteContext).toHaveBeenCalledTimes(1);
    });
});
