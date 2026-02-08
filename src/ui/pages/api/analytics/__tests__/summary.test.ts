/**
 * Analytics Summary API unit tests
 * Verifies the /api/analytics/summary response shape includes
 * drawdownVelocity and profitFactorSeries fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock feedbackEngine before any import that pulls it in
vi.mock('../../../../../analytics/feedbackEngine', () => {
    return {
        feedbackEngine: {
            getAnalytics: vi.fn().mockReturnValue({
                summary: {
                    trades: 10,
                    wins: 6,
                    losses: 4,
                    winRate: 0.6,
                    profitFactor: 1.5,
                    expectancy: 0.002,
                    avgSlippageBps: 3.2,
                    totalPnlApprox: 0.05,
                    maxDrawdown: 0.12,
                    avgEdgeBps: 5.1,
                },
                byRegime: [
                    {
                        regime: 'normal',
                        trades: 10,
                        winRate: 0.6,
                        expectancy: 0.002,
                        profitFactor: 1.5,
                        avgSlippageBps: 3.2,
                        totalPnl: 0.05,
                        pnlPerTrade: 0.005,
                    },
                ],
                byStrategy: [
                    {
                        strategy: 'scalper',
                        trades: 10,
                        winRate: 0.6,
                        expectancy: 0.002,
                        profitFactor: 1.5,
                    },
                ],
                drawdown: [
                    { ts: 1000, equity: 0.01, drawdown: 0 },
                    { ts: 2000, equity: -0.01, drawdown: 0.02 },
                ],
                drawdownVelocity: 0.72,
                profitFactorSeries: [
                    { ts: 1000, profitFactor: 1.2 },
                    { ts: 2000, profitFactor: 1.5 },
                ],
            }),
        },
        // Re-export types used by summary.ts imports
        AnalyticsResponse: {},
        AnalyticsSummary: {},
        RegimeStats: {},
        StrategyStats: {},
        DrawdownPoint: {},
        ProfitFactorPoint: {},
    };
});

// Mock withLocalApi to pass through the handler directly
vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

import handler from '../summary';

function createMockReq(query: Record<string, string> = {}) {
    return {
        method: 'GET',
        query,
        requestId: 'test-req-001',
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

describe('GET /api/analytics/summary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return 200 with all fields including drawdownVelocity and profitFactorSeries', () => {
        const req = createMockReq();
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toBeDefined();

        // Core fields
        expect(res.body.requestId).toBe('test-req-001');
        expect(res.body.timestamp).toBeDefined();
        expect(res.body.summary).toBeDefined();
        expect(res.body.byRegime).toBeDefined();
        expect(res.body.byStrategy).toBeDefined();
        expect(res.body.drawdown).toBeDefined();

        // PR1: New fields must be present
        expect(res.body).toHaveProperty('drawdownVelocity');
        expect(typeof res.body.drawdownVelocity).toBe('number');
        expect(res.body.drawdownVelocity).toBe(0.72);

        expect(res.body).toHaveProperty('profitFactorSeries');
        expect(Array.isArray(res.body.profitFactorSeries)).toBe(true);
        expect(res.body.profitFactorSeries).toHaveLength(2);
        expect(res.body.profitFactorSeries[0]).toEqual({ ts: 1000, profitFactor: 1.2 });
    });

    it('should pass pair and sinceMs filters to getAnalytics', async () => {
        const mod = await import('../../../../../analytics/feedbackEngine');
        const req = createMockReq({ pair: 'XRP/USD', sinceMs: '1000000' });
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mod.feedbackEngine.getAnalytics).toHaveBeenCalledWith({
            pairKey: 'XRP/USD',
            sinceMs: 1000000,
        });
    });

    it('should return 405 for non-GET methods', () => {
        const req = { method: 'POST', query: {}, requestId: 'test-req-002' } as any;
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(405);
    });

    it('should include byRegime entries with totalPnl and pnlPerTrade', () => {
        const req = createMockReq();
        const res = createMockRes();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        const regime = res.body.byRegime[0];
        expect(regime).toHaveProperty('totalPnl');
        expect(regime).toHaveProperty('pnlPerTrade');
    });
});
