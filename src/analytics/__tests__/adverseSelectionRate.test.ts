/**
 * Adverse selection rate unit tests
 *
 * Verifies:
 * - Rate is computed correctly from snapshot flags
 * - null adverseSelectionRisk values are excluded
 * - pairKey and windowMs filtering works
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts ON market_snapshots(ts);
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_pairKey ON market_snapshots(pairKey);
                `);
            }
            return mockDb;
        },
        insertTradeEvent: () => {},
        insertMarketSnapshot: () => {},
        queryTradeEvents: () => [],
        getSnapshotNear: () => null,
        pruneOldData: () => ({ deletedEvents: 0, deletedSnapshots: 0 }),
        generateId: () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
});

import { feedbackEngine } from '../feedbackEngine';
import { getFeedbackDb } from '../feedbackDb';

/**
 * Helper: insert a snapshot row directly into the mock DB
 */
function insertSnapshot(
    ts: number,
    pairKey: string,
    adverseSelectionRisk: number | null,
) {
    const id = `snap-${ts}-${Math.random().toString(36).slice(2)}`;
    mockDb!.prepare(`
        INSERT INTO market_snapshots (id, ts, pairKey, adverseSelectionRisk)
        VALUES (?, ?, ?, ?)
    `).run(id, ts, pairKey, adverseSelectionRisk);
}

describe('getAdverseSelectionRate', () => {
    beforeEach(() => {
        getFeedbackDb();
        mockDb!.exec('DELETE FROM market_snapshots');
        mockDb!.exec('DELETE FROM trade_events');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should return 0 rate when no snapshots exist', () => {
        const result = feedbackEngine.getAdverseSelectionRate();
        expect(result.sampleCount).toBe(0);
        expect(result.adverseCount).toBe(0);
        expect(result.adverseRate).toBe(0);
    });

    it('should exclude snapshots with null adverseSelectionRisk', () => {
        const now = Date.now();

        // 2 snapshots with risk=1, 1 with risk=0, 2 with risk=null
        insertSnapshot(now - 5000, 'XRP/USD', 1);
        insertSnapshot(now - 4000, 'XRP/USD', 1);
        insertSnapshot(now - 3000, 'XRP/USD', 0);
        insertSnapshot(now - 2000, 'XRP/USD', null);
        insertSnapshot(now - 1000, 'XRP/USD', null);

        const result = feedbackEngine.getAdverseSelectionRate();

        // Only 3 non-null snapshots should be counted
        expect(result.sampleCount).toBe(3);
        expect(result.adverseCount).toBe(2);
        expect(result.adverseRate).toBeCloseTo(2 / 3, 6);
    });

    it('should compute correct rate (all adverse)', () => {
        const now = Date.now();

        insertSnapshot(now - 3000, 'XRP/USD', 1);
        insertSnapshot(now - 2000, 'XRP/USD', 1);
        insertSnapshot(now - 1000, 'XRP/USD', 1);

        const result = feedbackEngine.getAdverseSelectionRate();

        expect(result.sampleCount).toBe(3);
        expect(result.adverseCount).toBe(3);
        expect(result.adverseRate).toBe(1);
    });

    it('should compute correct rate (none adverse)', () => {
        const now = Date.now();

        insertSnapshot(now - 3000, 'XRP/USD', 0);
        insertSnapshot(now - 2000, 'XRP/USD', 0);

        const result = feedbackEngine.getAdverseSelectionRate();

        expect(result.sampleCount).toBe(2);
        expect(result.adverseCount).toBe(0);
        expect(result.adverseRate).toBe(0);
    });

    it('should filter by pairKey', () => {
        const now = Date.now();

        insertSnapshot(now - 3000, 'XRP/USD', 1);
        insertSnapshot(now - 2000, 'XRP/USD', 0);
        insertSnapshot(now - 1000, 'BTC/USD', 1);

        const xrpResult = feedbackEngine.getAdverseSelectionRate({ pairKey: 'XRP/USD' });
        expect(xrpResult.sampleCount).toBe(2);
        expect(xrpResult.adverseCount).toBe(1);
        expect(xrpResult.adverseRate).toBe(0.5);

        const btcResult = feedbackEngine.getAdverseSelectionRate({ pairKey: 'BTC/USD' });
        expect(btcResult.sampleCount).toBe(1);
        expect(btcResult.adverseCount).toBe(1);
        expect(btcResult.adverseRate).toBe(1);
    });

    it('should filter by windowMs', () => {
        const now = Date.now();

        // Old snapshot (outside 5-second window)
        insertSnapshot(now - 10000, 'XRP/USD', 1);
        // Recent snapshots (inside window)
        insertSnapshot(now - 3000, 'XRP/USD', 0);
        insertSnapshot(now - 1000, 'XRP/USD', 1);

        const result = feedbackEngine.getAdverseSelectionRate({ windowMs: 5000 });

        expect(result.sampleCount).toBe(2);
        expect(result.adverseCount).toBe(1);
        expect(result.adverseRate).toBe(0.5);
    });

    it('should filter by both pairKey and windowMs', () => {
        const now = Date.now();

        insertSnapshot(now - 20000, 'XRP/USD', 1); // old, excluded by windowMs
        insertSnapshot(now - 3000, 'XRP/USD', 1);   // matches both
        insertSnapshot(now - 2000, 'XRP/USD', 0);   // matches both
        insertSnapshot(now - 1000, 'BTC/USD', 1);   // wrong pair

        const result = feedbackEngine.getAdverseSelectionRate({
            pairKey: 'XRP/USD',
            windowMs: 5000,
        });

        expect(result.sampleCount).toBe(2);
        expect(result.adverseCount).toBe(1);
        expect(result.adverseRate).toBe(0.5);
    });
});
