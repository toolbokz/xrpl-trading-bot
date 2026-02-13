import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnsureRuntimeHooks, mockGetCacheSnapshot, mockIsSingleProcessMode } = vi.hoisted(() => ({
    mockEnsureRuntimeHooks: vi.fn(),
    mockGetCacheSnapshot: vi.fn(),
    mockIsSingleProcessMode: vi.fn(),
}));

vi.mock('../../../../lib/runtimeHooks', () => ({
    ensureRuntimeHooks: mockEnsureRuntimeHooks,
}));

vi.mock('../../../../lib/runtimeBridge', () => ({
    getCacheSnapshot: mockGetCacheSnapshot,
    isSingleProcessMode: mockIsSingleProcessMode,
}));

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

import handler from '../risk';

function createMockReq() {
    return {
        method: 'GET',
        query: {},
        requestId: 'test-req-bot-risk-001',
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

describe('GET /api/bot/risk', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('includes hard risk drawdown confidence fields in response payload', () => {
        mockIsSingleProcessMode.mockReturnValue(true);
        mockGetCacheSnapshot.mockReturnValue({
            pairKey: 'XRP/RLUSD',
            asOfMs: 1_770_000_000_000,
            executionAllowed: true,
            runtimeState: 'READY',
        });

        mockEnsureRuntimeHooks.mockReturnValue({
            getRiskStatus: () => ({
                maxExposure: 5000,
                currentExposure: 120,
                dailyLossLimit: 500,
                dailyLossCurrent: 0,
                killSwitch: false,
                consecutiveFailures: 0,
                maxTradeSize: 1000,
                reserveFloorXRP: 25,
            }),
            getHardRiskPayload: () => ({
                pairKey: 'XRP/RLUSD',
                result: {
                    riskState: 'WARNING',
                    riskBlockReasons: [],
                    warningReasons: ['drawdown-breached'],
                    metrics: {
                        currentExposureNotional: 120,
                        inventorySkewPct: 5,
                        drawdownPct: 98.5,
                        drawdownConfidence: false,
                        tradesCount: 12,
                        peakEquity: 0.02,
                        equityNow: -0.5,
                        runtimeReady: true,
                        marketDataValid: true,
                        balancesFresh: true,
                        feedHealthy: true,
                    },
                    executionAllowed: true,
                    evaluatedAt: 1_770_000_000_010,
                },
                thresholds: {
                    maxExposureNotional: 5000,
                    maxInventorySkewPct: 80,
                    maxDrawdownPct: 7,
                    minTradesForDrawdown: 50,
                    minPeakEquityForDrawdown: 1,
                    maxBalanceStalenessMs: 120000,
                    minFeedHealthScore: 40,
                    warningThresholdRatio: 0.8,
                    maxEvents: 100,
                },
                recentEvents: [],
            }),
            getExposureSnapshot: () => null,
            getConfig: () => ({
                risk: {
                    maxExposurePerIssuer: 5000,
                    maxDailyLoss: 500,
                    maxTradeSize: 1000,
                    reserveFloorXRP: 25,
                },
                strategy: {
                    positionSize: 5,
                },
            }),
        });

        const req = createMockReq();
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.requestId).toBe('test-req-bot-risk-001');
        expect(res.body.hardRisk.result.metrics).toEqual(
            expect.objectContaining({
                drawdownPct: 98.5,
                drawdownConfidence: false,
                tradesCount: 12,
                peakEquity: 0.02,
                equityNow: -0.5,
            }),
        );
    });
});

