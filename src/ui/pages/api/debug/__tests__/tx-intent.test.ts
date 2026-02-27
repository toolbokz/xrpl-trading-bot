import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockGetTradeById,
    mockGetTradeByHash,
    mockUpsertTradeTrace,
    mockGetApiXrplClient,
} = vi.hoisted(() => ({
    mockGetTradeById: vi.fn(),
    mockGetTradeByHash: vi.fn(),
    mockUpsertTradeTrace: vi.fn(),
    mockGetApiXrplClient: vi.fn(),
}));

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

vi.mock('../../../../../analytics/tradeHistory', () => ({
    tradeHistory: {
        getTradeById: mockGetTradeById,
        getTradeByHash: mockGetTradeByHash,
        upsertTradeTrace: mockUpsertTradeTrace,
    },
}));

vi.mock('../../../../lib/apiXrplClient', () => ({
    getApiXrplClient: mockGetApiXrplClient,
}));

import handler from '../tx-intent';

function createMockReq(query: Record<string, string> = {}) {
    return {
        method: 'GET',
        query,
        requestId: 'test-req-tx-intent-001',
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

describe('GET /api/debug/tx-intent backfill', () => {
    const originalLocalOnly = process.env.BOT_LOCAL_ONLY;
    const originalLookup = process.env.FEATURE_TX_INTENT_LOOKUP;
    const originalPersist = process.env.FEATURE_TX_INTENT_LOOKUP_PERSIST;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.BOT_LOCAL_ONLY = 'true';
        process.env.FEATURE_TX_INTENT_LOOKUP = 'true';
        delete process.env.FEATURE_TX_INTENT_LOOKUP_PERSIST;
    });

    afterEach(() => {
        if (typeof originalLocalOnly === 'string') process.env.BOT_LOCAL_ONLY = originalLocalOnly;
        else delete process.env.BOT_LOCAL_ONLY;
        if (typeof originalLookup === 'string') process.env.FEATURE_TX_INTENT_LOOKUP = originalLookup;
        else delete process.env.FEATURE_TX_INTENT_LOOKUP;
        if (typeof originalPersist === 'string') process.env.FEATURE_TX_INTENT_LOOKUP_PERSIST = originalPersist;
        else delete process.env.FEATURE_TX_INTENT_LOOKUP_PERSIST;
    });

    it('backfills txType and offerCreateIntent from validated tx lookup with issuer redaction', async () => {
        const request = vi.fn().mockResolvedValue({
            result: {
                validated: true,
                tx_json: {
                    TransactionType: 'OfferCreate',
                    Flags: 0x000A0000,
                    TakerGets: {
                        currency: 'RLUSD',
                        issuer: 'rSECRET_ISSUER',
                        value: '1.4',
                    },
                    TakerPays: '1000000',
                    Fee: '12',
                    Sequence: 101,
                    LastLedgerSequence: 500000,
                },
            },
        });
        mockGetApiXrplClient.mockResolvedValue({ request });
        mockGetTradeByHash.mockReturnValue({
            id: 'trade-lookup-001',
            pair: 'XRP/RLUSD',
            side: 'BUY',
            hash: 'HASH_LOOKUP_001',
            trace: {
                tx_hash: 'HASH_LOOKUP_001',
                tx_type: null,
                offer_create: null,
                depth_check: {
                    side: 'BUY',
                    intended_price: 1.4,
                    required_base: 0.5,
                    min_required_base: 0.5,
                    fillable_base: 0.25,
                    has_depth: false,
                    min_fill_ratio: 1,
                    depth_check_levels: 12,
                    order_type: 'IOC',
                    ledger_index_mode: 'validated',
                    request_taker_gets_currency: 'XRP',
                    request_taker_pays_currency: 'RLUSD',
                    error: null,
                },
                expected_price: 1.4,
                submit_result: {
                    engine_result: 'tecKILLED',
                },
                outcome_reason: 'tecKILLED',
            },
        });

        const req = createMockReq({ hash: 'HASH_LOOKUP_001' });
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            command: 'tx',
            transaction: 'HASH_LOOKUP_001',
            binary: false,
        }));
        expect(res.body.txType).toBe('OfferCreate');
        expect(res.body.offerCreateIntent).toEqual(expect.objectContaining({
            flags: 0x000A0000,
            flagsDecoded: expect.arrayContaining(['IOC', 'SELL']),
            takerGets: expect.objectContaining({
                currency: 'RLUSD',
                issuer: '[redacted]',
            }),
            takerPays: '1000000',
            feeDrops: '12',
            sequence: 101,
            lastLedgerSequence: 500000,
        }));
        expect(res.body.depth_check).toEqual(expect.objectContaining({
            side: 'BUY',
            intended_price: 1.4,
            required_base: 0.5,
            min_required_base: 0.5,
            fillable_base: 0.25,
            has_depth: false,
            order_type: 'IOC',
            ledger_index_mode: 'validated',
        }));
        expect(res.body.backfilled).toBe(true);
        expect(res.body.backfillError).toBeNull();
    });

    it('backfills when xrpl tx payload is returned at result root without tx_json wrapper', async () => {
        const request = vi.fn().mockResolvedValue({
            result: {
                validated: true,
                TransactionType: 'OfferCreate',
                Flags: 0x00020000,
                TakerGets: {
                    currency: 'RLUSD',
                    issuer: 'rROOT_ISSUER',
                    value: '1.5',
                },
                TakerPays: '1000000',
                Fee: '12',
                Sequence: 111,
                LastLedgerSequence: 500111,
            },
        });
        mockGetApiXrplClient.mockResolvedValue({ request });
        mockGetTradeByHash.mockReturnValue({
            id: 'trade-lookup-001b',
            pair: 'XRP/RLUSD',
            side: 'BUY',
            hash: 'HASH_LOOKUP_001B',
            trace: {
                tx_hash: 'HASH_LOOKUP_001B',
                tx_type: null,
                offer_create: null,
                submit_result: {
                    engine_result: 'tecKILLED',
                },
                outcome_reason: 'tecKILLED',
            },
        });

        const req = createMockReq({ hash: 'HASH_LOOKUP_001B' });
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.txType).toBe('OfferCreate');
        expect(res.body.offerCreateIntent).toEqual(expect.objectContaining({
            flags: 0x00020000,
            flagsDecoded: expect.arrayContaining(['IOC']),
            takerGets: expect.objectContaining({
                issuer: '[redacted]',
            }),
            takerPays: '1000000',
            feeDrops: '12',
            sequence: 111,
            lastLedgerSequence: 500111,
        }));
        expect(res.body.backfilled).toBe(true);
        expect(res.body.backfillError).toBeNull();
    });

    it('returns backfillError and preserves trace response when lookup fails', async () => {
        mockGetApiXrplClient.mockResolvedValue({
            request: vi.fn().mockRejectedValue(new Error('lookup-failed')),
        });
        mockGetTradeByHash.mockReturnValue({
            id: 'trade-lookup-002',
            pair: 'XRP/RLUSD',
            side: 'BUY',
            hash: 'HASH_LOOKUP_002',
            trace: {
                tx_hash: 'HASH_LOOKUP_002',
                tx_type: null,
                offer_create: null,
                submit_result: {
                    engine_result: 'tecKILLED',
                },
                outcome_reason: 'tecKILLED',
            },
        });

        const req = createMockReq({ hash: 'HASH_LOOKUP_002' });
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.txType).toBeNull();
        expect(res.body.offerCreateIntent).toBeNull();
        expect(res.body.backfilled).toBe(false);
        expect(res.body.backfillError).toContain('lookup-failed');
    });

    it('persists redacted backfill patch when FEATURE_TX_INTENT_LOOKUP_PERSIST=true', async () => {
        process.env.FEATURE_TX_INTENT_LOOKUP_PERSIST = 'true';
        mockGetApiXrplClient.mockResolvedValue({
            request: vi.fn().mockResolvedValue({
                result: {
                    validated: true,
                    tx_json: {
                        TransactionType: 'OfferCreate',
                        Flags: 0,
                        TakerGets: {
                            currency: 'RLUSD',
                            issuer: 'rSECRET_ISSUER',
                            value: '1.5',
                        },
                        TakerPays: '1000000',
                        Fee: '12',
                        Sequence: 202,
                        LastLedgerSequence: 700000,
                    },
                },
            }),
        });
        mockGetTradeByHash.mockReturnValue({
            id: 'trade-lookup-003',
            pair: 'XRP/RLUSD',
            side: 'BUY',
            hash: 'HASH_LOOKUP_003',
            trace: {
                tx_hash: 'HASH_LOOKUP_003',
                tx_type: null,
                offer_create: null,
                submit_result: {
                    engine_result: 'tecKILLED',
                },
                outcome_reason: 'tecKILLED',
            },
        });

        const req = createMockReq({ hash: 'HASH_LOOKUP_003' });
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockUpsertTradeTrace).toHaveBeenCalledWith(expect.objectContaining({
            hash: 'HASH_LOOKUP_003',
            tradeId: 'trade-lookup-003',
            patch: expect.objectContaining({
                tx_type: 'OfferCreate',
                offer_create: expect.objectContaining({
                    takerGets: expect.objectContaining({
                        issuer: '[redacted]',
                    }),
                }),
            }),
        }));
    });

    it('returns depth_reprice snapshot when present on the trade trace', async () => {
        mockGetTradeByHash.mockReturnValue({
            id: 'trade-lookup-004',
            pair: 'XRP/RLUSD',
            side: 'SELL',
            hash: 'HASH_LOOKUP_004',
            trace: {
                tx_hash: 'HASH_LOOKUP_004',
                tx_type: 'OfferCreate',
                offer_create: {
                    flags: 0x00020000,
                    flagsDecoded: ['IOC'],
                    takerGets: '500000',
                    takerPays: {
                        currency: 'RLUSD',
                        issuer: '[redacted]',
                        value: '0.7',
                    },
                    feeDrops: '12',
                    sequence: 101,
                    lastLedgerSequence: 500000,
                },
                depth_reprice: {
                    enabled: true,
                    intended_price: 1.4,
                    repriced_price: 1.4002,
                    required_reprice_bps: 1.43,
                    min_required_base: 0.5,
                    fillable_base_at_intended: 0.2,
                    fillable_base_at_repriced: 0.6,
                    decision: 'applied',
                    max_reprice_bps: 3,
                },
                submit_result: {
                    engine_result: 'tesSUCCESS',
                },
                outcome_reason: null,
            },
        });

        const req = createMockReq({ hash: 'HASH_LOOKUP_004' });
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.depth_reprice).toEqual({
            enabled: true,
            intended_price: 1.4,
            repriced_price: 1.4002,
            required_reprice_bps: 1.43,
            min_required_base: 0.5,
            fillable_base_at_intended: 0.2,
            fillable_base_at_repriced: 0.6,
            decision: 'applied',
            max_reprice_bps: 3,
        });
    });
});
