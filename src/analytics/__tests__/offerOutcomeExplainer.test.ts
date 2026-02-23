import { describe, expect, it } from 'vitest';
import { explainOfferOutcome, computeImpliedOfferPriceQuotePerBase } from '../offerOutcomeExplainer';
import type { TradeTrace } from '../tradeHistory';

function buildTrace(overrides: Partial<TradeTrace>): TradeTrace {
    return {
        trade_id: 'trade-1',
        decision_ts_ms: 1,
        baseline_ts_ms: 1,
        baseline_best_bid: 1.399,
        baseline_best_ask: 1.401,
        baseline_mid: 1.4,
        baseline_spread_bps: 14.28,
        baseline_source: 'orderbook_snapshot',
        expected_price: 1.4,
        expected_rule: 'BUY->best_ask',
        price_convention: 'quote_per_base',
        baseline_book_age_ms: 10,
        submit_ts_ms: 2,
        submit_response_ts_ms: 3,
        ack_ts_ms: 3,
        validated_ts_ms: 4,
        validated_ledger_index: 10,
        validated_ledger_time: 5,
        tx_hash: 'HASH',
        tx_type: 'OfferCreate',
        node_endpoint: 'wss://example',
        fee_drops: '12',
        sequence: 100,
        offer_create: {
            flags: 0,
            flagsDecoded: [],
            takerGets: {
                currency: 'RLUSD',
                issuer: '[redacted]',
                value: '0.7000',
            },
            takerPays: '500000',
            feeDrops: '12',
            sequence: 100,
            lastLedgerSequence: 200,
        },
        depth_check: {
            side: 'BUY',
            intended_price: 1.4,
            required_base: 0.5,
            min_required_base: 0.5,
            fillable_base: 0.5,
            has_depth: true,
            ioc_min_fill_ratio: 1,
            depth_check_levels: 5,
            order_type: 'IOC',
        },
        depth_reprice: null,
        submit_result: {
            engine_result: 'tecKILLED',
            engine_result_code: 150,
            engine_result_message: 'No funds transferred and no offer created.',
        },
        ack_status: 'rejected',
        outcome: 'rejected',
        outcome_reason: 'tecKILLED',
        fill_snapshot: null,
        markouts: [],
        ...overrides,
    };
}

describe('offerOutcomeExplainer', () => {
    it('classifies execution-min-order-sanity rejects as MIN_ORDER_SANITY', () => {
        const trace = buildTrace({
            submit_result: {
                engine_result: null,
                engine_result_code: null,
                engine_result_message: 'execution-min-order-sanity:xrp-drops-underflow',
            },
            outcome_reason: 'execution-min-order-sanity',
            offer_create: {
                flags: 0,
                flagsDecoded: [],
                takerGets: {
                    currency: 'RLUSD',
                    issuer: '[redacted]',
                    value: '0.000000000000000001',
                },
                takerPays: '0',
                feeDrops: '12',
                sequence: 100,
                lastLedgerSequence: 200,
            },
        });

        const explain = explainOfferOutcome({ trace, side: 'BUY' });
        expect(explain?.outcomeCategory).toBe('MIN_ORDER_SANITY');
        expect(explain?.rootCause).toBe('EXECUTION_MIN_ORDER_SANITY');
    });

    it('classifies tecKILLED with missing offer_create as missing intent trace', () => {
        const trace = buildTrace({
            tx_type: null,
            offer_create: null,
            depth_check: {
                side: 'BUY',
                intended_price: 1.4,
                required_base: 0.5,
                min_required_base: 0.5,
                fillable_base: 1,
                has_depth: true,
                ioc_min_fill_ratio: 1,
                depth_check_levels: 5,
                order_type: 'IOC',
            },
        });

        const explain = explainOfferOutcome({ trace, side: 'BUY' });
        expect(explain?.outcomeCategory).toBe('MISSING_INTENT_TRACE');
        expect(explain?.rootCause).toBe('MISSING_OFFER_CREATE_INTENT');
        expect(explain?.evidence.offerCreateMissing).toBe(true);
    });

    it('does not classify tecKILLED as insufficient liquidity when depth_check is missing', () => {
        const trace = buildTrace({
            depth_check: null,
            offer_create: {
                flags: 0,
                flagsDecoded: ['IOC'],
                takerGets: {
                    currency: 'RLUSD',
                    issuer: '[redacted]',
                    value: '0.7000',
                },
                takerPays: '500000',
                feeDrops: '12',
                sequence: 100,
                lastLedgerSequence: 200,
            },
        });

        const explain = explainOfferOutcome({ trace, side: 'BUY' });
        expect(explain?.outcomeCategory).toBe('MISSING_DEPTH_EVIDENCE');
        expect(explain?.rootCause).toBe('MISSING_DEPTH_CHECK');
        expect(explain?.outcomeCategory).not.toBe('INSUFFICIENT_LIQUIDITY_AT_PRICE');
    });

    it('classifies tecKILLED with insufficient depth as liquidity-at-price', () => {
        const trace = buildTrace({
            depth_check: {
                side: 'BUY',
                intended_price: 1.4,
                required_base: 0.5,
                min_required_base: 0.5,
                fillable_base: 0.2,
                has_depth: false,
                ioc_min_fill_ratio: 1,
                depth_check_levels: 5,
                order_type: 'IOC',
            },
        });

        const explain = explainOfferOutcome({ trace, side: 'BUY' });
        expect(explain?.outcomeCategory).toBe('INSUFFICIENT_LIQUIDITY_AT_PRICE');
    });

    it('classifies tecKILLED with large implied-price mismatch as rounding/min amount', () => {
        const trace = buildTrace({
            depth_check: {
                side: 'BUY',
                intended_price: 1.4,
                required_base: 0.5,
                min_required_base: 0.5,
                fillable_base: 1.0,
                has_depth: true,
                ioc_min_fill_ratio: 1,
                depth_check_levels: 5,
                order_type: 'IOC',
            },
            offer_create: {
                flags: 0,
                flagsDecoded: [],
                takerGets: {
                    currency: 'RLUSD',
                    issuer: '[redacted]',
                    value: '1.5000',
                },
                takerPays: '500000',
                feeDrops: '12',
                sequence: 100,
                lastLedgerSequence: 200,
            },
        });

        const explain = explainOfferOutcome({ trace, side: 'BUY' });
        expect(explain?.outcomeCategory).toBe('ROUNDING_OR_MINIMUM_AMOUNT');
    });

    it('maps trustline-related failures to balance/trustline category', () => {
        const trace = buildTrace({
            submit_result: {
                engine_result: 'tecNO_LINE',
                engine_result_code: 122,
                engine_result_message: 'No trustline',
            },
            outcome_reason: 'tecNO_LINE',
        });

        const explain = explainOfferOutcome({ trace, side: 'SELL' });
        expect(explain?.outcomeCategory).toBe('BALANCE_OR_TRUSTLINE');
    });

    it('classifies successful repriced fills as DEPTH_REPRICE_APPLIED', () => {
        const trace = buildTrace({
            submit_result: {
                engine_result: 'tesSUCCESS',
                engine_result_code: 0,
                engine_result_message: 'The transaction was applied.',
            },
            outcome: 'filled',
            outcome_reason: null,
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
        });

        const explain = explainOfferOutcome({ trace, side: 'BUY' });
        expect(explain?.outcomeCategory).toBe('DEPTH_REPRICE_APPLIED');
        expect(explain?.rootCause).toBeNull();
    });

    it('tags depth reprice over-budget rejects with explicit root cause', () => {
        const trace = buildTrace({
            submit_result: {
                engine_result: null,
                engine_result_code: null,
                engine_result_message: 'depth-reprice-over-budget',
            },
            outcome_reason: 'depth-reprice-over-budget',
            depth_reprice: {
                enabled: true,
                intended_price: 1.4,
                repriced_price: null,
                required_reprice_bps: 4.5,
                min_required_base: 0.5,
                fillable_base_at_intended: 0.2,
                fillable_base_at_repriced: 0.7,
                decision: 'skipped_over_budget',
                max_reprice_bps: 3,
            },
        });

        const explain = explainOfferOutcome({ trace, side: 'BUY' });
        expect(explain?.outcomeCategory).toBe('INSUFFICIENT_LIQUIDITY_AT_PRICE');
        expect(explain?.rootCause).toBe('DEPTH_REPRICE_OVER_BUDGET');
    });

    it('computes implied quote-per-base price for both sides', () => {
        const offerCreateIntent = {
            flags: 0,
            flagsDecoded: [],
            takerGets: {
                currency: 'RLUSD',
                issuer: '[redacted]',
                value: '0.7000',
            },
            takerPays: '500000',
            feeDrops: '12',
            sequence: 100,
            lastLedgerSequence: 200,
        };

        const impliedBuy = computeImpliedOfferPriceQuotePerBase({ offerCreateIntent, side: 'BUY' });
        expect(impliedBuy).toBeCloseTo(1.4, 8);

        const impliedSell = computeImpliedOfferPriceQuotePerBase({
            offerCreateIntent: {
                ...offerCreateIntent,
                takerGets: '500000',
                takerPays: {
                    currency: 'RLUSD',
                    issuer: '[redacted]',
                    value: '0.7000',
                },
            },
            side: 'SELL',
        });
        expect(impliedSell).toBeCloseTo(1.4, 8);
    });
});
