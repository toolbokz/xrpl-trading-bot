import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetCacheSnapshot, mockIsSingleProcessMode } = vi.hoisted(() => ({
    mockGetCacheSnapshot: vi.fn(),
    mockIsSingleProcessMode: vi.fn(),
}));

vi.mock('../../../../lib/runtimeBridge', () => ({
    getCacheSnapshot: mockGetCacheSnapshot,
    isSingleProcessMode: mockIsSingleProcessMode,
}));

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

import handler from '../runtime';

function createMockReq() {
    return {
        method: 'GET',
        query: {},
        requestId: 'test-req-runtime-metrics-001',
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

describe('GET /api/metrics/runtime', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('includes strategy funnel telemetry fields when present in cache snapshot', () => {
        mockIsSingleProcessMode.mockReturnValue(true);
        mockGetCacheSnapshot.mockReturnValue({
            pairKey: 'XRP/RLUSD',
            asOfMs: 1_770_000_000_000,
            sequence: 42,
            runtimeState: 'READY',
            executionAllowed: true,
            health: null,
            flow: null,
            tape: null,
            orderbook: null,
            balance: null,
            executionQuality: null,
            spreadRegime: null,
            liquidity: null,
            spreadDistribution: null,
            background: null,
            strategyFunnel: {
                'orderbook-scalper': {
                    strategyTicks: 12,
                    candidatesBuilt: 4,
                    rejectedCount: 8,
                    rejectedByReason: {
                        regimeNotAllowed: 3,
                        minEdge: 5,
                    },
                    approvedCount: 4,
                    submitAttemptCount: 4,
                    submitSuccessCount: 2,
                    submitFailCount: 2,
                    lastSubmitError: 'tecUNFUNDED_OFFER',
                    lastTxHash: 'ABC123',
                },
            },
        });

        const req = createMockReq();
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.requestId).toBe('test-req-runtime-metrics-001');
        expect(res.body.data.strategyFunnel['orderbook-scalper']).toEqual(
            expect.objectContaining({
                strategyTicks: 12,
                rejectedByReason: expect.objectContaining({
                    regimeNotAllowed: 3,
                }),
                submitFailCount: 2,
                lastSubmitError: 'tecUNFUNDED_OFFER',
                lastTxHash: 'ABC123',
            }),
        );
    });
});
