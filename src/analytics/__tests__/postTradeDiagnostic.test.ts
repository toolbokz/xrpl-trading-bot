import { describe, it, expect } from 'vitest';
import {
    buildPostTradeDiagnostic,
    buildDiagnosticsForTrades,
    type DiagnosticTradeInput,
} from '../postTradeDiagnostic';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Fixtures                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** BUY FILLED — clean spread cross (fill ≈ best_ask) */
const buyFilled: DiagnosticTradeInput = {
    id: 'buy-filled-001',
    pair: 'XRP/RLUSD',
    side: 'BUY',
    status: 'FILLED',
    timestamp: 1700000000000,
    amount: 1,
    amountBase: 1,
    filled: 1,
    filledBase: 1,
    filledQuote: 1.328,
    priceQuotePerBase: 1.328,
    fee: 0.000012,
    hash: 'AABB11',
    slippageBps: 0.5,
    trace: {
        trade_id: 'buy-filled-001',
        decision_ts_ms: 1700000000000,
        submit_ts_ms: 1700000000050,
        ack_ts_ms: 1700000000120,
        validated_ts_ms: 1700000005000,
        baseline_best_bid: 1.327,
        baseline_best_ask: 1.328,
        baseline_mid: 1.3275,
        baseline_spread_bps: 7.5,
        tx_hash: 'AABB11',
        sequence: 100,
        depth_check: {
            side: 'BUY',
            required_base: 1,
            min_required_base: 0.5,
            fillable_base: 1,
            vwap: 1.3281,
            worst_price: 1.329,
            limit_price: 1.328,
            has_depth: true,
            order_type: 'IOC',
        },
        depth_reprice: {
            decision: 'not_needed',
            repriced_price: null,
            required_reprice_bps: null,
        },
        submit_result: {
            engine_result: 'tesSUCCESS',
            engine_result_code: 0,
            engine_result_message: 'The transaction was applied.',
        },
        ack_status: 'accepted',
        outcome: 'filled',
        outcome_reason: null,
        retry_attempts: [],
        fill_snapshot: {
            filled_base: 1,
            filled_quote: 1.328,
            avg_price: 1.328,
            fee: 0.000012,
            partial: false,
        },
        markouts: [
            { horizon_s: 60, markout_bps: 2.1, status: 'recorded' },
            { horizon_s: 300, markout_bps: -1.0, status: 'recorded' },
        ],
    },
};

/** BUY REJECTED — pre-submit bot abort (below min size) */
const buyRejectedPreSubmit: DiagnosticTradeInput = {
    id: 'buy-reject-presub',
    pair: 'XRP/RLUSD',
    side: 'BUY',
    status: 'REJECTED',
    timestamp: 1700000001000,
    amount: 0.05,
    amountBase: 0.05,
    filled: 0,
    filledBase: 0,
    filledQuote: 0,
    fee: 0,
    trace: {
        trade_id: 'buy-reject-presub',
        decision_ts_ms: 1700000001000,
        // No submit_ts_ms — never submitted to XRPL
        baseline_best_bid: 1.327,
        baseline_best_ask: 1.328,
        baseline_mid: 1.3275,
        baseline_spread_bps: 7.5,
        outcome: 'skipped',
        outcome_reason: 'ABORT_BELOW_MIN: order size 0.05 < minimum 0.25',
        ack_status: 'unknown',
        retry_attempts: [],
        markouts: [],
    },
};

/** SELL REJECTED — XRPL tecKILLED (IOC no fill) */
const sellRejectedTecKilled: DiagnosticTradeInput = {
    id: 'sell-killed-001',
    pair: 'XRP/RLUSD',
    side: 'SELL',
    status: 'REJECTED',
    timestamp: 1700000002000,
    amount: 0.7,
    amountBase: 0.7,
    filled: 0,
    filledBase: 0,
    filledQuote: 0,
    fee: 0,
    hash: 'CC1122',
    trace: {
        trade_id: 'sell-killed-001',
        decision_ts_ms: 1700000002000,
        submit_ts_ms: 1700000002050,
        ack_ts_ms: 1700000002120,
        validated_ts_ms: 1700000007000,
        baseline_best_bid: 1.327,
        baseline_best_ask: 1.328,
        baseline_mid: 1.3275,
        baseline_spread_bps: 7.5,
        tx_hash: 'CC1122',
        sequence: 101,
        depth_check: {
            side: 'SELL',
            required_base: 0.7,
            min_required_base: 0.35,
            fillable_base: 0.7,
            vwap: 1.327,
            worst_price: 1.326,
            has_depth: true,
            order_type: 'IOC',
        },
        submit_result: {
            engine_result: 'tecKILLED',
            engine_result_code: 150,
            engine_result_message: 'No funds transferred and no offer created.',
        },
        ack_status: 'rejected',
        outcome: 'rejected',
        outcome_reason: 'tecKILLED',
        retry_attempts: [
            { attempt_n: 1, engine_result: 'tecKILLED', classified_outcome: 'NO_FILL' },
        ],
        fill_snapshot: null,
        markouts: [],
    },
};

/** SELL PARTIAL — after repricing */
const sellPartial: DiagnosticTradeInput = {
    id: 'sell-partial-001',
    pair: 'XRP/RLUSD',
    side: 'SELL',
    status: 'PARTIAL',
    timestamp: 1700000003000,
    amount: 2,
    amountBase: 2,
    filled: 1.2,
    filledBase: 1.2,
    filledQuote: 1.592,
    fee: 0.000012,
    hash: 'DD3344',
    trace: {
        trade_id: 'sell-partial-001',
        decision_ts_ms: 1700000003000,
        submit_ts_ms: 1700000003080,
        ack_ts_ms: 1700000003200,
        validated_ts_ms: 1700000008000,
        baseline_best_bid: 1.327,
        baseline_best_ask: 1.328,
        baseline_mid: 1.3275,
        baseline_spread_bps: 7.5,
        tx_hash: 'DD3344',
        sequence: 102,
        depth_check: {
            side: 'SELL',
            required_base: 2,
            min_required_base: 1,
            fillable_base: 1.5,
            vwap: 1.326,
            worst_price: 1.325,
            has_depth: true,
            order_type: 'IOC',
        },
        depth_reprice: {
            decision: 'reprice',
            repriced_price: 1.3265,
            required_reprice_bps: 3.7,
        },
        submit_result: {
            engine_result: 'tesSUCCESS',
            engine_result_code: 0,
            engine_result_message: 'The transaction was applied.',
        },
        ack_status: 'accepted',
        outcome: 'partial',
        outcome_reason: 'partial_fill_ioc',
        retry_attempts: [
            { attempt_n: 1, engine_result: 'tesSUCCESS', classified_outcome: 'PARTIAL' },
        ],
        fill_snapshot: {
            filled_base: 1.2,
            filled_quote: 1.592,
            avg_price: 1.3267,
            fee: 0.000012,
            partial: true,
        },
        markouts: [],
    },
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tests                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('buildPostTradeDiagnostic', () => {
    describe('BUY FILLED — clean spread cross', () => {
        const diag = buildPostTradeDiagnostic(buyFilled);

        it('classifies eventBucket as XRPL_FILLED', () => {
            expect(diag.eventBucket).toBe('XRPL_FILLED');
        });

        it('classifies primaryCause as CLEAN_SPREAD_CROSS (fill ≈ arrival)', () => {
            // avgFillPrice = 1.328, baseline_best_ask = 1.328 → 0 bps
            expect(diag.primaryCause).toBe('CLEAN_SPREAD_CROSS');
        });

        it('computes side-aware priceVsArrivalBps for BUY', () => {
            // BUY: (avgFill - best_ask) / best_ask * 10000
            // (1.328 - 1.328) / 1.328 * 10000 = 0
            expect(diag.priceVsArrivalBps).toBeCloseTo(0, 1);
        });

        it('computes distanceFromMidBps for BUY', () => {
            // (1.328 - 1.3275) / 1.3275 * 10000 ≈ 3.77 bps
            expect(diag.distanceFromMidBps).toBeCloseTo(3.77, 0);
        });

        it('computes fillVsPredVwapBps for BUY', () => {
            // (1.328 - 1.3281) / 1.3281 * 10000 ≈ -0.75 bps
            expect(diag.fillVsPredVwapBps).toBeCloseTo(-0.75, 0);
        });

        it('computes predFillRatio', () => {
            expect(diag.predFillRatio).toBeCloseTo(1.0, 4);
        });

        it('computes actualFillRatio', () => {
            expect(diag.actualFillRatio).toBeCloseTo(1.0, 4);
        });

        it('computes predictedVsActualFillRatioGap', () => {
            expect(diag.predictedVsActualFillRatioGap).toBeCloseTo(0, 4);
        });

        it('extracts timing metrics', () => {
            expect(diag.decisionToSubmitMs).toBe(50);
            expect(diag.submitToAckMs).toBe(70);
            expect(diag.ackToValidatedMs).toBe(4880);
            expect(diag.decisionToValidatedMs).toBe(5000);
        });

        it('extracts markouts', () => {
            expect(diag.markout60sBps).toBeCloseTo(2.1, 1);
            expect(diag.markout60sStatus).toBe('recorded');
            expect(diag.markout300sBps).toBeCloseTo(-1.0, 1);
        });

        it('classifies spreadRegime as NORMAL', () => {
            expect(diag.spreadRegime).toBe('NORMAL');
        });

        it('populates engine result', () => {
            expect(diag.engineResult).toBe('tesSUCCESS');
        });
    });

    describe('BUY REJECTED — pre-submit (ABORT_BELOW_MIN)', () => {
        const diag = buildPostTradeDiagnostic(buyRejectedPreSubmit);

        it('classifies eventBucket as PRE_SUBMIT_REJECT', () => {
            expect(diag.eventBucket).toBe('PRE_SUBMIT_REJECT');
        });

        it('classifies primaryCause as BOT_MIN_SIZE', () => {
            expect(diag.primaryCause).toBe('BOT_MIN_SIZE');
        });

        it('has no fill metrics', () => {
            expect(diag.avgFillPriceQpb).toBeNull();
            expect(diag.priceVsArrivalBps).toBeNull();
            expect(diag.filledBase).toBe(0);
            expect(diag.actualFillRatio).toBe(0);
        });

        it('has no timing beyond decision', () => {
            expect(diag.decisionToSubmitMs).toBeNull();
            expect(diag.submitToAckMs).toBeNull();
        });

        it('includes a note about min size reject', () => {
            expect(diag.notes.some(n => n.toLowerCase().includes('minimum'))).toBe(true);
        });
    });

    describe('SELL REJECTED — tecKILLED IOC no fill', () => {
        const diag = buildPostTradeDiagnostic(sellRejectedTecKilled);

        it('classifies eventBucket as XRPL_NO_FILL', () => {
            expect(diag.eventBucket).toBe('XRPL_NO_FILL');
        });

        it('classifies primaryCause as IOC_NO_MATCH_AT_LIMIT', () => {
            expect(diag.primaryCause).toBe('IOC_NO_MATCH_AT_LIMIT');
        });

        it('records retryCount', () => {
            expect(diag.retryCount).toBe(1);
        });

        it('has no fill quality metrics', () => {
            expect(diag.priceVsArrivalBps).toBeNull();
            expect(diag.avgFillPriceQpb).toBeNull();
        });

        it('records engine result', () => {
            expect(diag.engineResult).toBe('tecKILLED');
            expect(diag.engineResultCode).toBe(150);
        });
    });

    describe('SELL PARTIAL — after repricing', () => {
        const diag = buildPostTradeDiagnostic(sellPartial);

        it('classifies eventBucket as XRPL_PARTIAL', () => {
            expect(diag.eventBucket).toBe('XRPL_PARTIAL');
        });

        it('classifies primaryCause as PARTIAL_LIQUIDITY', () => {
            expect(diag.primaryCause).toBe('PARTIAL_LIQUIDITY');
        });

        it('computes side-aware priceVsArrivalBps for SELL', () => {
            // SELL: (baseline_best_bid - avgFill) / baseline_best_bid * 10000
            // avgFill from fill_snapshot: 1.592 / 1.2 = 1.3267
            // (1.327 - 1.3267) / 1.327 * 10000 ≈ 2.26 bps
            expect(diag.priceVsArrivalBps).toBeCloseTo(2.26, 0);
        });

        it('computes actualFillRatio for partial', () => {
            // 1.2 / 2 = 0.6
            expect(diag.actualFillRatio).toBeCloseTo(0.6, 4);
        });

        it('computes predFillRatio', () => {
            // 1.5 / 2 = 0.75
            expect(diag.predFillRatio).toBeCloseTo(0.75, 4);
        });

        it('computes predictedVsActualFillRatioGap', () => {
            // 0.6 - 0.75 = -0.15
            expect(diag.predictedVsActualFillRatioGap).toBeCloseTo(-0.15, 4);
        });

        it('records reprice decision', () => {
            expect(diag.repriceDecision).toBe('reprice');
            expect(diag.repricedPrice).toBeCloseTo(1.3265, 4);
            expect(diag.requiredRepriceBps).toBeCloseTo(3.7, 1);
        });

        it('includes partial fill note', () => {
            expect(diag.notes.some(n => n.includes('Partial fill'))).toBe(true);
        });
    });

    describe('null safety — missing trace', () => {
        const bare: DiagnosticTradeInput = {
            id: 'bare-001',
            side: 'BUY',
            status: 'REJECTED',
            timestamp: 1700000000000,
        };

        it('does not crash with missing trace', () => {
            const diag = buildPostTradeDiagnostic(bare);
            expect(diag.tradeId).toBe('bare-001');
            expect(diag.eventBucket).toBe('PRE_SUBMIT_REJECT');
        });

        it('returns null for all optional fields', () => {
            const diag = buildPostTradeDiagnostic(bare);
            expect(diag.baselineBestBid).toBeNull();
            expect(diag.avgFillPriceQpb).toBeNull();
            expect(diag.decisionToSubmitMs).toBeNull();
            expect(diag.markout60sBps).toBeNull();
            expect(diag.spreadRegime).toBeNull();
        });
    });

    describe('spread regime classification', () => {
        it('classifies TIGHT (<=3 bps)', () => {
            const trade = { ...buyFilled, trace: { ...buyFilled.trace!, baseline_spread_bps: 2.5 } };
            expect(buildPostTradeDiagnostic(trade).spreadRegime).toBe('TIGHT');
        });

        it('classifies NORMAL (<=10 bps)', () => {
            const trade = { ...buyFilled, trace: { ...buyFilled.trace!, baseline_spread_bps: 8 } };
            expect(buildPostTradeDiagnostic(trade).spreadRegime).toBe('NORMAL');
        });

        it('classifies WIDE (>10 bps)', () => {
            const trade = { ...buyFilled, trace: { ...buyFilled.trace!, baseline_spread_bps: 15 } };
            expect(buildPostTradeDiagnostic(trade).spreadRegime).toBe('WIDE');
        });
    });
});

describe('buildDiagnosticsForTrades — last-10 selector', () => {
    it('caps output at 10 items', () => {
        const trades: DiagnosticTradeInput[] = Array.from({ length: 25 }, (_, i) => ({
            id: `t-${i}`,
            side: 'BUY',
            status: 'FILLED',
            timestamp: 1700000000000 + i * 1000,
        }));
        const result = buildDiagnosticsForTrades(trades, 10);
        expect(result).toHaveLength(10);
    });

    it('returns newest first', () => {
        const trades: DiagnosticTradeInput[] = [
            { id: 'old', side: 'BUY', status: 'FILLED', timestamp: 1700000000000 },
            { id: 'new', side: 'BUY', status: 'FILLED', timestamp: 1700000099000 },
            { id: 'mid', side: 'BUY', status: 'FILLED', timestamp: 1700000050000 },
        ];
        const result = buildDiagnosticsForTrades(trades, 10);
        expect(result[0].tradeId).toBe('new');
        expect(result[1].tradeId).toBe('mid');
        expect(result[2].tradeId).toBe('old');
    });

    it('returns fewer than 10 if fewer trades exist', () => {
        const trades: DiagnosticTradeInput[] = [
            { id: 'only', side: 'SELL', status: 'REJECTED', timestamp: 1700000000000 },
        ];
        const result = buildDiagnosticsForTrades(trades, 10);
        expect(result).toHaveLength(1);
    });

    it('returns empty array for empty input', () => {
        expect(buildDiagnosticsForTrades([], 10)).toHaveLength(0);
    });
});
