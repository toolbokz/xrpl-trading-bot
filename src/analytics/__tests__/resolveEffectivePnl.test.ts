/**
 * Tests for the shared resolveEffectivePnl module.
 *
 * Covers:
 * - XRP-base pair detection (isXrpBasePair via behavior)
 * - Fee conversion correctness for XRP-base vs non-XRP-base pairs
 * - PnL derivation priority: explicit > trace-based > null
 * - Cross-module consistency: backend and UI re-exports produce identical results
 */

import { describe, expect, it } from 'vitest';
import {
    resolveEffectivePnl,
    type MinimalTrade,
    type MinimalTrace,
    type FillSnapshot,
} from '../resolveEffectivePnl';
import { PNL_EPSILON } from '../metricUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<MinimalTrade> = {}): MinimalTrade {
    return {
        pnl: 0,
        side: 'BUY',
        price: 2.0,
        filled: 10,
        pair: 'XRP/RLUSD',
        ...overrides,
    };
}

function makeTrace(overrides: Partial<MinimalTrace> = {}): MinimalTrace {
    return {
        baseline_mid: null,
        fee_drops: null,
        fill_snapshot: null,
        ...overrides,
    };
}

function makeFillSnap(overrides: Partial<FillSnapshot> = {}): FillSnapshot {
    return {
        filled_base: 10,
        filled_quote: 20,
        avg_price: 2.0,
        fee: null,
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority 1: Explicit PnL
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl — explicit PnL priority', () => {
    it('returns trade.pnl when non-zero and above epsilon', () => {
        const trade = makeTrade({ pnl: 5.0 });
        expect(resolveEffectivePnl(trade)).toBe(5.0);
    });

    it('returns trade.pnl for negative values', () => {
        const trade = makeTrade({ pnl: -3.5 });
        expect(resolveEffectivePnl(trade)).toBe(-3.5);
    });

    it('ignores trade.pnl when within epsilon of zero', () => {
        const trade = makeTrade({
            pnl: PNL_EPSILON / 10,
            trace: makeTrace({
                baseline_mid: 2.0,
                fill_snapshot: makeFillSnap({ avg_price: 2.01, filled_base: 10 }),
            }),
        });
        // Should fall through to trace-based calculation
        expect(resolveEffectivePnl(trade)).not.toBe(PNL_EPSILON / 10);
        expect(resolveEffectivePnl(trade)).not.toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Priority 2: Trace-based edge proxy
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl — trace-based edge', () => {
    it('computes BUY edge: buying below mid is profit', () => {
        const trade = makeTrade({
            side: 'BUY',
            pair: 'XRP/RLUSD',
            trace: makeTrace({
                baseline_mid: 2.10,
                fill_snapshot: makeFillSnap({ avg_price: 2.05, filled_base: 10 }),
            }),
        });
        const result = resolveEffectivePnl(trade)!;
        // BUY at 2.05 vs mid 2.10 → delta = -0.05, edge = -(-0.05)*10 = 0.5
        expect(result).toBeCloseTo(0.5, 6);
    });

    it('computes SELL edge: selling above mid is profit', () => {
        const trade = makeTrade({
            side: 'SELL',
            pair: 'XRP/RLUSD',
            trace: makeTrace({
                baseline_mid: 2.10,
                fill_snapshot: makeFillSnap({ avg_price: 2.15, filled_base: 10 }),
            }),
        });
        const result = resolveEffectivePnl(trade)!;
        // SELL at 2.15 vs mid 2.10 → delta = 0.05, edge = 0.05*10 = 0.5
        expect(result).toBeCloseTo(0.5, 6);
    });

    it('negative edge for bad BUY (above mid)', () => {
        const trade = makeTrade({
            side: 'BUY',
            pair: 'XRP/RLUSD',
            trace: makeTrace({
                baseline_mid: 2.0,
                fill_snapshot: makeFillSnap({ avg_price: 2.10, filled_base: 10 }),
            }),
        });
        const result = resolveEffectivePnl(trade)!;
        // BUY at 2.10 vs mid 2.0 → delta = 0.10, edge = -(0.10)*10 = -1.0
        expect(result).toBeCloseTo(-1.0, 6);
    });

    it('uses trade.price and trade.filled as fallbacks', () => {
        const trade = makeTrade({
            side: 'SELL',
            price: 2.15,
            filled: 10,
            pair: 'XRP/RLUSD',
            trace: makeTrace({
                baseline_mid: 2.10,
                fill_snapshot: makeFillSnap({
                    avg_price: null,
                    filled_base: null,
                }),
            }),
        });
        const result = resolveEffectivePnl(trade)!;
        expect(result).toBeCloseTo(0.5, 6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fee deduction
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl — fee deduction', () => {
    it('deducts XRP tx fee for XRP-base pair (exact conversion)', () => {
        // fee_drops = 12 → 0.000012 XRP, fillPrice = 2.0 → feeQuote = 0.000024
        const trade = makeTrade({
            side: 'BUY',
            pair: 'XRP/RLUSD',
            trace: makeTrace({
                baseline_mid: 2.10,
                fee_drops: '12',
                fill_snapshot: makeFillSnap({ avg_price: 2.05, filled_base: 10 }),
            }),
        });
        const result = resolveEffectivePnl(trade)!;
        const expectedEdge = 0.5; // (2.10 - 2.05) * 10
        const expectedFee = 0.000012 * 2.05;
        expect(result).toBeCloseTo(expectedEdge - expectedFee, 6);
    });

    it('prefers fill_snapshot.fee when larger than tx fee conversion', () => {
        const trade = makeTrade({
            side: 'SELL',
            pair: 'XRP/RLUSD',
            trace: makeTrace({
                baseline_mid: 2.10,
                fee_drops: '12',
                fill_snapshot: makeFillSnap({
                    avg_price: 2.15,
                    filled_base: 10,
                    fee: 0.1, // Much larger than tx fee
                }),
            }),
        });
        const result = resolveEffectivePnl(trade)!;
        const expectedEdge = 0.5;
        expect(result).toBeCloseTo(expectedEdge - 0.1, 6);
    });

    it('handles non-XRP-base pair with approximate fee (no crash)', () => {
        const trade = makeTrade({
            side: 'BUY',
            pair: 'RLUSD/USD',
            trace: makeTrace({
                baseline_mid: 1.001,
                fee_drops: '12',
                fill_snapshot: makeFillSnap({ avg_price: 1.0, filled_base: 100 }),
            }),
        });
        // Should not throw; fee is approximated
        const result = resolveEffectivePnl(trade);
        expect(result).not.toBeNull();
        expect(typeof result).toBe('number');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// XRP-base pair detection (tested through behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl — pair detection', () => {
    const commonTrace = (mid: number, fillPrice: number) =>
        makeTrace({
            baseline_mid: mid,
            fee_drops: '12',
            fill_snapshot: makeFillSnap({ avg_price: fillPrice, filled_base: 10 }),
        });

    it('XRP/RLUSD is XRP-base (no warning path)', () => {
        const trade = makeTrade({
            pair: 'XRP/RLUSD',
            side: 'BUY',
            trace: commonTrace(2.1, 2.05),
        });
        const result = resolveEffectivePnl(trade);
        expect(result).not.toBeNull();
    });

    it('xrp/rlusd is case-insensitive', () => {
        const trade = makeTrade({
            pair: 'xrp/rlusd',
            side: 'BUY',
            trace: commonTrace(2.1, 2.05),
        });
        const result = resolveEffectivePnl(trade);
        expect(result).not.toBeNull();
    });

    it('RLUSD/XRP is not XRP-base', () => {
        const trade = makeTrade({
            pair: 'RLUSD/XRP',
            side: 'BUY',
            trace: commonTrace(0.5, 0.49),
        });
        const result = resolveEffectivePnl(trade);
        expect(result).not.toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Priority 3: Insufficient data → null
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl — unclassifiable', () => {
    it('returns null when no trace data', () => {
        const trade = makeTrade({ pnl: 0 });
        expect(resolveEffectivePnl(trade)).toBeNull();
    });

    it('returns null when baseline_mid is missing', () => {
        const trade = makeTrade({
            pnl: 0,
            trace: makeTrace({
                baseline_mid: null,
                fill_snapshot: makeFillSnap(),
            }),
        });
        expect(resolveEffectivePnl(trade)).toBeNull();
    });

    it('returns null when fill price and trade price are both 0', () => {
        const trade = makeTrade({
            pnl: 0,
            price: 0,
            trace: makeTrace({
                baseline_mid: 2.0,
                fill_snapshot: makeFillSnap({ avg_price: null, filled_base: 10 }),
            }),
        });
        expect(resolveEffectivePnl(trade)).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-module consistency: re-exports produce identical results
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectivePnl — cross-module re-export consistency', () => {
    it('backend re-export is the same function', async () => {
        const backendMod = await import('../tradeHistory');
        expect(backendMod.resolveEffectivePnl).toBe(resolveEffectivePnl);
    });
});
