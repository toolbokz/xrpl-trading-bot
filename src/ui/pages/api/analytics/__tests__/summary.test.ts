/**
 * Analytics summary API handler — response shape tests.
 *
 * Verifies that /api/analytics/summary returns the expected fields,
 * including the additive drawdownVelocity and profitFactorSeries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures the fn is available when vi.mock factory runs (hoisted above imports)
const mockGetAnalytics = vi.hoisted(() => vi.fn());

vi.mock('../../../../../analytics/feedbackEngine', () => ({
    feedbackEngine: {
        getAnalytics: mockGetAnalytics,
    },
}));

// Stub withLocalApi to pass the handler through directly (no localhost check)
vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
    LocalRequest: {} as any,
}));

import handler from '../summary';
import type { AnalyticsApiResponse } from '../summary';

// Minimal mock request / response helpers
function mockReq(method = 'GET', query: Record<string, string> = {}) {
    return {
        method,
        query,
        requestId: 'test-req-1',
    } as any;
}

function mockRes() {
    const res: any = {
        _status: 0,
        _json: null as any,
        status(code: number) {
            res._status = code;
            return res;
        },
        json(body: any) {
            res._json = body;
            return res;
        },
    };
    return res;
}

describe('GET /api/analytics/summary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns drawdownVelocity and profitFactorSeries in response', () => {
        mockGetAnalytics.mockReturnValue({
            summary: {
                trades: 10,
                wins: 6,
                losses: 4,
                winRate: 0.6,
                profitFactor: 1.5,
                expectancy: 0.02,
                avgSlippageBps: 3.1,
                totalPnlApprox: 1.23,
                maxDrawdown: 0.05,
                avgEdgeBps: 4.2,
            },
            byRegime: [],
            byStrategy: [],
            drawdown: [
                { ts: 1000, equity: 0.5, drawdown: 0 },
                { ts: 2000, equity: 0.3, drawdown: 0.4 },
            ],
            drawdownVelocity: 1440,
            profitFactorSeries: [
                { ts: 1000, profitFactor: 1.2 },
                { ts: 2000, profitFactor: 1.5 },
            ],
        });

        const req = mockReq('GET');
        const res = mockRes();

        handler(req, res);

        expect(res._status).toBe(200);

        const body: AnalyticsApiResponse = res._json;

        // Existing fields still present
        expect(body).toHaveProperty('summary');
        expect(body).toHaveProperty('byRegime');
        expect(body).toHaveProperty('byStrategy');
        expect(body).toHaveProperty('drawdown');

        // New additive fields
        expect(body).toHaveProperty('drawdownVelocity');
        expect(typeof body.drawdownVelocity).toBe('number');
        expect(body.drawdownVelocity).toBe(1440);

        expect(body).toHaveProperty('profitFactorSeries');
        expect(Array.isArray(body.profitFactorSeries)).toBe(true);
        expect(body.profitFactorSeries).toHaveLength(2);
        expect(body.profitFactorSeries[0]).toHaveProperty('ts');
        expect(body.profitFactorSeries[0]).toHaveProperty('profitFactor');
    });

    it('returns 405 for non-GET methods', () => {
        const req = mockReq('POST');
        const res = mockRes();

        handler(req, res);

        expect(res._status).toBe(405);
    });
});
