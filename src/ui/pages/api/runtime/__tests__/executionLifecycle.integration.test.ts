import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockReq {
    method: string;
    query: Record<string, string>;
    requestId: string;
}

interface MockRes {
    statusCode: number;
    body: any;
    status: (code: number) => MockRes;
    json: (payload: any) => MockRes;
}

function createMockReq(query: Record<string, string> = {}): MockReq {
    return {
        method: 'GET',
        query,
        requestId: `req-${Date.now()}`,
    };
}

function createMockRes(): MockRes {
    const res: MockRes = {
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

class SimulatedXrplNode {
    readonly txHash: string;
    private txLookupCount = 0;

    constructor(
        private readonly engineResult: string,
        private readonly txResult: string,
        txHash?: string,
    ) {
        this.txHash = txHash ?? 'SIMULATED_TX_HASH_001';
    }

    async autofill(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
        return {
            ...tx,
            Fee: '12',
            Sequence: 1001,
            LastLedgerSequence: 900100,
        };
    }

    async submit(_txBlob: string): Promise<{ result: Record<string, unknown> }> {
        return {
            result: {
                hash: this.txHash,
                engine_result: this.engineResult,
                engine_result_code: this.engineResult === 'tesSUCCESS' ? 0 : -1,
                engine_result_message: `simulated-${this.engineResult}`,
                tx_json: { hash: this.txHash },
            },
        };
    }

    async submitAndWait(txBlob: string): Promise<{ result: Record<string, unknown> }> {
        return this.submit(txBlob);
    }

    async request(req: Record<string, unknown>): Promise<{ result: Record<string, unknown> }> {
        const command = req.command;
        if (command === 'book_offers') {
            return {
                result: {
                    offers: [
                        {
                            TakerGets: '1000000',
                            TakerPays: {
                                currency: 'RLUSD',
                                issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                                value: '1.3900',
                            },
                        },
                    ],
                },
            };
        }
        if (command === 'tx') {
            this.txLookupCount += 1;
            if (this.txLookupCount === 1 && this.engineResult === 'terQUEUED') {
                return {
                    result: {
                        validated: false,
                    },
                };
            }
            return {
                result: {
                    hash: this.txHash,
                    validated: true,
                    ledger_index: 900001,
                    date: 820000000,
                    meta: {
                        TransactionResult: this.txResult,
                        AffectedNodes: [],
                    },
                    tx_json: { hash: this.txHash },
                },
            };
        }
        throw new Error(`Unsupported command in simulated XRPL node: ${String(command)}`);
    }
}

describe.sequential('Execution lifecycle API integration', () => {
    const originalCwd = process.cwd();
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrpl-exec-lifecycle-'));
        process.chdir(tempDir);
        fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'trade_history.json'), '[]', 'utf8');
        vi.resetModules();
    });

    afterEach(async () => {
        try {
            const { tradeMarkoutScheduler } = await import('../../../../../analytics/tradeMarkoutScheduler');
            tradeMarkoutScheduler.stop();
        } catch {
            // best effort cleanup
        }
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('emits non-zero SUBMIT_* and ORDER_* counters through /api/runtime/events after a simulated trade', async () => {
        const { ObservabilityBus } = await import('../../../../../observability/eventBus');
        const { OfferExecutor } = await import('../../../../../execution/offerExecutor');
        const { tradeMarkoutScheduler } = await import('../../../../../analytics/tradeMarkoutScheduler');

        const bus = new ObservabilityBus({ maxEvents: 500, dedupIntervalMs: 0 });
        const node = new SimulatedXrplNode('tesSUCCESS', 'tesSUCCESS', 'SIMULATED_TX_HASH_002');

        const pair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
            baseIssuer: '',
            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        };
        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn().mockReturnValue({
                tx_blob: 'DEADBEEF',
                hash: node.txHash,
            }),
        };
        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        };

        tradeMarkoutScheduler.setHooks({
            emit_event: (event) => {
                bus.emit({
                    eventType: event.event_type as any,
                    pairKey: event.pair_key,
                    runtimeState: 'READY',
                    correlationId: event.correlation_id,
                    detail: event.detail,
                });
            },
        });
        tradeMarkoutScheduler.start();

        const executor = new OfferExecutor(node as any, wallet as any, risk as any, false, pair as any, undefined);
        executor.setCurrentStrategy('integration-scalper');
        executor.setSubmitTelemetrySink((event) => {
            const eventType = event.stage === 'attempt'
                ? 'SUBMIT_ATTEMPT'
                : (event.stage === 'success' ? 'SUBMIT_SUCCESS' : 'SUBMIT_FAIL');
            bus.emit({
                eventType: eventType as any,
                pairKey: event.pairKey,
                runtimeState: 'READY',
                correlationId: event.tradeId ?? null,
                detail: {
                    strategy: event.strategy,
                    trade_id: event.tradeId ?? null,
                    tx_hash: event.txHash ?? null,
                    submit_ts_ms: event.submitTsMs ?? null,
                    submit_response_ts_ms: event.submitResponseTsMs ?? event.ackTsMs ?? null,
                    ack_ts_ms: event.ackTsMs ?? event.submitResponseTsMs ?? null,
                    engine_result: event.submitResult?.engine_result ?? null,
                    submit_result: event.submitResult ?? null,
                    ack_status: event.ackStatus ?? null,
                },
            });
        });
        executor.setTradeToastEmitter((event) => {
            bus.emit({
                eventType: event.type as any,
                pairKey: event.pair,
                runtimeState: 'READY',
                correlationId: event.correlationId ?? null,
                detail: {
                    pair: event.pair,
                    baseCurrency: event.baseCurrency,
                    quoteCurrency: event.quoteCurrency,
                    side: event.side ?? null,
                    baseAmount: event.baseAmount,
                    quoteAmount: event.quoteAmount,
                    price: event.price,
                    feeQuote: event.feeQuote,
                    pnlQuote: event.pnlQuote,
                    timestamp: event.timestamp,
                },
            });
        });

        const result = await executor.placeOffer({
            side: 'buy',
            price: 1.4,
            amount: 0.5,
            expectedPrice: 1.4,
            strategy: 'integration-scalper',
        });

        expect(result.accepted).toBe(true);
        expect(result.hash).toBe(node.txHash);

        vi.doMock('../../../../lib/runtimeBridge', () => ({
            getRuntimeInstance: () => ({
                getObservabilityBus: () => bus,
            }),
        }));
        vi.doMock('../../../../lib/localApi', () => ({
            withLocalApi: (handler: Function) => handler,
        }));

        const eventsHandler = (await import('../events')).default;
        const req = createMockReq({ limit: '200' }) as any;
        const res = createMockRes() as any;
        eventsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.summary.SUBMIT_ATTEMPT).toBeGreaterThan(0);
        expect(res.body.summary.SUBMIT_SUCCESS + res.body.summary.SUBMIT_FAIL).toBeGreaterThan(0);
        expect(res.body.summary.ORDER_PLACED).toBeGreaterThan(0);
        expect(res.body.summary.ORDER_FILLED).toBeGreaterThan(0);

        const submitEvent = res.body.events.find((event: any) => event.eventType === 'SUBMIT_SUCCESS' || event.eventType === 'SUBMIT_FAIL');
        expect(submitEvent).toBeTruthy();
        expect(submitEvent.detail).toEqual(expect.objectContaining({
            submit_ts_ms: expect.any(Number),
            submit_response_ts_ms: expect.any(Number),
            ack_ts_ms: expect.any(Number),
            engine_result: expect.anything(),
            ack_status: expect.anything(),
        }));
        expect(submitEvent.detail.ack_ts_ms).toBe(submitEvent.detail.submit_response_ts_ms);
    });

    it('returns trade trace fields from /api/bot/trades with submit result and validated ledger index', async () => {
        vi.doMock('../../../../lib/localApi', () => ({
            withLocalApi: (handler: Function) => handler,
            logSensitiveAction: vi.fn(),
        }));

        const { OfferExecutor } = await import('../../../../../execution/offerExecutor');
        const node = new SimulatedXrplNode('terQUEUED', 'tesSUCCESS', 'SIMULATED_TX_HASH_003');
        const pair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
            baseIssuer: '',
            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        };
        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn().mockReturnValue({
                tx_blob: 'DEADBEEF',
                hash: node.txHash,
            }),
        };
        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        };

        const executor = new OfferExecutor(node as any, wallet as any, risk as any, false, pair as any, undefined);
        executor.setCurrentStrategy('integration-scalper');
        await executor.placeOffer({
            side: 'buy',
            price: 1.41,
            amount: 0.5,
            expectedPrice: 1.41,
            strategy: 'integration-scalper',
        });

        const tradesHandler = (await import('../../bot/trades')).default;
        const req = createMockReq({ limit: '10' }) as any;
        const res = createMockRes() as any;
        await tradesHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body.trades)).toBe(true);
        expect(res.body.trades.length).toBeGreaterThan(0);

        const trade = res.body.trades.find((t: any) => t.hash === node.txHash);
        expect(trade).toBeTruthy();
        expect(trade).toEqual(expect.objectContaining({
            pair: 'XRP/RLUSD',
            side: 'BUY',
            price: expect.any(Number),
            amount: expect.any(Number),
            filled: expect.any(Number),
            fee: expect.any(Number),
            hash: node.txHash,
            status: 'FILLED',
            timestamp: expect.any(Number),
        }));
        expect(trade.trace).toBeTruthy();
        expect(trade.trace.submit_result.engine_result).toBe('terQUEUED');
        expect(trade.trace.ack_status).toBe('queued');
        expect(typeof trade.trace.submit_ts_ms).toBe('number');
        expect(typeof trade.trace.submit_response_ts_ms).toBe('number');
        expect(trade.trace.submit_response_ts_ms).toBe(trade.trace.ack_ts_ms);
        expect((trade.trace.submit_response_ts_ms as number) - (trade.trace.submit_ts_ms as number)).toBeLessThan(250);
        expect(trade.trace.validated_ts_ms).toBeGreaterThanOrEqual(trade.trace.submit_response_ts_ms);
        expect(trade.trace.validated_ledger_index).toBe(900001);
        expect(trade.trace.fill_snapshot).toEqual(expect.objectContaining({
            fill_ts_ms: expect.any(Number),
            filled_base: expect.any(Number),
            filled_quote: expect.any(Number),
            avg_price: expect.any(Number),
        }));
    });
});
