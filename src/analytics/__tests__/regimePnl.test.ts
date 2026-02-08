/**
 * Regime PnL unit tests (PR2)
 * Verifies that getRegimeMatrix returns totalPnl and pnlPerTrade fields.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';

// Mock better-sqlite3 database
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
                        volumeVelocity REAL,
                        adverseSelectionRisk INTEGER
                    );
                    
                    CREATE INDEX IF NOT EXISTS idx_trade_events_ts ON trade_events(ts);
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts ON market_snapshots(ts);
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_pairKey ON market_snapshots(pairKey);
                `);
            }
            return mockDb;
        },
        insertTradeEvent: (event: any) => {
            const db = mockDb!;
            const stmt = db.prepare(`
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
            `);
            stmt.run(
                event.id ?? `test-${Date.now()}-${Math.random()}`,
                event.ts, event.pairKey, event.strategy, event.action,
                event.side ?? null, event.intentPrice ?? null,
                event.intentSizeBase ?? null, event.intentSizeQuote ?? null,
                event.fillPrice ?? null, event.fillSizeBase ?? null,
                event.fillSizeQuote ?? null, event.txHash ?? null,
                event.ledgerIndex ?? null, event.resultCode ?? null,
                event.error ?? null, event.isBotTrade ?? null,
                event.midPriceAtDecision ?? null,
                event.slippageBpsVsIntent ?? null, event.slippageBpsVsMid ?? null,
                event.spreadPaidBps ?? null, event.edgeBpsVsMid ?? null,
                event.netEdgeBpsVsMid ?? null, event.txFeeXrp ?? null,
                event.ammFeeBps ?? null, event.fillRatio ?? null,
                event.isPartial ?? null,
            );
        },
        insertMarketSnapshot: (snapshot: any) => {
            const db = mockDb!;
            const stmt = db.prepare(`
                INSERT INTO market_snapshots (
                    id, ts, pairKey, ledgerIndex, midPrice, spreadBps,
                    bestBid, bestAsk, bidDepthBase, askDepthBase,
                    flowRegime, flowImbalance, flowDepthImbalance,
                    flowCombined, flowStrength, vwap, vwapDeviationBps,
                    tradeCount, volumeVelocity, adverseSelectionRisk
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                snapshot.id ?? `snap-${Date.now()}-${Math.random()}`,
                snapshot.ts, snapshot.pairKey, snapshot.ledgerIndex ?? null,
                snapshot.midPrice ?? null, snapshot.spreadBps ?? null,
                snapshot.bestBid ?? null, snapshot.bestAsk ?? null,
                snapshot.bidDepthBase ?? null, snapshot.askDepthBase ?? null,
                snapshot.flowRegime ?? null, snapshot.flowImbalance ?? null,
                snapshot.flowDepthImbalance ?? null, snapshot.flowCombined ?? null,
                snapshot.flowStrength ?? null, snapshot.vwap ?? null,
                snapshot.vwapDeviationBps ?? null, snapshot.tradeCount ?? null,
                snapshot.volumeVelocity ?? null, snapshot.adverseSelectionRisk ?? null,
            );
        },
        queryTradeEvents: (filters: any = {}) => {
            const db = mockDb!;
            const conditions: string[] = [];
            const params: any[] = [];
            if (filters.sinceMs !== undefined) {
                conditions.push('ts >= ?');
                params.push(filters.sinceMs);
            }
            if (filters.untilMs !== undefined) {
                conditions.push('ts <= ?');
                params.push(filters.untilMs);
            }
            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            return db.prepare(`SELECT * FROM trade_events ${where} ORDER BY ts DESC`).all(...params);
        },
        getSnapshotNear: (pairKey: string, ts: number, toleranceMs: number = 5000) => {
            const db = mockDb!;
            return db.prepare(`
                SELECT * FROM market_snapshots 
                WHERE pairKey = ? AND ts BETWEEN ? AND ?
                ORDER BY ABS(ts - ?) LIMIT 1
            `).get(pairKey, ts - toleranceMs, ts + toleranceMs, ts) ?? null;
        },
        querySnapshots: (filters: any = {}) => {
            const db = mockDb!;
            let sql = 'SELECT * FROM market_snapshots WHERE 1=1';
            const params: any[] = [];
            if (filters.pairKey) { sql += ' AND pairKey = ?'; params.push(filters.pairKey); }
            if (filters.sinceMs) { sql += ' AND ts >= ?'; params.push(filters.sinceMs); }
            sql += ' ORDER BY ts DESC';
            return db.prepare(sql).all(...params);
        },
        pruneOldData: () => ({ deletedEvents: 0, deletedSnapshots: 0 }),
        closeFeedbackDb: () => { },
        generateId: () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
});

import { feedbackEngine } from '../feedbackEngine';
import { insertTradeEvent, insertMarketSnapshot, getFeedbackDb } from '../feedbackDb';

/**
 * Insert a fill with a matching snapshot so getRegimeMatrix can link them.
 */
function insertFillWithSnapshot(
    ts: number,
    strategy: string,
    regime: FlowRegime,
    opts: {
        fillPrice?: number;
        midPriceAtDecision?: number;
        fillSizeBase?: number;
        pairKey?: string;
        side?: 'buy' | 'sell';
    } = {},
) {
    const pairKey = opts.pairKey ?? 'XRP/USD';
    const id = `fill-${ts}-${Math.random().toString(36).slice(2)}`;

    (insertTradeEvent as any)({
        id,
        ts,
        pairKey,
        strategy,
        action: 'fill',
        side: opts.side ?? 'buy',
        isBotTrade: 1,
        fillPrice: opts.fillPrice ?? 0.50,
        fillSizeBase: opts.fillSizeBase ?? 100,
        intentPrice: opts.midPriceAtDecision ?? (opts.fillPrice ?? 0.50),
        midPriceAtDecision: opts.midPriceAtDecision ?? (opts.fillPrice ?? 0.50),
    });

    (insertMarketSnapshot as any)({
        id: `snap-${ts}`,
        ts,
        pairKey,
        flowRegime: regime,
        spreadBps: 10,
    });
}

describe('FeedbackEngine - Regime PnL (PR2)', () => {
    beforeEach(() => {
        getFeedbackDb();
        mockDb!.exec('DELETE FROM trade_events');
        mockDb!.exec('DELETE FROM market_snapshots');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should return totalPnl and pnlPerTrade = 0 for regimes with no trades', () => {
        const matrix = feedbackEngine.getRegimeMatrix();
        for (const rs of matrix) {
            expect(rs).toHaveProperty('totalPnl');
            expect(rs).toHaveProperty('pnlPerTrade');
            expect(rs.totalPnl).toBe(0);
            expect(rs.pnlPerTrade).toBe(0);
        }
    });

    it('should compute totalPnl and pnlPerTrade for a regime with trades', () => {
        const now = Date.now();

        // 5 winning trades in 'normal': buy at 0.49 with mid 0.50 → positive edge
        for (let i = 0; i < 5; i++) {
            insertFillWithSnapshot(now - i * 1000, 'scalper', 'normal', {
                fillPrice: 0.49,
                midPriceAtDecision: 0.50,
                fillSizeBase: 100,
                side: 'buy',
            });
        }

        const matrix = feedbackEngine.getRegimeMatrix();
        const normal = matrix.find(r => r.regime === 'normal');

        expect(normal).toBeDefined();
        expect(normal!.trades).toBe(5);
        // All trades have positive edge → totalPnl > 0
        expect(normal!.totalPnl).toBeGreaterThan(0);
        expect(normal!.pnlPerTrade).toBeCloseTo(normal!.totalPnl / 5, 8);
    });

    it('should set pnlPerTrade = totalPnl / trades accurately', () => {
        const now = Date.now();

        // 3 wins, 2 losses
        for (let i = 0; i < 3; i++) {
            insertFillWithSnapshot(now - i * 1000, 'scalper', 'quiet', {
                fillPrice: 0.49, midPriceAtDecision: 0.50, fillSizeBase: 100, side: 'buy',
            });
        }
        for (let i = 0; i < 2; i++) {
            insertFillWithSnapshot(now - (10 + i) * 1000, 'scalper', 'quiet', {
                fillPrice: 0.51, midPriceAtDecision: 0.50, fillSizeBase: 100, side: 'buy',
            });
        }

        const matrix = feedbackEngine.getRegimeMatrix();
        const quiet = matrix.find(r => r.regime === 'quiet');

        expect(quiet).toBeDefined();
        expect(quiet!.trades).toBe(5);
        expect(quiet!.pnlPerTrade).toBeCloseTo(quiet!.totalPnl / quiet!.trades, 8);
    });
});
