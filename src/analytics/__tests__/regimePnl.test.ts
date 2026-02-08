/**
 * Regime PnL unit tests
 *
 * Verifies that totalPnl and pnlPerTrade are correctly computed
 * in both getRegimeHeatmap() and getRegimeMatrix() (via getAnalytics).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Types
interface TradeEventRecord {
    id: string;
    ts: number;
    pairKey: string;
    strategy: string;
    action: 'fill' | 'offer_create' | 'offer_cancel' | 'error' | 'reject';
    side: 'buy' | 'sell' | null;
    intentPrice: number | null;
    fillPrice: number | null;
    intentSizeBase: number | null;
    fillSizeBase: number | null;
    fillSizeQuote: number | null;
    slippageBpsVsIntent: number | null;
    isPartial: number | null;
    isBotTrade: number | null;
    midPriceAtDecision: number | null;
    [key: string]: unknown;
}

interface MarketSnapshotRecord {
    id: string;
    ts: number;
    pairKey: string;
    flowRegime: string | null;
    spreadBps: number | null;
    [key: string]: unknown;
}

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';

let mockDb: Database.Database | null = null;

vi.mock('../feedbackDb', async () => {
    return {
        getFeedbackDb: () => {
            if (!mockDb) {
                mockDb = new Database(':memory:');
                mockDb.exec(`
                    CREATE TABLE IF NOT EXISTS trade_events (
                        id TEXT PRIMARY KEY,
                        ts INTEGER NOT NULL,
                        pairKey TEXT NOT NULL,
                        strategy TEXT NOT NULL,
                        action TEXT NOT NULL,
                        side TEXT,
                        intentPrice REAL,
                        intentSizeBase REAL,
                        intentSizeQuote REAL,
                        fillPrice REAL,
                        fillSizeBase REAL,
                        fillSizeQuote REAL,
                        txHash TEXT,
                        ledgerIndex INTEGER,
                        resultCode TEXT,
                        error TEXT,
                        isBotTrade INTEGER,
                        midPriceAtDecision REAL,
                        slippageBpsVsIntent REAL,
                        slippageBpsVsMid REAL,
                        spreadPaidBps REAL,
                        edgeBpsVsMid REAL,
                        netEdgeBpsVsMid REAL,
                        txFeeXrp REAL,
                        ammFeeBps REAL,
                        fillRatio REAL,
                        isPartial INTEGER
                    );
                    CREATE TABLE IF NOT EXISTS market_snapshots (
                        id TEXT PRIMARY KEY,
                        ts INTEGER NOT NULL,
                        pairKey TEXT NOT NULL,
                        ledgerIndex INTEGER,
                        midPrice REAL,
                        spreadBps REAL,
                        bestBid REAL,
                        bestAsk REAL,
                        bidDepthBase REAL,
                        askDepthBase REAL,
                        flowRegime TEXT,
                        flowImbalance REAL,
                        flowDepthImbalance REAL,
                        flowCombined REAL,
                        flowStrength REAL,
                        vwap REAL,
                        vwapDeviationBps REAL,
                        tradeCount INTEGER,
                        volumeVelocity REAL
                    );
                    CREATE INDEX IF NOT EXISTS idx_trade_events_ts ON trade_events(ts);
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts ON market_snapshots(ts);
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_pairKey ON market_snapshots(pairKey);
                `);
            }
            return mockDb;
        },
        insertTradeEvent: (event: TradeEventRecord) => {
            const db = mockDb!;
            db.prepare(`
                INSERT INTO trade_events (
                    id, ts, pairKey, strategy, action, side,
                    intentPrice, intentSizeBase, intentSizeQuote,
                    fillPrice, fillSizeBase, fillSizeQuote,
                    txHash, ledgerIndex, resultCode, error,
                    isBotTrade, midPriceAtDecision,
                    slippageBpsVsIntent, slippageBpsVsMid, spreadPaidBps,
                    edgeBpsVsMid, netEdgeBpsVsMid, txFeeXrp, ammFeeBps,
                    fillRatio, isPartial
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                event.id, event.ts, event.pairKey, event.strategy, event.action, event.side ?? null,
                event.intentPrice ?? null, event.intentSizeBase ?? null, event.intentSizeQuote ?? null,
                event.fillPrice ?? null, event.fillSizeBase ?? null, event.fillSizeQuote ?? null,
                null, null, null, null,
                event.isBotTrade ?? null, event.midPriceAtDecision ?? null,
                event.slippageBpsVsIntent ?? null, null, null,
                null, null, null, null, null, event.isPartial ?? null,
            );
        },
        insertMarketSnapshot: (snapshot: MarketSnapshotRecord) => {
            const db = mockDb!;
            db.prepare(`
                INSERT INTO market_snapshots (
                    id, ts, pairKey, ledgerIndex, midPrice, spreadBps,
                    bestBid, bestAsk, bidDepthBase, askDepthBase,
                    flowRegime, flowImbalance, flowDepthImbalance,
                    flowCombined, flowStrength, vwap, vwapDeviationBps,
                    tradeCount, volumeVelocity
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                snapshot.id, snapshot.ts, snapshot.pairKey,
                null, null, snapshot.spreadBps ?? null,
                null, null, null, null,
                snapshot.flowRegime ?? null, null, null,
                null, null, null, null, null, null,
            );
        },
        queryTradeEvents: (filters: { pairKey?: string; sinceMs?: number } = {}) => {
            const db = mockDb!;
            const conds: string[] = [];
            const params: (string | number)[] = [];
            if (filters.pairKey) { conds.push('pairKey = ?'); params.push(filters.pairKey); }
            if (filters.sinceMs !== undefined) { conds.push('ts >= ?'); params.push(filters.sinceMs); }
            const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
            return db.prepare(`SELECT * FROM trade_events ${where} ORDER BY ts DESC`).all(...params) as TradeEventRecord[];
        },
        getSnapshotNear: (pairKey: string, ts: number, toleranceMs: number = 5000) => {
            const db = mockDb!;
            return db.prepare(`
                SELECT * FROM market_snapshots
                WHERE pairKey = ? AND ts BETWEEN ? AND ?
                ORDER BY ABS(ts - ?) LIMIT 1
            `).get(pairKey, ts - toleranceMs, ts + toleranceMs, ts) as MarketSnapshotRecord | null;
        },
        pruneOldData: () => ({ deletedEvents: 0, deletedSnapshots: 0 }),
        generateId: () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
});

import { feedbackEngine } from '../feedbackEngine';
import { insertTradeEvent, insertMarketSnapshot, getFeedbackDb } from '../feedbackDb';

/**
 * Helper: insert a bot fill with a matching snapshot in a given regime.
 * fillPrice vs midPriceAtDecision determines PnL direction via edge-based calc:
 *   pnl ≈ (edgeBps / 10000) * fillPrice * fillSizeBase
 *   for buys: edgeBps = (midPrice - fillPrice) / midPrice * 10000
 *     → buying below mid = positive edge = profit
 */
function insertFill(
    ts: number,
    regime: FlowRegime,
    opts: {
        fillPrice: number;
        midPrice: number;
        fillSizeBase?: number;
        strategy?: string;
        pairKey?: string;
    },
) {
    const pairKey = opts.pairKey ?? 'XRP/USD';
    const id = `fill-${ts}-${Math.random().toString(36).slice(2)}`;

    (insertTradeEvent as (e: unknown) => void)({
        id,
        ts,
        pairKey,
        strategy: opts.strategy ?? 'scalper',
        action: 'fill',
        side: 'buy',
        isBotTrade: 1,
        fillPrice: opts.fillPrice,
        fillSizeBase: opts.fillSizeBase ?? 100,
        intentPrice: opts.midPrice,
        midPriceAtDecision: opts.midPrice,
        slippageBpsVsIntent: 0,
        isPartial: 0,
    });

    (insertMarketSnapshot as (s: unknown) => void)({
        id: `snap-${ts}-${Math.random().toString(36).slice(2)}`,
        ts,
        pairKey,
        flowRegime: regime,
        spreadBps: 10,
    });
}

describe('Regime PnL fields', () => {
    beforeEach(() => {
        getFeedbackDb();
        mockDb!.exec('DELETE FROM trade_events');
        mockDb!.exec('DELETE FROM market_snapshots');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('getRegimeHeatmap — totalPnl + pnlPerTrade', () => {
        it('should compute correct totalPnl and pnlPerTrade per regime cell', () => {
            const now = Date.now();

            // 6 winning trades in 'normal' regime — bought at 0.49 with mid 0.50
            // edgeBps = (0.50 - 0.49) / 0.50 * 10000 = 200 bps
            // pnl per trade = (200 / 10000) * 0.49 * 100 = 0.98
            for (let i = 0; i < 6; i++) {
                insertFill(now - i * 1000, 'normal', {
                    fillPrice: 0.49,
                    midPrice: 0.50,
                    fillSizeBase: 100,
                });
            }

            const result = feedbackEngine.getRegimeHeatmap({ minTrades: 5, lookbackHours: 1 });
            const normalCell = result.global.normal;

            expect(normalCell.trades).toBe(6);
            expect(normalCell.totalPnl).toBeGreaterThan(0);
            // pnlPerTrade ≈ 0.98
            expect(normalCell.pnlPerTrade).toBeCloseTo(normalCell.totalPnl / 6, 6);
        });

        it('should return 0 totalPnl for empty regime cells', () => {
            const result = feedbackEngine.getRegimeHeatmap();
            expect(result.global.chaotic.totalPnl).toBe(0);
            expect(result.global.chaotic.pnlPerTrade).toBe(0);
        });
    });

    describe('getAnalytics().byRegime — totalPnl + pnlPerTrade', () => {
        it('should include totalPnl and pnlPerTrade in regime stats', () => {
            const now = Date.now();

            // Insert fills in 'normal' regime — profitable buys below mid
            for (let i = 0; i < 4; i++) {
                insertFill(now - i * 1000, 'normal', {
                    fillPrice: 0.49,
                    midPrice: 0.50,
                    fillSizeBase: 100,
                });
            }

            // Insert fills in 'chaotic' regime — unprofitable buys above mid
            for (let i = 0; i < 3; i++) {
                insertFill(now - (10 + i) * 1000, 'chaotic', {
                    fillPrice: 0.51,
                    midPrice: 0.50,
                    fillSizeBase: 100,
                });
            }

            const analytics = feedbackEngine.getAnalytics();
            const normalRegime = analytics.byRegime.find(r => r.regime === 'normal');
            const chaoticRegime = analytics.byRegime.find(r => r.regime === 'chaotic');

            expect(normalRegime).toBeDefined();
            expect(normalRegime!.totalPnl).toBeGreaterThan(0);
            expect(normalRegime!.pnlPerTrade).toBeCloseTo(normalRegime!.totalPnl / normalRegime!.trades, 6);

            expect(chaoticRegime).toBeDefined();
            expect(chaoticRegime!.totalPnl).toBeLessThan(0);
            expect(chaoticRegime!.pnlPerTrade).toBeCloseTo(chaoticRegime!.totalPnl / chaoticRegime!.trades, 6);

            // Regimes with no trades should have 0 PnL
            const quietRegime = analytics.byRegime.find(r => r.regime === 'quiet');
            expect(quietRegime).toBeDefined();
            expect(quietRegime!.totalPnl).toBe(0);
            expect(quietRegime!.pnlPerTrade).toBe(0);
        });
    });
});
