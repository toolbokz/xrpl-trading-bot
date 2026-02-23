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

async function waitForCondition(
    predicate: () => boolean,
    timeoutMs: number = 1000,
    intervalMs: number = 20,
): Promise<void> {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) <= timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

class SimulatedXrplNode {
    readonly txHash: string;
    private txLookupCount = 0;
    private readonly options: {
        omitTransactionTypeInAutofill: boolean;
    };

    constructor(
        private readonly engineResult: string,
        private readonly txResult: string,
        txHash?: string,
        options?: {
            omitTransactionTypeInAutofill?: boolean;
        },
    ) {
        this.txHash = txHash ?? 'SIMULATED_TX_HASH_001';
        this.options = {
            omitTransactionTypeInAutofill: options?.omitTransactionTypeInAutofill ?? false,
        };
    }

    async autofill(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
        const filled: Record<string, unknown> = {
            ...tx,
            Fee: '12',
            Sequence: 1001,
            LastLedgerSequence: 900100,
        };
        if (this.options.omitTransactionTypeInAutofill) {
            delete filled.TransactionType;
        }
        return filled;
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
            const takerGets = req.taker_gets as Record<string, unknown> | undefined;
            const takerPays = req.taker_pays as Record<string, unknown> | undefined;
            const takerGetsCurrency = typeof takerGets?.currency === 'string' ? takerGets.currency.toUpperCase() : null;
            const takerPaysCurrency = typeof takerPays?.currency === 'string' ? takerPays.currency.toUpperCase() : null;
            const isSellDepthRequest = takerPaysCurrency === 'XRP' && takerGetsCurrency !== 'XRP';
            return {
                result: {
                    offers: isSellDepthRequest
                        ? [
                            {
                                TakerGets: {
                                    currency: 'RLUSD',
                                    issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                                    value: '1.3900',
                                },
                                TakerPays: '1000000',
                            },
                        ]
                        : [
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
        executor.setCurrentMarketContext({
            midPrice: 1.405,
            bestBid: 1.404,
            bestAsk: 1.406,
            spreadBps: 14.23,
            bookAgeMs: 120,
            flowCombined: 0.1,
            flowStrength: 0.2,
            flowRegime: 'quiet',
        });
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
        expect(trade.trace.baseline_best_bid).toBeCloseTo(1.404, 8);
        expect(trade.trace.baseline_best_ask).toBeCloseTo(1.406, 8);
        expect(trade.trace.baseline_mid).toBeCloseTo(1.405, 8);
        expect(trade.trace.baseline_source).toBe('orderbook_snapshot');
        expect(trade.trace.expected_price).toBeCloseTo(1.406, 8);
        expect(trade.trace.expected_rule).toBe('BUY->best_ask');
        expect(trade.trace.price_convention).toBe('quote_per_base');
        expect((trade.trace.baseline_ts_ms as number)).toBeLessThanOrEqual(trade.trace.decision_ts_ms as number);
        expect((trade.trace.decision_ts_ms as number)).toBeLessThanOrEqual(trade.trace.submit_ts_ms as number);
        expect(trade.trace.fill_snapshot).toEqual(expect.objectContaining({
            fill_ts_ms: expect.any(Number),
            filled_base: expect.any(Number),
            filled_quote: expect.any(Number),
            avg_price: expect.any(Number),
        }));
        expect(trade.trace.offer_create).toEqual(expect.objectContaining({
            flags: expect.any(Number),
            takerGets: expect.anything(),
            takerPays: expect.anything(),
            sequence: 1001,
            lastLedgerSequence: 900100,
        }));
        expect((trade.trace.offer_create?.takerGets as Record<string, unknown>).issuer).toBe('[redacted]');
        expect(trade.trace.offer_create?.flags).toBe(0);
    });

    it('returns offer create intent from /api/debug/tx-intent queried by hash', async () => {
        vi.doMock('../../../../lib/localApi', () => ({
            withLocalApi: (handler: Function) => handler,
            logSensitiveAction: vi.fn(),
        }));

        const { OfferExecutor } = await import('../../../../../execution/offerExecutor');
        const node = new SimulatedXrplNode('tesSUCCESS', 'tesSUCCESS', 'SIMULATED_TX_HASH_005');
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

        const debugHandler = (await import('../../debug/tx-intent')).default;
        const req = createMockReq({ hash: node.txHash }) as any;
        const res = createMockRes() as any;
        debugHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({
            tradeId: expect.any(String),
            hash: node.txHash,
            pairKey: 'XRP/RLUSD',
            txType: 'OfferCreate',
        }));
        expect(res.body.offerCreateIntent).toEqual(expect.objectContaining({
            flags: expect.any(Number),
            takerGets: expect.anything(),
            takerPays: expect.anything(),
            sequence: 1001,
            lastLedgerSequence: 900100,
        }));
        expect(res.body.depth_check).toEqual(expect.objectContaining({
            side: 'BUY',
            order_type: 'IOC',
            ledger_index_mode: 'validated',
            request_taker_gets_currency: 'XRP',
            request_taker_pays_currency: 'RLUSD',
        }));
        expect(res.body.offerCreateIntent.takerGets.issuer).toBe('[redacted]');
        expect(res.body.explain).toEqual(expect.objectContaining({
            outcomeCategory: expect.any(String),
            evidence: expect.any(Object),
            recommendedFix: expect.any(String),
        }));
        expect(res.body.explain.evidence.txType).toBe('OfferCreate');
    });

    it('persists offer create intent for SELL rejected trades and returns it from /api/debug/tx-intent by tradeId', async () => {
        vi.doMock('../../../../lib/localApi', () => ({
            withLocalApi: (handler: Function) => handler,
            logSensitiveAction: vi.fn(),
        }));

        const { OfferExecutor } = await import('../../../../../execution/offerExecutor');
        const { tradeHistory } = await import('../../../../../analytics/tradeHistory');
        const node = new SimulatedXrplNode('tecKILLED', 'tecKILLED', 'SIMULATED_TX_HASH_SELL_REJECTED', {
            omitTransactionTypeInAutofill: true,
        });
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
        executor.setCurrentMarketContext({
            midPrice: 1.39,
            bestBid: 1.389,
            bestAsk: 1.391,
            spreadBps: 14.39,
            bookAgeMs: 75,
            flowCombined: 0.03,
            flowStrength: 0.06,
            flowRegime: 'quiet',
        });

        const result = await executor.placeOffer({
            side: 'sell',
            price: 1.39,
            amount: 0.5,
            expectedPrice: 1.39,
            strategy: 'integration-scalper',
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('tecKILLED');
        expect(result.hash).toBe(node.txHash);

        const persisted = tradeHistory.getTradeByHash(node.txHash);
        expect(persisted).toBeTruthy();
        expect(persisted?.side).toBe('SELL');
        expect(persisted?.status).toBe('REJECTED');
        expect(persisted?.trace?.tx_type).toBe('OfferCreate');
        expect(persisted?.trace?.offer_create).toEqual(expect.objectContaining({
            takerGets: expect.anything(),
            takerPays: expect.anything(),
            feeDrops: '12',
            sequence: 1001,
            lastLedgerSequence: 900100,
        }));
        expect((persisted?.trace?.offer_create?.takerPays as Record<string, unknown>).issuer).toBe('[redacted]');

        const debugHandler = (await import('../../debug/tx-intent')).default;
        const req = createMockReq({ tradeId: persisted?.id ?? '' }) as any;
        const res = createMockRes() as any;
        debugHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.txType).toBe('OfferCreate');
        expect(res.body.offerCreateIntent).toEqual(expect.objectContaining({
            takerGets: expect.anything(),
            takerPays: expect.anything(),
            feeDrops: '12',
            sequence: 1001,
            lastLedgerSequence: 900100,
        }));
        expect(res.body.depth_check).toEqual(expect.objectContaining({
            side: 'SELL',
            order_type: 'IOC',
            ledger_index_mode: 'validated',
            request_taker_gets_currency: 'RLUSD',
            request_taker_pays_currency: 'XRP',
        }));
        expect(res.body.offerCreateIntent.takerPays.issuer).toBe('[redacted]');
        expect(res.body.explain).toEqual(expect.objectContaining({
            outcomeCategory: expect.any(String),
            evidence: expect.objectContaining({
                txType: 'OfferCreate',
                txResult: 'tecKILLED',
            }),
            recommendedFix: expect.any(String),
        }));
    });

    it('exposes adaptive/governance/regime data wiring through /api/debug/data-wiring after simulated trade', async () => {
        const prevMarkoutHorizons = process.env.MARKOUT_HORIZONS_S;
        process.env.MARKOUT_HORIZONS_S = '1';
        try {
            vi.doMock('../../../../lib/localApi', () => ({
                withLocalApi: (handler: Function) => handler,
                logSensitiveAction: vi.fn(),
            }));

            const { ObservabilityBus } = await import('../../../../../observability/eventBus');
            const { OfferExecutor } = await import('../../../../../execution/offerExecutor');
            const { tradeMarkoutScheduler } = await import('../../../../../analytics/tradeMarkoutScheduler');
            const { feedbackEngine } = await import('../../../../../analytics/feedbackEngine');

            const bus = new ObservabilityBus({ maxEvents: 500, dedupIntervalMs: 0 });
            const node = new SimulatedXrplNode('tesSUCCESS', 'tesSUCCESS', 'SIMULATED_TX_HASH_004');

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
            executor.setCurrentMarketContext({
                midPrice: 1.405,
                bestBid: 1.404,
                bestAsk: 1.406,
                spreadBps: 14.23,
                bookAgeMs: 150,
                flowCombined: 0.08,
                flowStrength: 0.16,
                flowRegime: 'normal',
            });
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
                        decision_ts_ms: null,
                        baseline_ts_ms: event.baselineTsMs ?? null,
                        baseline_best_bid: event.baselineBestBid ?? null,
                        baseline_best_ask: event.baselineBestAsk ?? null,
                        baseline_mid: event.baselineMid ?? null,
                        baseline_spread_bps: event.baselineSpreadBps ?? null,
                        baseline_source: event.baselineSource ?? null,
                        expected_price: event.expectedPrice ?? null,
                        expected_rule: event.expectedRule ?? null,
                        price_convention: event.priceConvention ?? null,
                        baseline_book_age_ms: event.baselineBookAgeMs ?? null,
                        submit_ts_ms: event.submitTsMs ?? null,
                        submit_response_ts_ms: event.submitResponseTsMs ?? event.ackTsMs ?? null,
                        ack_ts_ms: event.ackTsMs ?? event.submitResponseTsMs ?? null,
                        validated_ts_ms: event.validatedTsMs ?? null,
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
                        trade_id: event.correlationId ?? null,
                        pair: event.pair,
                        side: event.side ?? null,
                        price: event.price,
                        baseAmount: event.baseAmount,
                        quoteAmount: event.quoteAmount,
                        timestamp: event.timestamp,
                    },
                });
            });

            const result = await executor.placeOffer({
                side: 'buy',
                price: 1.41,
                amount: 0.5,
                expectedPrice: 1.41,
                strategy: 'integration-scalper',
            });
            expect(result.accepted).toBe(true);
            expect(result.hash).toBe(node.txHash);

            feedbackEngine.recordSnapshot({
                pairKey: 'XRP/RLUSD',
                ledgerIndex: 900001,
                orderBook: {
                    bids: [{ price: 1.404, quantity: 250, quality: 1, isBuy: true, raw: {} }],
                    asks: [{ price: 1.406, quantity: 250, quality: 1, isBuy: false, raw: {} }],
                    spread: 14.23,
                    lastUpdated: Date.now(),
                },
                flow: null,
            });
            feedbackEngine.flushSnapshots();

            await waitForCondition(
                () => bus.getRecent(200).some((event) =>
                    event.eventType === 'MARKOUT_RECORDED' || event.eventType === 'MARKOUT_MISSING'),
                3000,
                25,
            );

            vi.doMock('../../../../lib/runtimeBridge', () => ({
                getRuntimeInstance: () => ({
                    getObservabilityBus: () => bus,
                }),
            }));

            const debugHandler = (await import('../../debug/data-wiring')).default;
            const req = createMockReq() as any;
            const res = createMockRes() as any;
            debugHandler(req, res);

            expect(res.statusCode).toBe(200);

            expect(res.body.tradeHistory.latestTracePresence).toEqual(expect.objectContaining({
                decision_ts_ms: true,
                submit_ts_ms: true,
                submit_response_ts_ms: true,
                validated_ts_ms: true,
                'fill_snapshot.fill_ts_ms': true,
                baseline_ts_ms: true,
                baseline_best_bid: true,
                baseline_best_ask: true,
                baseline_mid: true,
                baseline_spread_bps: true,
                baseline_source: true,
                baseline_book_age_ms: true,
                expected_price: true,
                expected_rule: true,
                price_convention: true,
                'markouts.0.horizon_s': true,
                'markouts.0.status': true,
                'markouts.0.mark_price': true,
                'markouts.0.markout_bps': true,
                'markouts.0.due_ts_ms': true,
                'markouts.0.mark_ts_ms': true,
            }));

            expect(res.body.runtimeLifecycle.countsByPrefix.SUBMIT_).toBeGreaterThan(0);
            expect(res.body.runtimeLifecycle.countsByPrefix.ORDER_).toBeGreaterThan(0);
            expect(res.body.runtimeLifecycle.countsByPrefix.MARKOUT_).toBeGreaterThan(0);
            expect(res.body.runtimeLifecycle.correlatedCount).toBeGreaterThan(0);
            expect(res.body.runtimeLifecycle.detailTradeIdMatchCount).toBeGreaterThan(0);

            expect(res.body.consumers.adaptiveLearner.receives).toEqual({
                traceFields: 'yes',
                baselineFields: 'yes',
                expectedFields: 'yes',
                markouts: 'yes',
                runtimeLifecycle: 'no',
            });
            expect(res.body.consumers.adaptiveLearner.uses).toEqual({
                traceFields: 'no',
                baselineFields: 'no',
                expectedFields: 'no',
                markouts: 'no',
                runtimeLifecycle: 'no',
            });
            expect(res.body.consumers.adaptiveLearner.sampleTraceKeys).toEqual(
                expect.arrayContaining(['submit_response_ts_ms', 'baseline_ts_ms', 'expected_rule', 'markouts']),
            );

            expect(res.body.consumers.governance.receives).toEqual({
                traceFields: 'no',
                baselineFields: 'no',
                expectedFields: 'no',
                markouts: 'no',
                runtimeLifecycle: 'no',
            });
            expect(res.body.consumers.governance.uses).toEqual({
                traceFields: 'no',
                baselineFields: 'no',
                expectedFields: 'no',
                markouts: 'no',
                runtimeLifecycle: 'no',
            });
            expect(res.body.consumers.governance.decisionInputKeys).toEqual(
                expect.arrayContaining(['profitFactor', 'expectancyBps', 'avgSlippageBps', 'partialFillRate']),
            );

            expect(res.body.consumers.regimeHeatmap.receives).toEqual({
                traceFields: 'no',
                baselineFields: 'no',
                expectedFields: 'no',
                markouts: 'no',
                runtimeLifecycle: 'no',
            });
            expect(res.body.consumers.regimeHeatmap.uses).toEqual({
                traceFields: 'no',
                baselineFields: 'no',
                expectedFields: 'no',
                markouts: 'no',
                runtimeLifecycle: 'no',
            });
            expect(res.body.consumers.regimeHeatmap.heatmapCellKeys).toEqual(
                expect.arrayContaining(['score', 'avgSlippageBps', 'avgSpreadBps', 'trades']),
            );
        } finally {
            if (prevMarkoutHorizons == null) {
                delete process.env.MARKOUT_HORIZONS_S;
            } else {
                process.env.MARKOUT_HORIZONS_S = prevMarkoutHorizons;
            }
        }
    });
});
