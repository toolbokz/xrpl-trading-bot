/**
 * Tests for tradeHistory.getStats() fixes:
 * - Fix A: Dashboard WR/PF works even when trade.pnl is always 0
 * - Fix A: PARTIAL fills included in metrics
 * - Fix D: Epsilon-aware PnL classification
 * - resolveEffectivePnl edge-proxy + fee deduction
 */

import { describe, expect, it } from 'vitest';
import { resolveEffectivePnl, type Trade, type TradeTrace } from '../tradeHistory';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: 'test-1',
        timestamp: Date.now(),
        pair: 'XRP/RLUSD',
        side: 'BUY',
        price: 2.0,
        amount: 10,
        filled: 10,
        fee: 0,
        pnl: 0,
        paper: false,
        status: 'FILLED',
        ...overrides,
    };
}

function makeTrace(overrides: Partial<TradeTrace> = {}): TradeTrace {
    return {
        trade_id: 'test-1',
        decision_ts_ms: Date.now(),
        baseline_ts_ms: null,
        baseline_best_bid: null,
        baseline_best_ask: null,
        baseline_mid: null,
        baseline_spread_bps: null,
        baseline_source: null,
        expected_price: null,
        expected_rule: null,
        price_convention: null,
        baseline_book_age_ms: null,
        submit_ts_ms: null,
        submit_response_ts_ms: null,
        ack_ts_ms: null,
        validated_ts_ms: null,
        validated_ledger_index: null,
        validated_ledger_time: null,
        tx_hash: null,
        tx_type: null,
        node_endpoint: null,
        fee_drops: null,
        sequence: null,
        offer_create: null,
        depth_check: null,
        depth_reprice: null,
        submit_result: null,
        ack_status: 'unknown',
        outcome: 'filled',
        outcome_reason: null,
        retry_attempts: [],
        fill_snapshot: null,
        markouts: [],
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Dashboard bug regression — pnl=0 with trace data
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl', () => {
    it('returns trade.pnl when it is meaningfully non-zero', () => {
        const trade = makeTrade({ pnl: 0.05 });
        expect(resolveEffectivePnl(trade)).toBe(0.05);
    });

    it('returns negative trade.pnl when meaningfully non-zero', () => {
        const trade = makeTrade({ pnl: -0.03 });
        expect(resolveEffectivePnl(trade)).toBe(-0.03);
    });

    it('computes fallback from trace when pnl=0 and trace has mid/fill data', () => {
        // BUY at 1.95 when mid was 2.0 → bought below mid → profit
        const trade = makeTrade({
            pnl: 0,
            side: 'BUY',
            price: 1.95,
            filled: 10,
            trace: makeTrace({
                baseline_mid: 2.0,
                fill_snapshot: {
                    fill_ts_ms: Date.now(),
                    filled_base: 10,
                    filled_quote: 19.5,
                    avg_price: 1.95,
                    fee: null,
                    partial: false,
                    transaction_result: 'tesSUCCESS',
                },
            }),
        });

        const pnl = resolveEffectivePnl(trade);
        expect(pnl).not.toBeNull();
        // Edge = (2.0 - 1.95) * 10 = 0.5 quote profit
        expect(pnl!).toBeGreaterThan(0);
        expect(pnl!).toBeCloseTo(0.5, 1);
    });

    it('computes fallback for SELL with edge above mid', () => {
        // SELL at 2.05 when mid was 2.0 → sold above mid → profit
        const trade = makeTrade({
            pnl: 0,
            side: 'SELL',
            price: 2.05,
            filled: 10,
            trace: makeTrace({
                baseline_mid: 2.0,
                fill_snapshot: {
                    fill_ts_ms: Date.now(),
                    filled_base: 10,
                    filled_quote: 20.5,
                    avg_price: 2.05,
                    fee: null,
                    partial: false,
                    transaction_result: 'tesSUCCESS',
                },
            }),
        });

        const pnl = resolveEffectivePnl(trade);
        expect(pnl).not.toBeNull();
        expect(pnl!).toBeGreaterThan(0);
        expect(pnl!).toBeCloseTo(0.5, 1);
    });

    it('returns null when insufficient data (no trace, pnl=0)', () => {
        const trade = makeTrade({ pnl: 0 });
        expect(resolveEffectivePnl(trade)).toBeNull();
    });

    it('returns null when trace exists but no mid price', () => {
        const trade = makeTrade({
            pnl: 0,
            trace: makeTrace({
                baseline_mid: null,
                fill_snapshot: {
                    fill_ts_ms: Date.now(),
                    filled_base: 10,
                    filled_quote: 19.5,
                    avg_price: 1.95,
                    fee: null,
                    partial: false,
                    transaction_result: 'tesSUCCESS',
                },
            }),
        });

        expect(resolveEffectivePnl(trade)).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test 4: Fees flip classification
    // ─────────────────────────────────────────────────────────────────────

    it('fees can flip a gross winner to net loser', () => {
        // BUY at 1.999 when mid = 2.0 → tiny edge of 0.01 * 10 = 0.1 quote
        // TX fee = 12 drops = 0.000012 XRP → 0.000012 * 1.999 ≈ tiny
        // But fill_snapshot.fee = 0.15 (larger than edge!)
        const trade = makeTrade({
            pnl: 0,
            side: 'BUY',
            price: 1.999,
            filled: 10,
            trace: makeTrace({
                baseline_mid: 2.0,
                fee_drops: '12',
                fill_snapshot: {
                    fill_ts_ms: Date.now(),
                    filled_base: 10,
                    filled_quote: 19.99,
                    avg_price: 1.999,
                    fee: 0.15,
                    partial: false,
                    transaction_result: 'tesSUCCESS',
                },
            }),
        });

        const pnl = resolveEffectivePnl(trade);
        expect(pnl).not.toBeNull();
        // Gross edge = (2.0 - 1.999) * 10 = 0.01 quote
        // Fee = max(0.000012 * 1.999, 0.15) = 0.15
        // Net = 0.01 - 0.15 = -0.14
        expect(pnl!).toBeLessThan(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test 2: PARTIAL fills contribute
    // ─────────────────────────────────────────────────────────────────────

    it('PARTIAL fill with enough trace data has classifiable PnL', () => {
        const trade = makeTrade({
            pnl: 0,
            status: 'PARTIAL',
            filled: 5, // only 5 of 10 filled
            trace: makeTrace({
                baseline_mid: 2.0,
                fill_snapshot: {
                    fill_ts_ms: Date.now(),
                    filled_base: 5,
                    filled_quote: 9.7,
                    avg_price: 1.94,
                    fee: null,
                    partial: true,
                    transaction_result: 'tesSUCCESS',
                },
            }),
        });

        const pnl = resolveEffectivePnl(trade);
        expect(pnl).not.toBeNull();
        // BUY at 1.94 vs mid 2.0 → edge = (2.0 - 1.94) * 5 = 0.3
        expect(pnl!).toBeGreaterThan(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test 3: Non-execution excluded
    // ─────────────────────────────────────────────────────────────────────

    it('REJECTED trade with pnl=0 returns null', () => {
        const trade = makeTrade({ pnl: 0, status: 'REJECTED' });
        // resolveEffectivePnl still returns null because there's no trace data,
        // but getStats() would exclude REJECTED from the denominator entirely.
        expect(resolveEffectivePnl(trade)).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Epsilon edge cases for resolveEffectivePnl
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl epsilon edge cases', () => {
    it('uses trade.pnl directly when beyond epsilon', () => {
        const trade = makeTrade({ pnl: 1e-8 }); // > PNL_EPSILON = 1e-9
        expect(resolveEffectivePnl(trade)).toBe(1e-8);
    });

    it('falls through to trace when pnl is at epsilon', () => {
        const trade = makeTrade({ pnl: 1e-9 }); // === PNL_EPSILON
        // Should try trace fallback; null since no trace
        expect(resolveEffectivePnl(trade)).toBeNull();
    });
});
