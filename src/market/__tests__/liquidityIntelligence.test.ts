/**
 * Liquidity Intelligence — Unit Tests
 *
 * @module market/__tests__/liquidityIntelligence.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    LiquidityIntelligence,
    LiquidityGrade,
    LiquiditySnapshot,
    DepthProfile,
    SpreadStats,
    TradeFlowStats,
    ImpactEstimate,
    LiquidityIntelligenceConfig,
    // Pure functions
    scoreToGrade,
    scoreToLevel,
    scoreDepth,
    scoreSpread,
    scoreFlow,
    scoreImpact,
    buildDepthProfile,
    estimateImpact,
    computeImpactEstimates,
    computeTradeFlowStats,
    computeCompositeScore,
    loadLiquidityConfig,
} from '../liquidityIntelligence';
import type { BookOffer, OrderBookState } from '../../utils/types';
import type { Trade } from '../tradeTape';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeOffer(price: number, quantity: number, isBuy: boolean): BookOffer {
    return { price, quantity, quality: 0, isBuy, raw: {} };
}

function makeBook(
    bids: Array<[number, number]>,
    asks: Array<[number, number]>,
    spreadOverride?: number,
): OrderBookState {
    const bidOffers = bids.map(([p, q]) => makeOffer(p, q, true));
    const askOffers = asks.map(([p, q]) => makeOffer(p, q, false));
    const bestBid = bidOffers[0]?.price ?? 0;
    const bestAsk = askOffers[0]?.price ?? 0;
    const spread = spreadOverride ?? (bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 10_000 : 0);
    return {
        bids: bidOffers,
        asks: askOffers,
        spread,
        lastUpdated: Date.now(),
    };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: `tx-${Math.random().toString(36).slice(2)}:0`,
        ts: Date.now(),
        pairKey: 'XRP/RLUSD',
        price: 2.50,
        sizeBase: 100,
        sizeQuote: 250,
        side: 'buy',
        txHash: '0xabc',
        ledgerIndex: 1000,
        ...overrides,
    };
}

function makeTrades(count: number, windowMs: number, nowMs: number): Trade[] {
    const trades: Trade[] = [];
    for (let i = 0; i < count; i++) {
        trades.push(makeTrade({
            ts: nowMs - Math.floor(Math.random() * windowMs),
            side: i % 2 === 0 ? 'buy' : 'sell',
            sizeBase: 50 + Math.random() * 100,
            sizeQuote: 125 + Math.random() * 250,
        }));
    }
    return trades;
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreToGrade / scoreToLevel
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreToGrade', () => {
    it('returns A for scores >= 80', () => {
        expect(scoreToGrade(80)).toBe('A');
        expect(scoreToGrade(100)).toBe('A');
        expect(scoreToGrade(95)).toBe('A');
    });

    it('returns B for scores 60-79', () => {
        expect(scoreToGrade(60)).toBe('B');
        expect(scoreToGrade(79)).toBe('B');
    });

    it('returns C for scores 40-59', () => {
        expect(scoreToGrade(40)).toBe('C');
        expect(scoreToGrade(59)).toBe('C');
    });

    it('returns D for scores 20-39', () => {
        expect(scoreToGrade(20)).toBe('D');
        expect(scoreToGrade(39)).toBe('D');
    });

    it('returns F for scores < 20', () => {
        expect(scoreToGrade(0)).toBe('F');
        expect(scoreToGrade(19)).toBe('F');
    });
});

describe('scoreToLevel', () => {
    it('maps to high for >= 60', () => {
        expect(scoreToLevel(60)).toBe('high');
        expect(scoreToLevel(100)).toBe('high');
    });

    it('maps to medium for 30-59', () => {
        expect(scoreToLevel(30)).toBe('medium');
        expect(scoreToLevel(59)).toBe('medium');
    });

    it('maps to low for 1-29', () => {
        expect(scoreToLevel(1)).toBe('low');
        expect(scoreToLevel(29)).toBe('low');
    });

    it('maps to unknown for 0', () => {
        expect(scoreToLevel(0)).toBe('unknown');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreDepth
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreDepth', () => {
    it('scores 100 for deep book (>= 100K notional)', () => {
        const profile: DepthProfile = {
            bidNotional1Pct: 60_000,
            askNotional1Pct: 60_000,
            totalNotional1Pct: 120_000,
            totalNotional2Pct: 200_000,
            bidLevelCount: 20,
            askLevelCount: 20,
            imbalance: 0,
        };
        expect(scoreDepth(profile)).toBe(100);
    });

    it('scores 30 for thin book (500-2K notional)', () => {
        const profile: DepthProfile = {
            bidNotional1Pct: 300,
            askNotional1Pct: 300,
            totalNotional1Pct: 600,
            totalNotional2Pct: 800,
            bidLevelCount: 5,
            askLevelCount: 5,
            imbalance: 0,
        };
        expect(scoreDepth(profile)).toBe(30);
    });

    it('penalizes severe imbalance (>0.7)', () => {
        const balanced: DepthProfile = {
            bidNotional1Pct: 5_000,
            askNotional1Pct: 5_000,
            totalNotional1Pct: 10_000,
            totalNotional2Pct: 15_000,
            bidLevelCount: 10,
            askLevelCount: 10,
            imbalance: 0,
        };
        const unbalanced: DepthProfile = {
            ...balanced,
            imbalance: 0.8,
        };
        expect(scoreDepth(balanced)).toBeGreaterThan(scoreDepth(unbalanced));
        expect(scoreDepth(unbalanced)).toBe(50); // 70 - 20 penalty
    });

    it('penalizes few levels on either side', () => {
        const profile: DepthProfile = {
            bidNotional1Pct: 30_000,
            askNotional1Pct: 30_000,
            totalNotional1Pct: 60_000,
            totalNotional2Pct: 80_000,
            bidLevelCount: 2, // < 3
            askLevelCount: 10,
            imbalance: 0,
        };
        expect(scoreDepth(profile)).toBe(75); // 90 - 15
    });

    it('clamps to 0 for worst case', () => {
        const profile: DepthProfile = {
            bidNotional1Pct: 100,
            askNotional1Pct: 100,
            totalNotional1Pct: 200,
            totalNotional2Pct: 300,
            bidLevelCount: 1,
            askLevelCount: 1,
            imbalance: 0.9,
        };
        // 10 - 20 (imbalance) - 15 (levels) = -25 → clamped to 0
        expect(scoreDepth(profile)).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreSpread
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreSpread', () => {
    it('scores 100 for tight spread (<= 5 bps)', () => {
        expect(scoreSpread({ currentBps: 3, p50Bps: 3, p95Bps: 5, sampleCount: 50 })).toBe(100);
    });

    it('scores 70 for moderate spread (15-30 bps)', () => {
        expect(scoreSpread({ currentBps: 25, p50Bps: 25, p95Bps: 40, sampleCount: 50 })).toBe(70);
    });

    it('scores 10 for wide spread (> 100 bps)', () => {
        expect(scoreSpread({ currentBps: 150, p50Bps: 150, p95Bps: 300, sampleCount: 50 })).toBe(10);
    });

    it('penalizes high P95/P50 ratio (spread instability)', () => {
        const stable: SpreadStats = { currentBps: 10, p50Bps: 10, p95Bps: 20, sampleCount: 50 };
        const unstable: SpreadStats = { currentBps: 10, p50Bps: 10, p95Bps: 60, sampleCount: 50 };
        expect(scoreSpread(stable)).toBeGreaterThan(scoreSpread(unstable));
    });

    it('does not apply instability penalty with few samples', () => {
        const stats: SpreadStats = { currentBps: 10, p50Bps: 10, p95Bps: 100, sampleCount: 3 };
        // P95/P50 = 10, but sampleCount < 5 so no penalty
        expect(scoreSpread(stats)).toBe(85);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreFlow
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreFlow', () => {
    it('scores 100 for >= 10 trades per minute', () => {
        expect(scoreFlow({ tradesPerMinute: 15, volumeBase: 1000, volumeQuote: 5000, buyRatio: 0.5, tradeCount: 150 })).toBe(100);
    });

    it('scores 60 for 2-5 trades per minute', () => {
        expect(scoreFlow({ tradesPerMinute: 3, volumeBase: 300, volumeQuote: 1500, buyRatio: 0.5, tradeCount: 30 })).toBe(60);
    });

    it('scores 5 for no trades', () => {
        expect(scoreFlow({ tradesPerMinute: 0, volumeBase: 0, volumeQuote: 0, buyRatio: 0.5, tradeCount: 0 })).toBe(5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreImpact
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreImpact', () => {
    it('returns 50 (neutral) with no estimates', () => {
        expect(scoreImpact([])).toBe(50);
    });

    it('scores 100 for low impact (<= 5 bps)', () => {
        const estimates: ImpactEstimate[] = [
            { sizeBase: 10, buySlippageBps: 2, sellSlippageBps: 3, avgSlippageBps: 2.5 },
            { sizeBase: 100, buySlippageBps: 3, sellSlippageBps: 4, avgSlippageBps: 3.5 },
            { sizeBase: 1000, buySlippageBps: 5, sellSlippageBps: 5, avgSlippageBps: 5 },
        ];
        // Middle element (index 1) has avg 3.5 bps → 100
        expect(scoreImpact(estimates)).toBe(100);
    });

    it('scores 20 for high impact (50-100 bps)', () => {
        const estimates: ImpactEstimate[] = [
            { sizeBase: 1000, buySlippageBps: 70, sellSlippageBps: 80, avgSlippageBps: 75 },
        ];
        expect(scoreImpact(estimates)).toBe(20);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDepthProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDepthProfile', () => {
    it('computes depth within 1% and 2% of BBO', () => {
        // Best bid = 2.50, 1% floor = 2.475
        // Best ask = 2.52, 1% ceiling = 2.5452
        const bids = [
            makeOffer(2.50, 1000, true),  // notional = 2500 (within 1%)
            makeOffer(2.48, 500, true),    // notional = 1240 (within 1%)
            makeOffer(2.45, 2000, true),   // notional = 4900 (outside 1%, inside 2%)
        ];
        const asks = [
            makeOffer(2.52, 800, false),   // notional = 2016 (within 1%)
            makeOffer(2.54, 600, false),    // notional = 1524 (within 1%)
            makeOffer(2.57, 3000, false),  // notional = 7710 (outside 1%, inside 2%)
        ];

        const profile = buildDepthProfile(bids, asks);

        expect(profile.bidNotional1Pct).toBeGreaterThan(0);
        expect(profile.askNotional1Pct).toBeGreaterThan(0);
        expect(profile.totalNotional1Pct).toBe(profile.bidNotional1Pct + profile.askNotional1Pct);
        expect(profile.totalNotional2Pct).toBeGreaterThan(profile.totalNotional1Pct);
        expect(profile.bidLevelCount).toBe(3);
        expect(profile.askLevelCount).toBe(3);
        expect(profile.imbalance).toBeDefined();
    });

    it('handles empty book', () => {
        const profile = buildDepthProfile([], []);
        expect(profile.totalNotional1Pct).toBe(0);
        expect(profile.totalNotional2Pct).toBe(0);
        expect(profile.imbalance).toBe(0);
    });

    it('handles one-sided book', () => {
        const bids = [makeOffer(2.50, 1000, true)];
        const profile = buildDepthProfile(bids, []);
        expect(profile.bidNotional1Pct).toBe(0); // bestAsk = 0, so early return
        expect(profile.askNotional1Pct).toBe(0);
    });

    it('computes imbalance correctly', () => {
        const bids = [makeOffer(2.50, 2000, true)]; // notional = 5000
        const asks = [makeOffer(2.52, 100, false)];  // notional = 252
        const profile = buildDepthProfile(bids, asks);
        // Imbalance = (5000 - 252) / (5000 + 252) > 0
        expect(profile.imbalance).toBeGreaterThan(0.5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateImpact
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateImpact', () => {
    it('returns 0 for zero-size order', () => {
        const levels = [makeOffer(2.50, 1000, false)];
        expect(estimateImpact(0, levels, 2.50)).toBe(0);
    });

    it('returns 0 for empty book', () => {
        expect(estimateImpact(100, [], 2.50)).toBe(0);
    });

    it('returns 0 bps when order fits entirely in top level', () => {
        const levels = [makeOffer(2.50, 1000, false)];
        expect(estimateImpact(100, levels, 2.50)).toBe(0);
    });

    it('increases slippage for orders walking deeper into the book', () => {
        const levels = [
            makeOffer(2.50, 100, false),
            makeOffer(2.55, 100, false),
            makeOffer(2.60, 100, false),
        ];
        const small = estimateImpact(50, levels, 2.50);
        const large = estimateImpact(250, levels, 2.50);
        expect(large).toBeGreaterThan(small);
    });

    it('penalizes when book has insufficient depth', () => {
        const levels = [makeOffer(2.50, 10, false)];
        // Order for 100, only 10 available → remaining fills at 5% penalty
        const slippage = estimateImpact(100, levels, 2.50);
        expect(slippage).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeImpactEstimates
// ─────────────────────────────────────────────────────────────────────────────

describe('computeImpactEstimates', () => {
    it('returns estimates for each reference size', () => {
        const bids = [makeOffer(2.50, 5000, true)];
        const asks = [makeOffer(2.52, 5000, false)];
        const estimates = computeImpactEstimates(bids, asks, [10, 100, 1000]);

        expect(estimates).toHaveLength(3);
        expect(estimates[0]!.sizeBase).toBe(10);
        expect(estimates[1]!.sizeBase).toBe(100);
        expect(estimates[2]!.sizeBase).toBe(1000);

        for (const est of estimates) {
            expect(est.buySlippageBps).toBeGreaterThanOrEqual(0);
            expect(est.sellSlippageBps).toBeGreaterThanOrEqual(0);
            expect(est.avgSlippageBps).toBeGreaterThanOrEqual(0);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeTradeFlowStats
// ─────────────────────────────────────────────────────────────────────────────

describe('computeTradeFlowStats', () => {
    it('returns zeros with no trades', () => {
        const stats = computeTradeFlowStats([], 60_000, Date.now());
        expect(stats.tradesPerMinute).toBe(0);
        expect(stats.volumeBase).toBe(0);
        expect(stats.tradeCount).toBe(0);
        expect(stats.buyRatio).toBe(0.5);
    });

    it('filters trades outside window', () => {
        const now = Date.now();
        const trades = [
            makeTrade({ ts: now - 30_000, sizeBase: 100 }), // inside 60s window
            makeTrade({ ts: now - 90_000, sizeBase: 200 }), // outside 60s window
        ];
        const stats = computeTradeFlowStats(trades, 60_000, now);
        expect(stats.tradeCount).toBe(1);
    });

    it('computes trades per minute correctly', () => {
        const now = Date.now();
        const trades = makeTrades(30, 60_000, now);
        const stats = computeTradeFlowStats(trades, 60_000, now);
        // 30 trades in 1 minute = 30 tpm
        expect(stats.tradesPerMinute).toBeGreaterThan(0);
        expect(stats.tradeCount).toBe(30);
    });

    it('computes buy ratio', () => {
        const now = Date.now();
        const trades = [
            makeTrade({ ts: now - 1000, side: 'buy' }),
            makeTrade({ ts: now - 2000, side: 'buy' }),
            makeTrade({ ts: now - 3000, side: 'sell' }),
        ];
        const stats = computeTradeFlowStats(trades, 60_000, now);
        expect(stats.buyRatio).toBeCloseTo(0.67, 1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeCompositeScore
// ─────────────────────────────────────────────────────────────────────────────

describe('computeCompositeScore', () => {
    it('computes weighted average', () => {
        // All 100 → 100
        expect(computeCompositeScore(100, 100, 100, 100)).toBe(100);
        // All 0 → 0
        expect(computeCompositeScore(0, 0, 0, 0)).toBe(0);
    });

    it('respects weights', () => {
        // Depth dominates (weight 0.35)
        const depthHigh = computeCompositeScore(100, 50, 50, 50);
        const spreadHigh = computeCompositeScore(50, 100, 50, 50);
        expect(depthHigh).toBeGreaterThan(spreadHigh);
    });

    it('clamps to 0-100', () => {
        expect(computeCompositeScore(0, 0, 0, 0)).toBe(0);
        expect(computeCompositeScore(100, 100, 100, 100)).toBe(100);
    });

    it('supports custom config weights', () => {
        const config: LiquidityIntelligenceConfig = {
            spreadWindowSize: 120,
            tradeFlowWindowMs: 60_000,
            impactReferenceSizes: [10],
            weightDepth: 0,
            weightSpread: 1.0,
            weightFlow: 0,
            weightImpact: 0,
        };
        // Only spread matters
        expect(computeCompositeScore(0, 80, 0, 0, config)).toBe(80);
        expect(computeCompositeScore(100, 80, 100, 100, config)).toBe(80);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// LiquidityIntelligence (stateful engine)
// ─────────────────────────────────────────────────────────────────────────────

describe('LiquidityIntelligence', () => {
    let engine: LiquidityIntelligence;
    const now = Date.now();

    beforeEach(() => {
        engine = new LiquidityIntelligence();
    });

    it('returns null snapshot before any ticks', () => {
        expect(engine.getSnapshot()).toBeNull();
        expect(engine.getScore()).toBe(0);
        expect(engine.getTickCount()).toBe(0);
    });

    it('produces a valid snapshot after one tick', () => {
        const book = makeBook(
            [[2.50, 1000], [2.49, 500], [2.48, 300]],
            [[2.52, 800], [2.53, 600], [2.54, 400]],
        );
        engine.ingestTick(book, [], now);

        const snap = engine.getSnapshot();
        expect(snap).not.toBeNull();
        expect(snap!.score).toBeGreaterThanOrEqual(0);
        expect(snap!.score).toBeLessThanOrEqual(100);
        expect(snap!.grade).toMatch(/^[A-DF]$/);
        expect(snap!.level).toMatch(/^(high|medium|low|unknown)$/);
        expect(snap!.depth.totalNotional1Pct).toBeGreaterThan(0);
        expect(snap!.spread.currentBps).toBeGreaterThan(0);
        expect(snap!.spread.sampleCount).toBe(1);
        expect(snap!.computedAtMs).toBe(now);
        expect(snap!.tickCount).toBe(1);
    });

    it('builds rolling spread percentiles over multiple ticks', () => {
        const spreads = [10, 20, 15, 30, 25, 50, 10, 15, 20, 25];
        for (let i = 0; i < spreads.length; i++) {
            const book = makeBook([[2.50, 1000]], [[2.52, 1000]], spreads[i]);
            engine.ingestTick(book, [], now + i * 1000);
        }

        const snap = engine.getSnapshot();
        expect(snap).not.toBeNull();
        expect(snap!.spread.sampleCount).toBe(10);
        expect(snap!.spread.p50Bps).toBeGreaterThan(0);
        expect(snap!.spread.p95Bps).toBeGreaterThanOrEqual(snap!.spread.p50Bps);
    });

    it('evicts old spread samples beyond window size', () => {
        const engine = new LiquidityIntelligence({ spreadWindowSize: 5 });
        for (let i = 0; i < 10; i++) {
            const book = makeBook([[2.50, 1000]], [[2.52, 1000]], i * 10);
            engine.ingestTick(book, [], now + i * 1000);
        }

        const snap = engine.getSnapshot();
        expect(snap!.spread.sampleCount).toBe(5);
    });

    it('incorporates trade flow data', () => {
        const book = makeBook(
            [[2.50, 1000]],
            [[2.52, 1000]],
        );
        const trades = makeTrades(20, 60_000, now);

        engine.ingestTick(book, trades, now);
        const snap = engine.getSnapshot();

        expect(snap!.flow.tradeCount).toBe(20);
        expect(snap!.flow.tradesPerMinute).toBeGreaterThan(0);
        expect(snap!.flow.volumeBase).toBeGreaterThan(0);
    });

    it('computes impact estimates at default reference sizes', () => {
        const book = makeBook(
            [[2.50, 5000], [2.49, 5000], [2.48, 5000]],
            [[2.52, 5000], [2.53, 5000], [2.54, 5000]],
        );
        engine.ingestTick(book, [], now);

        const snap = engine.getSnapshot();
        expect(snap!.impact).toHaveLength(3); // default 3 reference sizes
        expect(snap!.impact[0]!.sizeBase).toBe(10);
        expect(snap!.impact[1]!.sizeBase).toBe(100);
        expect(snap!.impact[2]!.sizeBase).toBe(1000);
    });

    it('scores higher for deep books with tight spreads', () => {
        const thinBook = makeBook([[2.50, 10]], [[2.60, 10]]);
        const deepBook = makeBook(
            [[2.50, 50000], [2.49, 50000], [2.48, 50000]],
            [[2.51, 50000], [2.52, 50000], [2.53, 50000]],
        );

        const thinEngine = new LiquidityIntelligence();
        const deepEngine = new LiquidityIntelligence();

        thinEngine.ingestTick(thinBook, [], now);
        deepEngine.ingestTick(deepBook, [], now);

        expect(deepEngine.getScore()).toBeGreaterThan(thinEngine.getScore());
    });

    it('getGrade returns correct grade', () => {
        const deepBook = makeBook(
            [[2.50, 100000], [2.49, 100000]],
            [[2.51, 100000], [2.52, 100000]],
        );
        const trades = makeTrades(100, 60_000, now);

        engine.ingestTick(deepBook, trades, now);
        const grade = engine.getGrade();
        expect(['A', 'B', 'C', 'D', 'F']).toContain(grade);
    });

    it('getLevel returns valid LiquidityLevel', () => {
        const book = makeBook([[2.50, 1000]], [[2.52, 1000]]);
        engine.ingestTick(book, [], now);
        const level = engine.getLevel();
        expect(['high', 'medium', 'low', 'unknown']).toContain(level);
    });

    it('reset clears all state', () => {
        const book = makeBook([[2.50, 1000]], [[2.52, 1000]]);
        engine.ingestTick(book, [], now);
        expect(engine.getSnapshot()).not.toBeNull();

        engine.reset();
        expect(engine.getSnapshot()).toBeNull();
        expect(engine.getScore()).toBe(0);
        expect(engine.getTickCount()).toBe(0);
    });

    it('supports custom config via constructor', () => {
        const customEngine = new LiquidityIntelligence({
            spreadWindowSize: 10,
            tradeFlowWindowMs: 30_000,
            impactReferenceSizes: [50, 500],
            weightDepth: 0.5,
            weightSpread: 0.5,
            weightFlow: 0,
            weightImpact: 0,
        });
        const book = makeBook([[2.50, 1000]], [[2.52, 1000]]);
        customEngine.ingestTick(book, [], now);

        const snap = customEngine.getSnapshot();
        expect(snap!.impact).toHaveLength(2);
        expect(snap!.impact[0]!.sizeBase).toBe(50);
        expect(snap!.impact[1]!.sizeBase).toBe(500);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadLiquidityConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('loadLiquidityConfig', () => {
    it('returns empty config when no env vars set', () => {
        const config = loadLiquidityConfig();
        expect(config.spreadWindowSize).toBeUndefined();
        expect(config.tradeFlowWindowMs).toBeUndefined();
    });
});
