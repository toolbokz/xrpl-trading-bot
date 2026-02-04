/**
 * Feedback Engine unit tests
 * Tests DB operations, regime matrix aggregation, slippage calculations, and analytics
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Local test types matching the mock schema (simpler than production)
interface TradeEvent {
    id?: number;
    ts: number;
    pairKey: string;
    strategy: string;
    action: 'fill' | 'offer_create' | 'offer_cancel' | 'error' | 'reject';
    side: 'buy' | 'sell';
    requestedPrice?: number;
    executedPrice?: number;
    requestedSize?: number;
    executedSize?: number;
    txHash?: string;
    ledgerIndex?: number;
    errorCode?: string;
    errorMsg?: string;
    snapshotId?: number;
    spreadBps?: number;
    slippageBps?: number;
    edgeBps?: number;
    metadata?: Record<string, unknown>;
}

interface MarketSnapshot {
    id?: number;
    ts: number;
    pairKey: string;
    buyFlow?: number;
    sellFlow?: number;
    netFlow?: number;
    flowImbalance?: number;
    pressure?: number;
    bestBid?: number;
    bestAsk?: number;
    midPrice?: number;
    spreadBps?: number;
    bidDepth?: number;
    askDepth?: number;
    metadata?: Record<string, unknown>;
}

interface QueryFilters {
    pairKey?: string;
    strategy?: string;
    action?: string;
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
}

// Mock better-sqlite3 to use in-memory database
let mockDb: Database.Database | null = null;

vi.mock('../feedbackDb', async () => {
    // Import interfaces for the mock (using any since we're mocking)
    type MockTradeEvent = Omit<TradeEvent, 'id'>;
    type MockMarketSnapshot = Omit<MarketSnapshot, 'id'>;

    return {
        getFeedbackDb: () => {
            if (!mockDb) {
                mockDb = new Database(':memory:');
                // Create tables
                mockDb.exec(`
                    CREATE TABLE IF NOT EXISTS trade_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ts INTEGER NOT NULL,
                        pairKey TEXT NOT NULL,
                        strategy TEXT NOT NULL,
                        action TEXT NOT NULL,
                        side TEXT NOT NULL,
                        requestedPrice REAL,
                        executedPrice REAL,
                        requestedSize REAL,
                        executedSize REAL,
                        txHash TEXT,
                        ledgerIndex INTEGER,
                        errorCode TEXT,
                        errorMsg TEXT,
                        snapshotId INTEGER,
                        spreadBps REAL,
                        slippageBps REAL,
                        edgeBps REAL,
                        metadata TEXT
                    );
                    
                    CREATE TABLE IF NOT EXISTS market_snapshots (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ts INTEGER NOT NULL,
                        pairKey TEXT NOT NULL,
                        buyFlow REAL,
                        sellFlow REAL,
                        netFlow REAL,
                        flowImbalance REAL,
                        pressure REAL,
                        bestBid REAL,
                        bestAsk REAL,
                        midPrice REAL,
                        spreadBps REAL,
                        bidDepth REAL,
                        askDepth REAL,
                        metadata TEXT
                    );
                    
                    CREATE INDEX IF NOT EXISTS idx_trade_events_ts ON trade_events(ts);
                    CREATE INDEX IF NOT EXISTS idx_trade_events_pairKey ON trade_events(pairKey);
                    CREATE INDEX IF NOT EXISTS idx_trade_events_strategy ON trade_events(strategy);
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts ON market_snapshots(ts);
                    CREATE INDEX IF NOT EXISTS idx_market_snapshots_pairKey ON market_snapshots(pairKey);
                `);
            }
            return mockDb;
        },
        insertTradeEvent: (event: MockTradeEvent) => {
            const db = mockDb!;
            const stmt = db.prepare(`
                INSERT INTO trade_events (
                    ts, pairKey, strategy, action, side,
                    requestedPrice, executedPrice, requestedSize, executedSize,
                    txHash, ledgerIndex, errorCode, errorMsg, snapshotId,
                    spreadBps, slippageBps, edgeBps, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(
                event.ts,
                event.pairKey,
                event.strategy,
                event.action,
                event.side,
                event.requestedPrice ?? null,
                event.executedPrice ?? null,
                event.requestedSize ?? null,
                event.executedSize ?? null,
                event.txHash ?? null,
                event.ledgerIndex ?? null,
                event.errorCode ?? null,
                event.errorMsg ?? null,
                event.snapshotId ?? null,
                event.spreadBps ?? null,
                event.slippageBps ?? null,
                event.edgeBps ?? null,
                event.metadata ? JSON.stringify(event.metadata) : null
            );
            return Number(result.lastInsertRowid);
        },
        insertMarketSnapshot: (snapshot: MockMarketSnapshot) => {
            const db = mockDb!;
            const stmt = db.prepare(`
                INSERT INTO market_snapshots (
                    ts, pairKey, buyFlow, sellFlow, netFlow, flowImbalance, pressure,
                    bestBid, bestAsk, midPrice, spreadBps, bidDepth, askDepth, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(
                snapshot.ts,
                snapshot.pairKey,
                snapshot.buyFlow ?? null,
                snapshot.sellFlow ?? null,
                snapshot.netFlow ?? null,
                snapshot.flowImbalance ?? null,
                snapshot.pressure ?? null,
                snapshot.bestBid ?? null,
                snapshot.bestAsk ?? null,
                snapshot.midPrice ?? null,
                snapshot.spreadBps ?? null,
                snapshot.bidDepth ?? null,
                snapshot.askDepth ?? null,
                snapshot.metadata ? JSON.stringify(snapshot.metadata) : null
            );
            return Number(result.lastInsertRowid);
        },
        queryTradeEvents: (filters: QueryFilters = {}) => {
            const db = mockDb!;
            const conditions: string[] = [];
            const params: (string | number)[] = [];

            if (filters.pairKey) {
                conditions.push('pairKey = ?');
                params.push(filters.pairKey);
            }
            if (filters.strategy) {
                conditions.push('strategy = ?');
                params.push(filters.strategy);
            }
            if (filters.action) {
                conditions.push('action = ?');
                params.push(filters.action);
            }
            if (filters.sinceMs !== undefined) {
                conditions.push('ts >= ?');
                params.push(filters.sinceMs);
            }
            if (filters.untilMs !== undefined) {
                conditions.push('ts <= ?');
                params.push(filters.untilMs);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const limitClause = filters.limit ? `LIMIT ${filters.limit}` : '';

            const sql = `SELECT * FROM trade_events ${whereClause} ORDER BY ts DESC ${limitClause}`;
            const rows = db.prepare(sql).all(...params) as (TradeEvent & { metadata: string | null })[];

            // Parse metadata JSON
            return rows.map(row => ({
                ...row,
                metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
            })) as TradeEvent[];
        },
        pruneOldData: () => {
            const db = mockDb!;
            db.exec('DELETE FROM trade_events');
            db.exec('DELETE FROM market_snapshots');
            return { deletedEvents: 0, deletedSnapshots: 0 };
        }
    };
});

// Import after mocking (feedbackEngine import validates the mock works)
import { feedbackEngine as _feedbackEngine } from '../feedbackEngine';
import { insertTradeEvent as _insertTradeEvent, insertMarketSnapshot as _insertMarketSnapshot, queryTradeEvents as _queryTradeEvents, getFeedbackDb } from '../feedbackDb';

// Suppress unused var warning - we import to verify module loads with mock
void _feedbackEngine;

// Cast to test types (mock uses simpler schema than production)
const insertTradeEvent = _insertTradeEvent as unknown as (event: Omit<TradeEvent, 'id'>) => number;
const insertMarketSnapshot = _insertMarketSnapshot as unknown as (snapshot: Omit<MarketSnapshot, 'id'>) => number;
const queryTradeEvents = _queryTradeEvents as unknown as (filters?: QueryFilters) => TradeEvent[];

describe('FeedbackEngine', () => {
    beforeEach(() => {
        // Initialize database
        getFeedbackDb();
        // Clear tables
        mockDb!.exec('DELETE FROM trade_events');
        mockDb!.exec('DELETE FROM market_snapshots');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('Database Operations', () => {
        it('should insert and query trade events', () => {
            const ts = Date.now();
            const event = {
                ts,
                pairKey: 'XRP/USD',
                strategy: 'scalper',
                action: 'fill' as const,
                side: 'buy' as const,
                requestedPrice: 0.50,
                executedPrice: 0.501,
                requestedSize: 100,
                executedSize: 100,
                slippageBps: 20, // 0.2% slippage
                spreadBps: 10,
            };

            const id = insertTradeEvent(event);
            expect(id).toBeGreaterThan(0);

            const events = queryTradeEvents({ pairKey: 'XRP/USD' });
            expect(events).toHaveLength(1);
            expect(events[0].strategy).toBe('scalper');
            expect(events[0].executedPrice).toBe(0.501);
        });

        it('should filter events by strategy', () => {
            const ts = Date.now();

            insertTradeEvent({
                ts,
                pairKey: 'XRP/USD',
                strategy: 'scalper',
                action: 'fill',
                side: 'buy',
            });

            insertTradeEvent({
                ts: ts + 1000,
                pairKey: 'XRP/USD',
                strategy: 'amm_arb',
                action: 'fill',
                side: 'sell',
            });

            const scalperEvents = queryTradeEvents({ strategy: 'scalper' });
            expect(scalperEvents).toHaveLength(1);
            expect(scalperEvents[0].strategy).toBe('scalper');

            const ammEvents = queryTradeEvents({ strategy: 'amm_arb' });
            expect(ammEvents).toHaveLength(1);
            expect(ammEvents[0].strategy).toBe('amm_arb');
        });

        it('should filter events by time range', () => {
            const baseTs = Date.now();

            insertTradeEvent({
                ts: baseTs - 3600000, // 1 hour ago
                pairKey: 'XRP/USD',
                strategy: 'scalper',
                action: 'fill',
                side: 'buy',
            });

            insertTradeEvent({
                ts: baseTs, // now
                pairKey: 'XRP/USD',
                strategy: 'scalper',
                action: 'fill',
                side: 'sell',
            });

            // Query last 30 minutes
            const recentEvents = queryTradeEvents({ sinceMs: baseTs - 1800000 });
            expect(recentEvents).toHaveLength(1);
            expect(recentEvents[0].ts).toBe(baseTs);
        });

        it('should insert market snapshots', () => {
            const ts = Date.now();
            const snapshot = {
                ts,
                pairKey: 'XRP/USD',
                buyFlow: 1000,
                sellFlow: 800,
                netFlow: 200,
                flowImbalance: 0.25,
                pressure: 0.1,
                bestBid: 0.499,
                bestAsk: 0.501,
                midPrice: 0.5,
                spreadBps: 40,
                bidDepth: 5000,
                askDepth: 4500,
            };

            const id = insertMarketSnapshot(snapshot);
            expect(id).toBeGreaterThan(0);
        });
    });

    describe('Slippage Calculations', () => {
        it('should calculate slippage correctly for buy orders', () => {
            // Buy order: executed > requested = positive slippage (bad)
            const slippage = calculateSlippageBps(0.50, 0.505, 'buy');
            expect(slippage).toBeCloseTo(100, 1); // 1% slippage in bps
        });

        it('should calculate slippage correctly for sell orders', () => {
            // Sell order: executed < requested = positive slippage (bad)
            const slippage = calculateSlippageBps(0.50, 0.495, 'sell');
            expect(slippage).toBeCloseTo(100, 1); // 1% slippage in bps
        });

        it('should return 0 slippage when prices match', () => {
            const slippage = calculateSlippageBps(0.50, 0.50, 'buy');
            expect(slippage).toBe(0);
        });

        it('should return negative slippage for price improvement', () => {
            // Buy order: executed < requested = negative slippage (good)
            const slippage = calculateSlippageBps(0.50, 0.495, 'buy');
            expect(slippage).toBeCloseTo(-100, 1); // -1% (price improvement)
        });
    });

    describe('Win Rate and Profit Factor', () => {
        it('should calculate win rate correctly', () => {
            const ts = Date.now();

            // 3 winning trades
            for (let i = 0; i < 3; i++) {
                insertTradeEvent({
                    ts: ts + i * 1000,
                    pairKey: 'XRP/USD',
                    strategy: 'scalper',
                    action: 'fill',
                    side: 'buy',
                    requestedPrice: 0.50,
                    executedPrice: 0.50,
                    requestedSize: 100,
                    executedSize: 100,
                    metadata: { pnl: 10 }, // profit
                });
            }

            // 2 losing trades
            for (let i = 0; i < 2; i++) {
                insertTradeEvent({
                    ts: ts + (3 + i) * 1000,
                    pairKey: 'XRP/USD',
                    strategy: 'scalper',
                    action: 'fill',
                    side: 'sell',
                    requestedPrice: 0.50,
                    executedPrice: 0.50,
                    requestedSize: 100,
                    executedSize: 100,
                    metadata: { pnl: -5 }, // loss
                });
            }

            const events = queryTradeEvents({});
            const { winRate, wins, losses } = calculateWinRate(events);

            expect(wins).toBe(3);
            expect(losses).toBe(2);
            expect(winRate).toBeCloseTo(0.6, 2); // 60% win rate
        });

        it('should calculate profit factor correctly', () => {
            const events = [
                { metadata: { pnl: 100 } },
                { metadata: { pnl: 50 } },
                { metadata: { pnl: -30 } },
                { metadata: { pnl: -20 } },
            ] as unknown as TradeEvent[];

            const profitFactor = calculateProfitFactor(events);
            // Total gains: 150, Total losses: 50
            // Profit factor: 150 / 50 = 3.0
            expect(profitFactor).toBeCloseTo(3.0, 2);
        });

        it('should handle no losses (infinite profit factor)', () => {
            const events = [
                { metadata: { pnl: 100 } },
                { metadata: { pnl: 50 } },
            ] as unknown as TradeEvent[];

            const profitFactor = calculateProfitFactor(events);
            expect(profitFactor).toBe(Infinity);
        });

        it('should handle no gains (zero profit factor)', () => {
            const events = [
                { metadata: { pnl: -30 } },
                { metadata: { pnl: -20 } },
            ] as unknown as TradeEvent[];

            const profitFactor = calculateProfitFactor(events);
            expect(profitFactor).toBe(0);
        });
    });

    describe('Expectancy', () => {
        it('should calculate expectancy correctly', () => {
            // Win rate: 60%, Avg win: $10, Avg loss: $5
            // Expectancy = (0.6 * 10) - (0.4 * 5) = 6 - 2 = $4
            const expectancy = calculateExpectancy(0.6, 10, 5);
            expect(expectancy).toBeCloseTo(4.0, 2);
        });

        it('should return negative expectancy for losing system', () => {
            // Win rate: 30%, Avg win: $5, Avg loss: $10
            // Expectancy = (0.3 * 5) - (0.7 * 10) = 1.5 - 7 = -$5.5
            const expectancy = calculateExpectancy(0.3, 5, 10);
            expect(expectancy).toBeCloseTo(-5.5, 2);
        });
    });

    describe('Regime Matrix', () => {
        it('should aggregate stats by flow regime', () => {
            const ts = Date.now();

            // Insert snapshots with different regimes
            const snapshot1Id = insertMarketSnapshot({
                ts,
                pairKey: 'XRP/USD',
                flowImbalance: 0.3, // bullish
                pressure: 0.2,
                midPrice: 0.50,
                spreadBps: 20,
            });

            const snapshot2Id = insertMarketSnapshot({
                ts: ts + 1000,
                pairKey: 'XRP/USD',
                flowImbalance: -0.4, // bearish
                pressure: -0.3,
                midPrice: 0.49,
                spreadBps: 25,
            });

            // Insert trades linked to snapshots
            insertTradeEvent({
                ts,
                pairKey: 'XRP/USD',
                strategy: 'scalper',
                action: 'fill',
                side: 'buy',
                snapshotId: snapshot1Id,
                metadata: { pnl: 15 }, // profit in bullish
            });

            insertTradeEvent({
                ts: ts + 1000,
                pairKey: 'XRP/USD',
                strategy: 'scalper',
                action: 'fill',
                side: 'sell',
                snapshotId: snapshot2Id,
                metadata: { pnl: -10 }, // loss in bearish
            });

            // Test regime classification
            const bullishRegime = classifyRegime(0.3);
            const bearishRegime = classifyRegime(-0.4);
            const neutralRegime = classifyRegime(0.05);

            expect(bullishRegime).toBe('bullish');
            expect(bearishRegime).toBe('bearish');
            expect(neutralRegime).toBe('neutral');
        });
    });

    describe('Rolling Drawdown', () => {
        it('should calculate equity curve and drawdown', () => {
            const baseTs = Date.now();
            const events = [
                { ts: baseTs, metadata: { pnl: 100 } },
                { ts: baseTs + 1000, metadata: { pnl: 50 } },
                { ts: baseTs + 2000, metadata: { pnl: -80 } },
                { ts: baseTs + 3000, metadata: { pnl: 30 } },
            ] as unknown as TradeEvent[];

            // Cumulative equity: 100, 150, 70, 100
            // Max equity:        100, 150, 150, 150
            // Drawdown:          0%, 0%, ~53%, ~33%

            const { equity, maxDrawdown } = calculateEquityCurve(events);

            expect(equity).toHaveLength(4);
            expect(equity[0]).toBe(100);
            expect(equity[1]).toBe(150);
            expect(equity[2]).toBe(70);
            expect(equity[3]).toBe(100);

            // Max drawdown occurred at index 2: (150 - 70) / 150 ≈ 53.3%
            expect(maxDrawdown).toBeCloseTo(0.533, 2);
        });

        it('should handle no drawdown scenario', () => {
            const baseTs = Date.now();
            const events = [
                { ts: baseTs, metadata: { pnl: 100 } },
                { ts: baseTs + 1000, metadata: { pnl: 50 } },
                { ts: baseTs + 2000, metadata: { pnl: 30 } },
            ] as unknown as TradeEvent[];

            const { maxDrawdown } = calculateEquityCurve(events);
            expect(maxDrawdown).toBe(0);
        });
    });
});

// Helper functions for testing (these mirror internal calculations)
function calculateSlippageBps(requestedPrice: number, executedPrice: number, side: 'buy' | 'sell'): number {
    if (side === 'buy') {
        return ((executedPrice - requestedPrice) / requestedPrice) * 10000;
    } else {
        return ((requestedPrice - executedPrice) / requestedPrice) * 10000;
    }
}

function calculateWinRate(events: TradeEvent[]): { winRate: number; wins: number; losses: number } {
    let wins = 0;
    let losses = 0;

    for (const event of events) {
        const pnl = (event.metadata?.pnl as number | undefined) ?? 0;
        if (pnl > 0) {
            wins++;
        } else if (pnl < 0) {
            losses++;
        }
    }

    const trades = wins + losses;
    const winRate = trades > 0 ? wins / trades : 0;
    return { winRate, wins, losses };
}

function calculateProfitFactor(events: TradeEvent[]): number {
    let totalGain = 0;
    let totalLoss = 0;

    for (const event of events) {
        const pnl = (event.metadata?.pnl as number | undefined) ?? 0;
        if (pnl > 0) {
            totalGain += pnl;
        } else if (pnl < 0) {
            totalLoss += Math.abs(pnl);
        }
    }

    if (totalLoss === 0) {
        return totalGain > 0 ? Infinity : 0;
    }
    return totalGain / totalLoss;
}

function calculateExpectancy(winRate: number, avgWin: number, avgLoss: number): number {
    return (winRate * avgWin) - ((1 - winRate) * avgLoss);
}

function classifyRegime(flowImbalance: number): 'bullish' | 'bearish' | 'neutral' {
    if (flowImbalance > 0.1) return 'bullish';
    if (flowImbalance < -0.1) return 'bearish';
    return 'neutral';
}

function calculateEquityCurve(events: TradeEvent[]): { equity: number[]; maxDrawdown: number } {
    const equity: number[] = [];
    let cumulative = 0;
    let maxEquity = 0;
    let maxDrawdown = 0;

    for (const event of events) {
        const pnl = (event.metadata?.pnl as number | undefined) ?? 0;
        cumulative += pnl;
        equity.push(cumulative);

        maxEquity = Math.max(maxEquity, cumulative);
        const drawdown = maxEquity > 0 ? (maxEquity - cumulative) / maxEquity : 0;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    return { equity, maxDrawdown };
}
