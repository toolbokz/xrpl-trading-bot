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
        expect(mockGetRecentTrades).toHaveBeenCalledWith(500, false);
        expect(res.body.limit).toBe(500);
        expect(res.body.totalTradesAnalyzed).toBe(3);
        expect(res.body.buckets).toEqual({
            'tecKILLED:INSUFFICIENT_LIQUIDITY_AT_PRICE': 1,
            'tefMAX_LEDGER:EXPIRED_LAST_LEDGER': 2,
        });
        expect(res.body.repriceAppliedByBucket).toEqual({});
        expect(res.body.flagsDecoded).toEqual({
            IOC: 1,
            FOK: 1,
            PASSIVE: 2,
        });
        expect(res.body.sideByBucket).toEqual({
            'tecKILLED:INSUFFICIENT_LIQUIDITY_AT_PRICE': { BUY: 1, SELL: 0 },
            'tefMAX_LEDGER:EXPIRED_LAST_LEDGER': { BUY: 1, SELL: 1 },
        });
        expect(res.body.examplesByBucket).toEqual({
            'tecKILLED:INSUFFICIENT_LIQUIDITY_AT_PRICE': ['trade-1'],
            'tefMAX_LEDGER:EXPIRED_LAST_LEDGER': ['trade-2', 'trade-4'],
        });
        expect(JSON.stringify(res.body)).not.toContain(secretIssuer);
    });

    it('uses the requested limit query value', () => {
        mockGetRecentTrades.mockReturnValue([
            {
                id: 'trade-a',
                side: 'BUY',
                trace: {
                    submit_result: { engine_result: 'tesSUCCESS' },
                },
            },
            {
                id: 'trade-b',
                side: 'SELL',
                trace: {
                    submit_result: { engine_result: 'tecKILLED' },
                },
            },
        ]);

        const req = createMockReq('GET', { limit: '2' });
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockGetRecentTrades).toHaveBeenCalledWith(2, false);
        expect(res.body.limit).toBe(2);
        expect(res.body.totalTradesAnalyzed).toBe(2);
    });

    it('tracks repriceAppliedByBucket when depth_reprice decision is applied', () => {
        mockGetRecentTrades.mockReturnValue([
            {
                id: 'trade-reprice-1',
                side: 'BUY',
                paper: false,
                status: 'FILLED',
                trace: {
                    tx_type: 'OfferCreate',
                    offer_create: {
                        flagsDecoded: ['IOC'],
                    },
                    submit_result: {
                        engine_result: 'tesSUCCESS',
                    },
                    depth_reprice: {
                        decision: 'applied',
                    },
                },
            },
            {
                id: 'trade-reprice-2',
                side: 'BUY',
                paper: false,
                status: 'FILLED',
                trace: {
                    tx_type: 'OfferCreate',
                    offer_create: {
                        flagsDecoded: ['IOC'],
                    },
                    submit_result: {
                        engine_result: 'tesSUCCESS',
                    },
                    depth_reprice: {
                        decision: 'not_needed',
                    },
                },
            },
        ]);

        const req = createMockReq('GET');
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.buckets).toEqual({
            'tesSUCCESS:DEPTH_REPRICE_APPLIED': 1,
            'tesSUCCESS:UNKNOWN': 1,
        });
        expect(res.body.repriceAppliedByBucket).toEqual({
            'tesSUCCESS:DEPTH_REPRICE_APPLIED': 1,
        });
    });

    it('excludes non-execution trades and reduces NONE:NONE noise', () => {
        mockGetRecentTrades.mockReturnValue([
            {
                id: 'trade-exec',
                side: 'BUY',
                paper: false,
                status: 'REJECTED',
                trace: {
                    tx_type: 'OfferCreate',
                    offer_create: {
                        flagsDecoded: ['IOC'],
                    },
                    submit_result: {
                        engine_result: 'tecKILLED',
                    },
                    outcome_reason: 'tecKILLED',
                },
            },
            {
                id: 'trade-no-trace',
                side: 'SELL',
                paper: false,
                status: 'REJECTED',
                trace: null,
            },
            {
                id: 'trade-pending-no-submit',
                side: 'BUY',
                paper: false,
                status: 'PENDING',
                trace: {
                    tx_type: 'OfferCreate',
                    offer_create: {
                        flagsDecoded: ['IOC'],
                    },
                    submit_ts_ms: null,
                    tx_hash: null,
                },
            },
            {
                id: 'trade-paper',
                side: 'BUY',
                paper: true,
                status: 'FILLED',
                trace: {
                    submit_result: {
                        engine_result: 'tesSUCCESS',
                    },
                },
            },
        ]);

        const req = createMockReq('GET');
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.totalTradesAnalyzed).toBe(1);
        expect(res.body.buckets).toEqual({
            'tecKILLED:MISSING_INTENT_TRACE': 1,
        });
        expect(res.body.buckets['NONE:NONE']).toBeUndefined();
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

    it('buckets tecKILLED trades with missing depth evidence as MISSING_DEPTH_EVIDENCE', () => {
        mockGetRecentTrades.mockReturnValue([
            {
                id: 'trade-missing-depth',
                side: 'BUY',
                paper: false,
                status: 'REJECTED',
                trace: {
                    expected_price: 1.4,
                    submit_result: {
                        engine_result: 'tecKILLED',
                    },
                    outcome_reason: 'tecKILLED',
                    tx_type: 'OfferCreate',
                    offer_create: {
                        flagsDecoded: ['IOC'],
                        takerGets: {
                            currency: 'RLUSD',
                            issuer: '[redacted]',
                            value: '0.7',
                        },
                        takerPays: '500000',
                    },
                    depth_check: null,
                },
            },
        ]);

        const req = createMockReq('GET');
        const res = createMockRes();
        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.buckets).toEqual({
            'tecKILLED:MISSING_DEPTH_EVIDENCE': 1,
        });
        expect(res.body.examplesByBucket).toEqual({
            'tecKILLED:MISSING_DEPTH_EVIDENCE': ['trade-missing-depth'],
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
