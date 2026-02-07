/**
 * Exposure Persistence — SQLite-Backed Durable Position Tracking
 *
 * Replaces in-memory-only ExposureTracker with durable state that
 * survives restarts. Uses the existing better-sqlite3 dependency.
 *
 * Tables:
 *   - exposure_fills: individual fill records for audit trail
 *   - exposure_state: current net position per pair (rehydration source)
 *
 * @module persistence/exposureStore
 */

import Database, { Database as DatabaseType, Statement } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExposureFillRecord {
    id: string;
    ts: number;
    pairKey: string;
    side: 'buy' | 'sell';
    sizeBase: number;
    price: number;
    netPositionAfter: number;
    correlationId: string | null;
}

export interface ExposureStateRecord {
    pairKey: string;
    netPositionBase: number;
    totalBought: number;
    totalSold: number;
    fillCount: number;
    lastFillMs: number;
    lastMidPrice: number;
    updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(process.cwd(), 'data', 'exposure.sqlite');

let dbInstance: DatabaseType | null = null;

interface PreparedStmts {
    insertFill: Statement;
    upsertState: Statement;
    getState: Statement;
    getAllStates: Statement;
    getRecentFills: Statement;
    pruneOldFills: Statement;
}

let stmts: PreparedStmts | null = null;

function ensureDir(dbPath: string): void {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function initSchema(db: DatabaseType): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS exposure_fills (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            pairKey TEXT NOT NULL,
            side TEXT NOT NULL,
            sizeBase REAL NOT NULL,
            price REAL NOT NULL,
            netPositionAfter REAL NOT NULL,
            correlationId TEXT
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS exposure_state (
            pairKey TEXT PRIMARY KEY,
            netPositionBase REAL NOT NULL DEFAULT 0,
            totalBought REAL NOT NULL DEFAULT 0,
            totalSold REAL NOT NULL DEFAULT 0,
            fillCount INTEGER NOT NULL DEFAULT 0,
            lastFillMs INTEGER NOT NULL DEFAULT 0,
            lastMidPrice REAL NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL DEFAULT 0
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exposure_fills_pair_ts ON exposure_fills(pairKey, ts);
    `);
}

function createStatements(db: DatabaseType): PreparedStmts {
    return {
        insertFill: db.prepare(`
            INSERT INTO exposure_fills (id, ts, pairKey, side, sizeBase, price, netPositionAfter, correlationId)
            VALUES (@id, @ts, @pairKey, @side, @sizeBase, @price, @netPositionAfter, @correlationId)
        `),
        upsertState: db.prepare(`
            INSERT INTO exposure_state (pairKey, netPositionBase, totalBought, totalSold, fillCount, lastFillMs, lastMidPrice, updatedAt)
            VALUES (@pairKey, @netPositionBase, @totalBought, @totalSold, @fillCount, @lastFillMs, @lastMidPrice, @updatedAt)
            ON CONFLICT(pairKey) DO UPDATE SET
                netPositionBase = @netPositionBase,
                totalBought = @totalBought,
                totalSold = @totalSold,
                fillCount = @fillCount,
                lastFillMs = @lastFillMs,
                lastMidPrice = @lastMidPrice,
                updatedAt = @updatedAt
        `),
        getState: db.prepare(`
            SELECT * FROM exposure_state WHERE pairKey = ?
        `),
        getAllStates: db.prepare(`
            SELECT * FROM exposure_state
        `),
        getRecentFills: db.prepare(`
            SELECT * FROM exposure_fills WHERE pairKey = ? ORDER BY ts DESC LIMIT ?
        `),
        pruneOldFills: db.prepare(`
            DELETE FROM exposure_fills WHERE ts < ?
        `),
    };
}

/**
 * Get or create the exposure database.
 */
export function getExposureDb(): DatabaseType {
    if (dbInstance) return dbInstance;

    const dbPath = process.env.EXPOSURE_DB_PATH || DEFAULT_DB_PATH;
    ensureDir(dbPath);

    try {
        dbInstance = new Database(dbPath);
        dbInstance.pragma('journal_mode = WAL');
        dbInstance.pragma('synchronous = NORMAL');
        initSchema(dbInstance);
        stmts = createStatements(dbInstance);
        logger.info({ dbPath }, 'Exposure database initialized');
        return dbInstance;
    } catch (err) {
        logger.error({ err, dbPath }, 'Failed to initialize exposure database');
        throw err;
    }
}

function getStmts(): PreparedStmts {
    if (!stmts) getExposureDb();
    return stmts!;
}

/**
 * Close the exposure database.
 */
export function closeExposureDb(): void {
    if (dbInstance) {
        try {
            dbInstance.close();
        } catch (err) {
            logger.warn({ err }, 'Error closing exposure database');
        }
        dbInstance = null;
        stmts = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a fill and update the aggregate state atomically.
 */
export function persistFillAndState(
    fill: ExposureFillRecord,
    state: ExposureStateRecord,
): void {
    const db = getExposureDb();
    const s = getStmts();

    try {
        db.transaction(() => {
            s.insertFill.run({
                id: fill.id,
                ts: fill.ts,
                pairKey: fill.pairKey,
                side: fill.side,
                sizeBase: fill.sizeBase,
                price: fill.price,
                netPositionAfter: fill.netPositionAfter,
                correlationId: fill.correlationId,
            });
            s.upsertState.run({
                pairKey: state.pairKey,
                netPositionBase: state.netPositionBase,
                totalBought: state.totalBought,
                totalSold: state.totalSold,
                fillCount: state.fillCount,
                lastFillMs: state.lastFillMs,
                lastMidPrice: state.lastMidPrice,
                updatedAt: state.updatedAt,
            });
        })();
    } catch (err) {
        logger.warn({ err, fillId: fill.id }, 'Failed to persist fill + state');
    }
}

/**
 * Load the last saved exposure state for a pair (for rehydration).
 */
export function loadExposureState(pairKey: string): ExposureStateRecord | null {
    try {
        const row = getStmts().getState.get(pairKey) as ExposureStateRecord | undefined;
        return row ?? null;
    } catch (err) {
        logger.warn({ err, pairKey }, 'Failed to load exposure state');
        return null;
    }
}

/**
 * Load all saved exposure states (for startup).
 */
export function loadAllExposureStates(): ExposureStateRecord[] {
    try {
        return getStmts().getAllStates.all() as ExposureStateRecord[];
    } catch (err) {
        logger.warn({ err }, 'Failed to load all exposure states');
        return [];
    }
}

/**
 * Get recent fills for a pair.
 */
export function getRecentExposureFills(pairKey: string, limit: number = 50): ExposureFillRecord[] {
    try {
        return getStmts().getRecentFills.all(pairKey, limit) as ExposureFillRecord[];
    } catch (err) {
        logger.warn({ err, pairKey }, 'Failed to get recent exposure fills');
        return [];
    }
}

/**
 * Prune old fill records beyond retention.
 */
export function pruneExposureFills(retentionDays: number = 30): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    try {
        const result = getStmts().pruneOldFills.run(cutoff);
        return result.changes;
    } catch (err) {
        logger.warn({ err }, 'Failed to prune exposure fills');
        return 0;
    }
}

/**
 * Save state without a fill (e.g., mid-price update or reconciliation).
 */
export function saveExposureState(state: ExposureStateRecord): void {
    try {
        getStmts().upsertState.run({
            pairKey: state.pairKey,
            netPositionBase: state.netPositionBase,
            totalBought: state.totalBought,
            totalSold: state.totalSold,
            fillCount: state.fillCount,
            lastFillMs: state.lastFillMs,
            lastMidPrice: state.lastMidPrice,
            updatedAt: state.updatedAt,
        });
    } catch (err) {
        logger.warn({ err, pairKey: state.pairKey }, 'Failed to save exposure state');
    }
}
