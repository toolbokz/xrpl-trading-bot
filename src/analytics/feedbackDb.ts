/**
 * Feedback Database Module
 * 
 * SQLite-based persistence for trade events and market snapshots.
 * Used by FeedbackEngine to record and query trading analytics.
 * 
 * Features:
 * - WAL mode for reliability
 * - Prepared statements for performance
 * - Automatic pruning of old data
 * - Singleton pattern for connection reuse
 */

import Database, { Database as DatabaseType, Statement } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from './logger';
import { FlowRegime } from '../market/flowMetrics';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Action types for trade events
 */
export type TradeAction = 'offer_create' | 'offer_cancel' | 'fill' | 'reject' | 'error';

/**
 * Trade event record for database storage
 */
export interface TradeEventRecord {
    id: string;
    ts: number;
    pairKey: string;
    strategy: string;
    action: TradeAction;
    side: 'buy' | 'sell' | null;
    intentPrice: number | null;
    intentSizeBase: number | null;
    intentSizeQuote: number | null;
    fillPrice: number | null;
    fillSizeBase: number | null;
    fillSizeQuote: number | null;
    txHash: string | null;
    ledgerIndex: number | null;
    resultCode: string | null;
    error: string | null;
    isBotTrade: number | null; // 1 = true, 0 = false, null = unknown
    midPriceAtDecision: number | null;
}

/**
 * Market snapshot record for database storage
 */
export interface MarketSnapshotRecord {
    id: string;
    ts: number;
    pairKey: string;
    ledgerIndex: number | null;
    midPrice: number | null;
    spreadBps: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    bidDepthBase: number | null;
    askDepthBase: number | null;
    flowRegime: FlowRegime | null;
    flowImbalance: number | null;
    flowDepthImbalance: number | null;
    flowCombined: number | null;
    flowStrength: number | null;
    vwap: number | null;
    vwapDeviationBps: number | null;
    tradeCount: number | null;
    volumeVelocity: number | null;
}

/**
 * Database configuration
 */
export interface FeedbackDbConfig {
    /** Path to SQLite database file */
    dbPath: string;
    /** Number of days to retain data (default: 30) */
    retentionDays: number;
    /** Enable verbose SQL logging (default: false) */
    verbose: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(process.cwd(), 'data', 'feedback.sqlite');
const DEFAULT_RETENTION_DAYS = 30;

function getConfigFromEnv(): FeedbackDbConfig {
    return {
        dbPath: process.env.FEEDBACK_DB_PATH || DEFAULT_DB_PATH,
        retentionDays: parseInt(process.env.FEEDBACK_RETENTION_DAYS || '', 10) || DEFAULT_RETENTION_DAYS,
        verbose: process.env.FEEDBACK_DB_VERBOSE === 'true',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Singleton
// ─────────────────────────────────────────────────────────────────────────────

let dbInstance: DatabaseType | null = null;
let preparedStatements: PreparedStatements | null = null;

interface PreparedStatements {
    insertTradeEvent: Statement;
    insertSnapshot: Statement;
    pruneTradeEvents: Statement;
    pruneSnapshots: Statement;
}

/**
 * Ensure the data directory exists
 */
function ensureDataDir(dbPath: string): void {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        logger.info({ dir }, 'Created feedback database directory');
    }
}

/**
 * Initialize database schema
 */
function initSchema(db: DatabaseType): void {
    // Create trade_events table
    db.exec(`
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
            midPriceAtDecision REAL
        )
    `);

    // Create market_snapshots table
    db.exec(`
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
        )
    `);

    // Create indices for efficient queries
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trade_events_pair_ts ON trade_events(pairKey, ts);
        CREATE INDEX IF NOT EXISTS idx_trade_events_strategy_ts ON trade_events(strategy, ts);
        CREATE INDEX IF NOT EXISTS idx_trade_events_regime ON trade_events(ts);
        CREATE INDEX IF NOT EXISTS idx_trade_events_txhash ON trade_events(txHash);
        CREATE INDEX IF NOT EXISTS idx_snapshots_pair_ts ON market_snapshots(pairKey, ts);
        CREATE INDEX IF NOT EXISTS idx_snapshots_regime_ts ON market_snapshots(flowRegime, ts);
    `);

    logger.debug('Feedback database schema initialized');
}

/**
 * Create prepared statements for performance
 */
function createPreparedStatements(db: DatabaseType): PreparedStatements {
    return {
        insertTradeEvent: db.prepare(`
            INSERT INTO trade_events (
                id, ts, pairKey, strategy, action, side,
                intentPrice, intentSizeBase, intentSizeQuote,
                fillPrice, fillSizeBase, fillSizeQuote,
                txHash, ledgerIndex, resultCode, error, isBotTrade, midPriceAtDecision
            ) VALUES (
                @id, @ts, @pairKey, @strategy, @action, @side,
                @intentPrice, @intentSizeBase, @intentSizeQuote,
                @fillPrice, @fillSizeBase, @fillSizeQuote,
                @txHash, @ledgerIndex, @resultCode, @error, @isBotTrade, @midPriceAtDecision
            )
        `),
        insertSnapshot: db.prepare(`
            INSERT INTO market_snapshots (
                id, ts, pairKey, ledgerIndex, midPrice, spreadBps,
                bestBid, bestAsk, bidDepthBase, askDepthBase,
                flowRegime, flowImbalance, flowDepthImbalance, flowCombined, flowStrength,
                vwap, vwapDeviationBps, tradeCount, volumeVelocity
            ) VALUES (
                @id, @ts, @pairKey, @ledgerIndex, @midPrice, @spreadBps,
                @bestBid, @bestAsk, @bidDepthBase, @askDepthBase,
                @flowRegime, @flowImbalance, @flowDepthImbalance, @flowCombined, @flowStrength,
                @vwap, @vwapDeviationBps, @tradeCount, @volumeVelocity
            )
        `),
        pruneTradeEvents: db.prepare(`
            DELETE FROM trade_events WHERE ts < ?
        `),
        pruneSnapshots: db.prepare(`
            DELETE FROM market_snapshots WHERE ts < ?
        `),
    };
}

/**
 * Get or create database instance (singleton)
 */
export function getFeedbackDb(): DatabaseType {
    if (dbInstance) {
        return dbInstance;
    }

    const config = getConfigFromEnv();
    ensureDataDir(config.dbPath);

    try {
        dbInstance = new Database(config.dbPath, {
            verbose: config.verbose ? (sql) => logger.debug({ sql }, 'SQL') : undefined,
        });

        // Enable WAL mode for better reliability
        dbInstance.pragma('journal_mode = WAL');
        dbInstance.pragma('synchronous = NORMAL');
        dbInstance.pragma('cache_size = -64000'); // 64MB cache

        initSchema(dbInstance);
        preparedStatements = createPreparedStatements(dbInstance);

        logger.info({ dbPath: config.dbPath }, 'Feedback database initialized');
        return dbInstance;
    } catch (err) {
        logger.error({ err, dbPath: config.dbPath }, 'Failed to initialize feedback database');
        throw err;
    }
}

/**
 * Get prepared statements (must call getFeedbackDb first)
 */
export function getStatements(): PreparedStatements {
    if (!preparedStatements) {
        getFeedbackDb(); // Initialize if needed
    }
    return preparedStatements!;
}

/**
 * Close database connection
 */
export function closeFeedbackDb(): void {
    if (dbInstance) {
        try {
            dbInstance.close();
            dbInstance = null;
            preparedStatements = null;
            logger.info('Feedback database closed');
        } catch (err) {
            logger.warn({ err }, 'Error closing feedback database');
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a unique ID for records
 */
export function generateId(): string {
    const ts = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `${ts}-${random}`;
}

/**
 * Insert a trade event
 */
export function insertTradeEvent(event: TradeEventRecord): void {
    try {
        const stmt = getStatements().insertTradeEvent;
        stmt.run({
            id: event.id,
            ts: event.ts,
            pairKey: event.pairKey,
            strategy: event.strategy,
            action: event.action,
            side: event.side,
            intentPrice: event.intentPrice,
            intentSizeBase: event.intentSizeBase,
            intentSizeQuote: event.intentSizeQuote,
            fillPrice: event.fillPrice,
            fillSizeBase: event.fillSizeBase,
            fillSizeQuote: event.fillSizeQuote,
            txHash: event.txHash,
            ledgerIndex: event.ledgerIndex,
            resultCode: event.resultCode,
            error: event.error,
            isBotTrade: event.isBotTrade,
            midPriceAtDecision: event.midPriceAtDecision,
        });
    } catch (err) {
        logger.warn({ err, eventId: event.id }, 'Failed to insert trade event');
    }
}

/**
 * Insert a market snapshot
 */
export function insertMarketSnapshot(snapshot: MarketSnapshotRecord): void {
    try {
        const stmt = getStatements().insertSnapshot;
        stmt.run({
            id: snapshot.id,
            ts: snapshot.ts,
            pairKey: snapshot.pairKey,
            ledgerIndex: snapshot.ledgerIndex,
            midPrice: snapshot.midPrice,
            spreadBps: snapshot.spreadBps,
            bestBid: snapshot.bestBid,
            bestAsk: snapshot.bestAsk,
            bidDepthBase: snapshot.bidDepthBase,
            askDepthBase: snapshot.askDepthBase,
            flowRegime: snapshot.flowRegime,
            flowImbalance: snapshot.flowImbalance,
            flowDepthImbalance: snapshot.flowDepthImbalance,
            flowCombined: snapshot.flowCombined,
            flowStrength: snapshot.flowStrength,
            vwap: snapshot.vwap,
            vwapDeviationBps: snapshot.vwapDeviationBps,
            tradeCount: snapshot.tradeCount,
            volumeVelocity: snapshot.volumeVelocity,
        });
    } catch (err) {
        logger.warn({ err, snapshotId: snapshot.id }, 'Failed to insert market snapshot');
    }
}

/**
 * Batch insert trade events and snapshot in a transaction
 */
export function insertBatch(events: TradeEventRecord[], snapshot?: MarketSnapshotRecord): void {
    const db = getFeedbackDb();
    const stmts = getStatements();

    try {
        db.transaction(() => {
            for (const event of events) {
                stmts.insertTradeEvent.run({
                    id: event.id,
                    ts: event.ts,
                    pairKey: event.pairKey,
                    strategy: event.strategy,
                    action: event.action,
                    side: event.side,
                    intentPrice: event.intentPrice,
                    intentSizeBase: event.intentSizeBase,
                    intentSizeQuote: event.intentSizeQuote,
                    fillPrice: event.fillPrice,
                    fillSizeBase: event.fillSizeBase,
                    fillSizeQuote: event.fillSizeQuote,
                    txHash: event.txHash,
                    ledgerIndex: event.ledgerIndex,
                    resultCode: event.resultCode,
                    error: event.error,
                    isBotTrade: event.isBotTrade,
                    midPriceAtDecision: event.midPriceAtDecision,
                });
            }
            if (snapshot) {
                stmts.insertSnapshot.run({
                    id: snapshot.id,
                    ts: snapshot.ts,
                    pairKey: snapshot.pairKey,
                    ledgerIndex: snapshot.ledgerIndex,
                    midPrice: snapshot.midPrice,
                    spreadBps: snapshot.spreadBps,
                    bestBid: snapshot.bestBid,
                    bestAsk: snapshot.bestAsk,
                    bidDepthBase: snapshot.bidDepthBase,
                    askDepthBase: snapshot.askDepthBase,
                    flowRegime: snapshot.flowRegime,
                    flowImbalance: snapshot.flowImbalance,
                    flowDepthImbalance: snapshot.flowDepthImbalance,
                    flowCombined: snapshot.flowCombined,
                    flowStrength: snapshot.flowStrength,
                    vwap: snapshot.vwap,
                    vwapDeviationBps: snapshot.vwapDeviationBps,
                    tradeCount: snapshot.tradeCount,
                    volumeVelocity: snapshot.volumeVelocity,
                });
            }
        })();
    } catch (err) {
        logger.warn({ err, eventCount: events.length }, 'Failed to insert batch');
    }
}

/**
 * Prune old data based on retention policy
 */
export function pruneOldData(retentionDays?: number): { eventsDeleted: number; snapshotsDeleted: number } {
    const config = getConfigFromEnv();
    const days = retentionDays ?? config.retentionDays;
    const cutoffTs = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
        const stmts = getStatements();
        const eventsResult = stmts.pruneTradeEvents.run(cutoffTs);
        const snapshotsResult = stmts.pruneSnapshots.run(cutoffTs);

        const result = {
            eventsDeleted: eventsResult.changes,
            snapshotsDeleted: snapshotsResult.changes,
        };

        if (result.eventsDeleted > 0 || result.snapshotsDeleted > 0) {
            logger.info({ ...result, retentionDays: days }, 'Pruned old feedback data');
        }

        return result;
    } catch (err) {
        logger.warn({ err }, 'Failed to prune old data');
        return { eventsDeleted: 0, snapshotsDeleted: 0 };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Operations
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryFilters {
    pairKey?: string;
    sinceMs?: number;
    strategy?: string;
    regime?: FlowRegime;
}

/**
 * Get trade events with optional filters
 */
export function queryTradeEvents(filters: QueryFilters = {}): TradeEventRecord[] {
    const db = getFeedbackDb();
    let sql = 'SELECT * FROM trade_events WHERE 1=1';
    const params: any[] = [];

    if (filters.pairKey) {
        sql += ' AND pairKey = ?';
        params.push(filters.pairKey);
    }
    if (filters.sinceMs) {
        sql += ' AND ts >= ?';
        params.push(filters.sinceMs);
    }
    if (filters.strategy) {
        sql += ' AND strategy = ?';
        params.push(filters.strategy);
    }

    sql += ' ORDER BY ts DESC';

    try {
        return db.prepare(sql).all(...params) as TradeEventRecord[];
    } catch (err) {
        logger.warn({ err, filters }, 'Failed to query trade events');
        return [];
    }
}

/**
 * Get market snapshots with optional filters
 */
export function querySnapshots(filters: QueryFilters = {}): MarketSnapshotRecord[] {
    const db = getFeedbackDb();
    let sql = 'SELECT * FROM market_snapshots WHERE 1=1';
    const params: any[] = [];

    if (filters.pairKey) {
        sql += ' AND pairKey = ?';
        params.push(filters.pairKey);
    }
    if (filters.sinceMs) {
        sql += ' AND ts >= ?';
        params.push(filters.sinceMs);
    }
    if (filters.regime) {
        sql += ' AND flowRegime = ?';
        params.push(filters.regime);
    }

    sql += ' ORDER BY ts DESC';

    try {
        return db.prepare(sql).all(...params) as MarketSnapshotRecord[];
    } catch (err) {
        logger.warn({ err, filters }, 'Failed to query snapshots');
        return [];
    }
}

/**
 * Get the most recent snapshot for a pair
 */
export function getLatestSnapshot(pairKey: string): MarketSnapshotRecord | null {
    const db = getFeedbackDb();
    try {
        return db.prepare(`
            SELECT * FROM market_snapshots 
            WHERE pairKey = ? 
            ORDER BY ts DESC 
            LIMIT 1
        `).get(pairKey) as MarketSnapshotRecord | null;
    } catch (err) {
        logger.warn({ err, pairKey }, 'Failed to get latest snapshot');
        return null;
    }
}

/**
 * Get snapshot closest to a given timestamp (for correlating with trades)
 */
export function getSnapshotNear(pairKey: string, ts: number, toleranceMs: number = 5000): MarketSnapshotRecord | null {
    const db = getFeedbackDb();
    try {
        return db.prepare(`
            SELECT * FROM market_snapshots 
            WHERE pairKey = ? AND ts BETWEEN ? AND ?
            ORDER BY ABS(ts - ?) 
            LIMIT 1
        `).get(pairKey, ts - toleranceMs, ts + toleranceMs, ts) as MarketSnapshotRecord | null;
    } catch (err) {
        logger.warn({ err, pairKey, ts }, 'Failed to get snapshot near timestamp');
        return null;
    }
}

/**
 * Count records for statistics
 */
export function countRecords(): { tradeEvents: number; snapshots: number } {
    const db = getFeedbackDb();
    try {
        const events = db.prepare('SELECT COUNT(*) as count FROM trade_events').get() as { count: number };
        const snapshots = db.prepare('SELECT COUNT(*) as count FROM market_snapshots').get() as { count: number };
        return {
            tradeEvents: events.count,
            snapshots: snapshots.count,
        };
    } catch (err) {
        logger.warn({ err }, 'Failed to count records');
        return { tradeEvents: 0, snapshots: 0 };
    }
}
