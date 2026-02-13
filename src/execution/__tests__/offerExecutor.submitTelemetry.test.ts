import { describe, expect, it, vi } from 'vitest';
import { OfferExecutor } from '../offerExecutor';
import { applySubmitTelemetryToFunnel, createStrategyDecisionFunnel, type StrategySubmitTelemetryEvent } from '../../observability/strategyDecisionFunnel';
import type { TradingPair } from '../../config';

describe('OfferExecutor submit telemetry sink', () => {
    it('updates funnel counters for submit attempt/success/fail', async () => {
        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        };

        const client = {
            autofill: vi.fn().mockImplementation(async (tx: any) => ({
                ...tx,
                Fee: '12',
                Sequence: 1,
            })),
            submitAndWait: vi.fn()
                .mockResolvedValueOnce({
                    result: {
                        hash: 'ABC123',
                        meta: {
                            TransactionResult: 'tesSUCCESS',
                            AffectedNodes: [],
                        },
                        tx_json: {},
                        ledger_index: 100,
                    },
                })
                .mockResolvedValueOnce({
                    result: {
                        hash: 'DEF456',
                        meta: {
                            TransactionResult: 'tecUNFUNDED_OFFER',
                        },
                        tx_json: {},
                        ledger_index: 101,
                    },
                }),
        } as any;

        const wallet = {
            classicAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            sign: vi.fn().mockReturnValue({
                tx_blob: 'DEADBEEF',
                hash: 'SIGNED_HASH',
            }),
        } as any;

        const risk = {
            registerFailure: vi.fn(),
            resetFailures: vi.fn(),
        } as any;

        const executor = new OfferExecutor(client, wallet, risk, false, pair, undefined);
        executor.setCurrentStrategy('orderbook-scalper');

        const events: StrategySubmitTelemetryEvent[] = [];
        const funnelByStrategy: Record<string, ReturnType<typeof createStrategyDecisionFunnel>> = {};

        executor.setSubmitTelemetrySink((event) => {
            events.push(event);
            if (!funnelByStrategy[event.strategy]) {
                funnelByStrategy[event.strategy] = createStrategyDecisionFunnel();
            }
            applySubmitTelemetryToFunnel(funnelByStrategy[event.strategy]!, event);
        });

        const successResult = await executor.cancelOffer(1);
        const failResult = await executor.cancelOffer(2);

        expect(successResult.accepted).toBe(true);
        expect(failResult.accepted).toBe(false);
        expect(failResult.reason).toBe('tecUNFUNDED_OFFER');

        expect(events.map((e) => e.stage)).toEqual(['attempt', 'success', 'attempt', 'fail']);

        const funnel = funnelByStrategy['orderbook-scalper']!;
        expect(funnel.submitAttemptCount).toBe(2);
        expect(funnel.submitSuccessCount).toBe(1);
        expect(funnel.submitFailCount).toBe(1);
        expect(funnel.lastTxHash).toBe('ABC123');
        expect(funnel.lastSubmitError).toBe('tecUNFUNDED_OFFER');
    });
});
