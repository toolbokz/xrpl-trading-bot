/**
 * Tests for WebTradeHistoryService.getStats() fixes:
 *
 * Fix A: Dashboard WR/PF works even when trade.pnl is always 0
 * Fix A: PARTIAL fills included in metrics
 * Fix D: Epsilon-aware PnL classification
 * Fix E: Diagnostics on poor classifiability
 *
 * These test the UI-side tradeHistory module that serves the /api/bot/trades
 * endpoint, which is the primary source of dashboard WR/PnL statistics.
 */

import { describe, expect, it } from 'vitest';
import { resolveEffectivePnl, type Trade, type TradeTrace } from '../tradeHistory';
import { PNL_EPSILON, classifyPnl } from '../../../analytics/metricUtils';

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

describe('resolveEffectivePnl (web side)', () => {
    it('returns trade.pnl when meaningfully non-zero', () => {
        expect(resolveEffectivePnl(makeTrade({ pnl: 0.05 }))).toBe(0.05);
        expect(resolveEffectivePnl(makeTrade({ pnl: -0.03 }))).toBe(-0.03);
    });

    it('computes fallback from trace when pnl=0 - BUY below mid', () => {
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

    it('computes fallback for SELL above mid', () => {
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
        expect(resolveEffectivePnl(makeTrade({ pnl: 0 }))).toBeNull();
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
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: PARTIAL fills contribute
// ─────────────────────────────────────────────────────────────────────────────

describe('PARTIAL fills (web side)', () => {
    it('PARTIAL fill with trace data has classifiable PnL', () => {
        const trade = makeTrade({
            pnl: 0,
            status: 'PARTIAL',
            filled: 5,
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
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Non-executed excluded
// ─────────────────────────────────────────────────────────────────────────────

describe('Non-execution exclusion (web side)', () => {
    it('REJECTED trade with pnl=0 returns null from resolveEffectivePnl', () => {
        const trade = makeTrade({ pnl: 0, status: 'REJECTED' });
        expect(resolveEffectivePnl(trade)).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Fees flip classification
// ─────────────────────────────────────────────────────────────────────────────

describe('Fee deduction in resolveEffectivePnl (web side)', () => {
    it('fees from fill_snapshot.fee can flip gross winner to net loser', () => {
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

    it('tx fee in drops is correctly converted via fillPrice', () => {
        const trade = makeTrade({
            pnl: 0,
            side: 'BUY',
            price: 2.0,
            filled: 100,
            trace: makeTrace({
                baseline_mid: 2.1,
                fee_drops: '120000', // 0.12 XRP
                fill_snapshot: {
                    fill_ts_ms: Date.now(),
                    filled_base: 100,
                    filled_quote: 200,
                    avg_price: 2.0,
                    fee: null,
                    partial: false,
                    transaction_result: 'tesSUCCESS',
                },
            }),
        });

        const pnl = resolveEffectivePnl(trade);
        expect(pnl).not.toBeNull();
        // Gross edge = (2.1 - 2.0) * 100 = 10.0 quote
        // Fee = 0.12 XRP * 2.0 = 0.24 quote
        // Net ≈ 9.76
        expect(pnl!).toBeCloseTo(9.76, 1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Epsilon edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Epsilon classification (web side)', () => {
    it('uses trade.pnl directly when beyond epsilon', () => {
        expect(resolveEffectivePnl(makeTrade({ pnl: 1e-8 }))).toBe(1e-8);
    });

    it('falls through to trace when pnl is at epsilon', () => {
        const trade = makeTrade({ pnl: 1e-9 }); // === PNL_EPSILON
        expect(resolveEffectivePnl(trade)).toBeNull();
    });

    it('tiny PnL at epsilon boundary classified as breakeven', () => {
        expect(classifyPnl(PNL_EPSILON)).toBe('breakeven');
        expect(classifyPnl(-PNL_EPSILON)).toBe('breakeven');
        expect(classifyPnl(PNL_EPSILON * 1.1)).toBe('win');
        expect(classifyPnl(-PNL_EPSILON * 1.1)).toBe('loss');
    });
});
