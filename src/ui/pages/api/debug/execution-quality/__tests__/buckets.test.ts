import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetRecentTrades } = vi.hoisted(() => ({
    mockGetRecentTrades: vi.fn(),
}));

vi.mock('../../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

vi.mock('../../../../../lib/tradeHistory', () => ({
    tradeHistory: {
        getRecentTrades: mockGetRecentTrades,
    },
}));

import handler from '../buckets';

function createMockReq(
    method: string = 'GET',
    query: Record<string, string> = {},
) {
    return {
        method,
        query,
        requestId: 'test-req-debug-buckets-001',
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
        json(payload: any) {
            res.body = payload;
            return res;
        },
    };
    return res;
}

describe('GET /api/debug/execution-quality/buckets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('aggregates bucket counts, flag counts, side counts, and examples', () => {
        const secretIssuer = 'rEXAMPLE_SECRET_ISSUER';
        mockGetRecentTrades.mockReturnValue([
            {
                id: 'trade-1',
                side: 'BUY',
                trace: {
                    outcome: 'partial',
                    submit_result: {
                        engine_result: 'tecKILLED',
                    },
                    offer_create: {
                        flagsDecoded: ['IOC'],
                        takerGets: { issuer: secretIssuer, value: '1' },
                        takerPays: '1000000',
                    },
                },
            },
            {
                id: 'trade-2',
                side: 'SELL',
                trace: {
                    submit_result: {
                        engine_result: 'tefMAX_LEDGER',
                    },
                    offer_create: {
                        flagsDecoded: ['FOK', 'PASSIVE'],
                    },
                },
            },
            {
                id: 'trade-3',
                side: 'SELL',
                trace: null,
            },
            {
                id: 'trade-4',
                side: 'BUY',
                trace: {
                    submit_result: {
                        engine_result: 'tefMAX_LEDGER',
                    },
                    offer_create: {
                        flagsDecoded: ['PASSIVE', 'PASSIVE'],
                    },
                },
            },
        ]);

        const req = createMockReq('GET');
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetRecentTrades).toHaveBeenCalledWith(500);
        expect(res.body.limit).toBe(500);
        expect(res.body.totalTradesAnalyzed).toBe(4);
        expect(res.body.buckets).toEqual({
            'tecKILLED:INSUFFICIENT_LIQUIDITY_AT_PRICE': 1,
            'tefMAX_LEDGER:EXPIRED_LAST_LEDGER': 2,
            'NONE:NONE': 1,
        });
        expect(res.body.flagsDecoded).toEqual({
            IOC: 1,
            FOK: 1,
            PASSIVE: 2,
        });
        expect(res.body.sideByBucket).toEqual({
            'tecKILLED:INSUFFICIENT_LIQUIDITY_AT_PRICE': { BUY: 1, SELL: 0 },
            'tefMAX_LEDGER:EXPIRED_LAST_LEDGER': { BUY: 1, SELL: 1 },
            'NONE:NONE': { BUY: 0, SELL: 1 },
        });
        expect(res.body.examplesByBucket).toEqual({
            'tecKILLED:INSUFFICIENT_LIQUIDITY_AT_PRICE': ['trade-1'],
            'tefMAX_LEDGER:EXPIRED_LAST_LEDGER': ['trade-2', 'trade-4'],
            'NONE:NONE': ['trade-3'],
        });
        expect(JSON.stringify(res.body)).not.toContain(secretIssuer);
    });

    it('uses the requested limit query value', () => {
        mockGetRecentTrades.mockReturnValue([
            { id: 'trade-a', side: 'BUY', trace: null },
            { id: 'trade-b', side: 'SELL', trace: null },
        ]);

        const req = createMockReq('GET', { limit: '2' });
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetRecentTrades).toHaveBeenCalledWith(2);
        expect(res.body.limit).toBe(2);
        expect(res.body.totalTradesAnalyzed).toBe(2);
    });

    it('buckets tecKILLED trades with missing offer_create as MISSING_INTENT_TRACE', () => {
        mockGetRecentTrades.mockReturnValue([
            {
                id: 'trade-missing-intent',
                side: 'BUY',
                trace: {
                    expected_price: 1.4,
                    submit_result: {
                        engine_result: 'tecKILLED',
                    },
                    outcome_reason: 'tecKILLED',
                    tx_type: null,
                    offer_create: null,
                },
            },
        ]);

        const req = createMockReq('GET');
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.buckets).toEqual({
            'tecKILLED:MISSING_INTENT_TRACE': 1,
        });
        expect(res.body.examplesByBucket).toEqual({
            'tecKILLED:MISSING_INTENT_TRACE': ['trade-missing-intent'],
        });
    });

    it('buckets pre-submit min-order sanity rejects under NONE:MIN_ORDER_SANITY', () => {
        mockGetRecentTrades.mockReturnValue([
            {
                id: 'trade-min-order-sanity',
                side: 'BUY',
                trace: {
                    submit_result: {
                        engine_result: null,
                    },
                    outcome_reason: 'execution-min-order-sanity',
                    tx_type: 'OfferCreate',
                    offer_create: {
                        flagsDecoded: ['IOC'],
                        takerGets: {
                            currency: 'RLUSD',
                            issuer: '[redacted]',
                            value: '0.000000000000000001',
                        },
                        takerPays: '0',
                    },
                },
            },
        ]);

        const req = createMockReq('GET');
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.buckets).toEqual({
            'NONE:MIN_ORDER_SANITY': 1,
        });
        expect(res.body.examplesByBucket).toEqual({
            'NONE:MIN_ORDER_SANITY': ['trade-min-order-sanity'],
        });
    });

    it('rejects non-GET methods', () => {
        const req = createMockReq('POST');
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(405);
        expect(res.body.error).toBe('Method not allowed');
    });
});
