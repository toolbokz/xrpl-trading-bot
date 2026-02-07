/**
 * Instrument Registry — SQLite Database Layer
 *
 * Follows the established singleton + WAL + prepared statement pattern
 * from feedbackDb.ts and exposureStore.ts.
 *
 * Tables:
 *   - instruments: trading pair definitions
 *   - issuers:     issuer address catalog
 *
 * @module market/instrumentRegistry/db
 */

import Database, { Database as DatabaseType, Statement } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../../analytics/logger';
import {
    Instrument,
    IssuerRecord,
    CurrencySide,
    LiquidityLevel,
    Network,
    RegistryStatus,
    IssuerTier,
    SEED_INSTRUMENTS,
    SEED_ISSUERS,
} from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Row shape from the instruments table. */
interface InstrumentRow {
    key: string;
    baseCurrency: string;
    baseIssuer: string | null;
    quoteCurrency: string;
    quoteIssuer: string | null;
    description: string;
    liquidity: string;
    network: string;
    status: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
}

/** Row shape from the issuers table. */
interface IssuerRow {
    address: string;
    label: string;
    currency: string;
    tier: string;
    network: string;
    status: string;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

interface PreparedStatements {
    // Instruments
    upsertInstrument: Statement;
    getInstrument: Statement;
    listInstruments: Statement;
    listInstrumentsByNetwork: Statement;
    listActiveInstruments: Statement;
    listActiveByNetwork: Statement;
    updateInstrumentStatus: Statement;
    updateInstrumentLiquidity: Statement;
    deleteInstrument: Statement;
    countInstruments: Statement;

    // Issuers
    upsertIssuer: Statement;
    getIssuer: Statement;
    listIssuers: Statement;
    listIssuersByCurrency: Statement;
    listIssuersByNetwork: Statement;
    listActiveIssuersByCurrency: Statement;
    updateIssuerStatus: Statement;
    updateIssuerTier: Statement;
    deleteIssuer: Statement;
    countIssuers: Statement;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

function initSchema(db: DatabaseType): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS instruments (
            key TEXT PRIMARY KEY,
            baseCurrency TEXT NOT NULL,
            baseIssuer TEXT,
            quoteCurrency TEXT NOT NULL,
            quoteIssuer TEXT,
            description TEXT NOT NULL DEFAULT '',
            liquidity TEXT NOT NULL DEFAULT 'unknown',
            network TEXT NOT NULL DEFAULT 'mainnet',
            status TEXT NOT NULL DEFAULT 'active',
            sortOrder INTEGER NOT NULL DEFAULT 999,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS issuers (
            address TEXT NOT NULL,
            currency TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            tier TEXT NOT NULL DEFAULT 'untrusted',
            network TEXT NOT NULL DEFAULT 'mainnet',
            status TEXT NOT NULL DEFAULT 'active',
            notes TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            PRIMARY KEY (address, currency)
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_instruments_network ON instruments(network);
    `);
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_instruments_status ON instruments(status);
    `);
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_issuers_currency ON issuers(currency);
    `);
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_issuers_network ON issuers(network);
    `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepared Statements
// ─────────────────────────────────────────────────────────────────────────────

function createStatements(db: DatabaseType): PreparedStatements {
    return {
        // ── Instruments ──
        upsertInstrument: db.prepare(`
            INSERT INTO instruments (key, baseCurrency, baseIssuer, quoteCurrency, quoteIssuer, description, liquidity, network, status, sortOrder, createdAt, updatedAt)
            VALUES (@key, @baseCurrency, @baseIssuer, @quoteCurrency, @quoteIssuer, @description, @liquidity, @network, @status, @sortOrder, @createdAt, @updatedAt)
            ON CONFLICT(key) DO UPDATE SET
                baseCurrency = @baseCurrency,
                baseIssuer = @baseIssuer,
                quoteCurrency = @quoteCurrency,
                quoteIssuer = @quoteIssuer,
                description = @description,
                liquidity = @liquidity,
                network = @network,
                status = @status,
                sortOrder = @sortOrder,
                updatedAt = @updatedAt
        `),
        getInstrument: db.prepare(`SELECT * FROM instruments WHERE key = ?`),
        listInstruments: db.prepare(`SELECT * FROM instruments ORDER BY sortOrder ASC, key ASC`),
        listInstrumentsByNetwork: db.prepare(`SELECT * FROM instruments WHERE network = ? ORDER BY sortOrder ASC, key ASC`),
        listActiveInstruments: db.prepare(`SELECT * FROM instruments WHERE status = 'active' ORDER BY sortOrder ASC, key ASC`),
        listActiveByNetwork: db.prepare(`SELECT * FROM instruments WHERE status = 'active' AND network = ? ORDER BY sortOrder ASC, key ASC`),
        updateInstrumentStatus: db.prepare(`UPDATE instruments SET status = @status, updatedAt = @updatedAt WHERE key = @key`),
        updateInstrumentLiquidity: db.prepare(`UPDATE instruments SET liquidity = @liquidity, updatedAt = @updatedAt WHERE key = @key`),
        deleteInstrument: db.prepare(`DELETE FROM instruments WHERE key = ?`),
        countInstruments: db.prepare(`SELECT COUNT(*) as count FROM instruments`),

        // ── Issuers ──
        upsertIssuer: db.prepare(`
            INSERT INTO issuers (address, currency, label, tier, network, status, notes, createdAt, updatedAt)
            VALUES (@address, @currency, @label, @tier, @network, @status, @notes, @createdAt, @updatedAt)
            ON CONFLICT(address, currency) DO UPDATE SET
                label = @label,
                tier = @tier,
                network = @network,
                status = @status,
                notes = @notes,
                updatedAt = @updatedAt
        `),
        getIssuer: db.prepare(`SELECT * FROM issuers WHERE address = ? AND currency = ?`),
        listIssuers: db.prepare(`SELECT * FROM issuers ORDER BY tier ASC, label ASC`),
        listIssuersByCurrency: db.prepare(`SELECT * FROM issuers WHERE currency = ? ORDER BY tier ASC, label ASC`),
        listIssuersByNetwork: db.prepare(`SELECT * FROM issuers WHERE network = ? ORDER BY tier ASC, label ASC`),
        listActiveIssuersByCurrency: db.prepare(`SELECT * FROM issuers WHERE currency = ? AND status = 'active' ORDER BY tier ASC, label ASC`),
        updateIssuerStatus: db.prepare(`UPDATE issuers SET status = @status, updatedAt = @updatedAt WHERE address = @address AND currency = @currency`),
        updateIssuerTier: db.prepare(`UPDATE issuers SET tier = @tier, updatedAt = @updatedAt WHERE address = @address AND currency = @currency`),
        deleteIssuer: db.prepare(`DELETE FROM issuers WHERE address = ? AND currency = ?`),
        countIssuers: db.prepare(`SELECT COUNT(*) as count FROM issuers`),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Row ↔ Domain Converters
// ─────────────────────────────────────────────────────────────────────────────

function rowToInstrument(row: InstrumentRow): Instrument {
    const base: CurrencySide = { currency: row.baseCurrency };
    if (row.baseIssuer) base.issuer = row.baseIssuer;

    const quote: CurrencySide = { currency: row.quoteCurrency };
    if (row.quoteIssuer) quote.issuer = row.quoteIssuer;

    return {
        key: row.key,
        base,
        quote,
        description: row.description,
        liquidity: row.liquidity as LiquidityLevel,
        network: row.network as Network,
        status: row.status as RegistryStatus,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function instrumentToRow(inst: Instrument): Record<string, unknown> {
    return {
        key: inst.key,
        baseCurrency: inst.base.currency,
        baseIssuer: inst.base.issuer ?? null,
        quoteCurrency: inst.quote.currency,
        quoteIssuer: inst.quote.issuer ?? null,
        description: inst.description,
        liquidity: inst.liquidity,
        network: inst.network,
        status: inst.status,
        sortOrder: inst.sortOrder,
        createdAt: inst.createdAt,
        updatedAt: inst.updatedAt,
    };
}

function rowToIssuer(row: IssuerRow): IssuerRecord {
    return {
        address: row.address,
        label: row.label,
        currency: row.currency,
        tier: row.tier as IssuerTier,
        network: row.network as Network,
        status: row.status as RegistryStatus,
        notes: row.notes ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function issuerToRow(issuer: IssuerRecord): Record<string, unknown> {
    return {
        address: issuer.address,
        label: issuer.label,
        currency: issuer.currency,
        tier: issuer.tier,
        network: issuer.network,
        status: issuer.status,
        notes: issuer.notes ?? null,
        createdAt: issuer.createdAt,
        updatedAt: issuer.updatedAt,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(process.cwd(), 'data', 'instruments.sqlite');

let dbInstance: DatabaseType | null = null;
let stmts: PreparedStatements | null = null;

function ensureDir(dbPath: string): void {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

/**
 * Seed the database with built-in instruments and issuers
 * if the tables are empty. This is idempotent — existing data wins.
 */
function seedIfEmpty(db: DatabaseType, s: PreparedStatements): void {
    const instrumentCount = (s.countInstruments.get() as { count: number }).count;
    if (instrumentCount === 0) {
        logger.info({ count: SEED_INSTRUMENTS.length }, 'Seeding instrument registry with built-in instruments');
        const insertMany = db.transaction(() => {
            for (const inst of SEED_INSTRUMENTS) {
                s.upsertInstrument.run(instrumentToRow(inst));
            }
        });
        insertMany();
    }

    const issuerCount = (s.countIssuers.get() as { count: number }).count;
    if (issuerCount === 0) {
        logger.info({ count: SEED_ISSUERS.length }, 'Seeding instrument registry with built-in issuers');
        const insertMany = db.transaction(() => {
            for (const issuer of SEED_ISSUERS) {
                s.upsertIssuer.run(issuerToRow(issuer));
            }
        });
        insertMany();
    }
}

/**
 * Get or create the instrument registry database.
 */
export function getRegistryDb(): DatabaseType {
    if (dbInstance) return dbInstance;

    const dbPath = process.env.INSTRUMENT_DB_PATH || DEFAULT_DB_PATH;
    ensureDir(dbPath);

    try {
        dbInstance = new Database(dbPath);
        dbInstance.pragma('journal_mode = WAL');
        dbInstance.pragma('synchronous = NORMAL');
        initSchema(dbInstance);
        stmts = createStatements(dbInstance);
        seedIfEmpty(dbInstance, stmts);
        logger.info({ dbPath }, 'Instrument registry database initialized');
        return dbInstance;
    } catch (err) {
        logger.error({ err, dbPath }, 'Failed to initialize instrument registry database');
        throw err;
    }
}

function getStmts(): PreparedStatements {
    if (!stmts) getRegistryDb();
    return stmts!;
}

/**
 * Close the instrument registry database.
 */
export function closeRegistryDb(): void {
    if (dbInstance) {
        try {
            dbInstance.close();
        } catch (err) {
            logger.warn({ err }, 'Error closing instrument registry database');
        }
        dbInstance = null;
        stmts = null;
    }
}

/**
 * Reset the singleton (for testing).
 * Closes DB and clears all cached references.
 */
export function resetRegistryDb(): void {
    closeRegistryDb();
}

// ─────────────────────────────────────────────────────────────────────────────
// Instrument CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get an instrument by key. Returns null if not found.
 */
export function dbGetInstrument(key: string): Instrument | null {
    const row = getStmts().getInstrument.get(key) as InstrumentRow | undefined;
    return row ? rowToInstrument(row) : null;
}

/**
 * Upsert (insert or update) an instrument.
 */
export function dbUpsertInstrument(inst: Instrument): void {
    getStmts().upsertInstrument.run(instrumentToRow(inst));
}

/**
 * List all instruments, optionally filtered.
 */
export function dbListInstruments(filter?: {
    network?: Network | undefined;
    activeOnly?: boolean | undefined;
}): Instrument[] {
    const s = getStmts();
    let rows: InstrumentRow[];

    if (filter?.activeOnly && filter?.network) {
        rows = s.listActiveByNetwork.all(filter.network) as InstrumentRow[];
    } else if (filter?.activeOnly) {
        rows = s.listActiveInstruments.all() as InstrumentRow[];
    } else if (filter?.network) {
        rows = s.listInstrumentsByNetwork.all(filter.network) as InstrumentRow[];
    } else {
        rows = s.listInstruments.all() as InstrumentRow[];
    }

    return rows.map(rowToInstrument);
}

/**
 * Update instrument status (active/disabled/delisted).
 */
export function dbUpdateInstrumentStatus(key: string, status: RegistryStatus): boolean {
    const result = getStmts().updateInstrumentStatus.run({
        key,
        status,
        updatedAt: new Date().toISOString(),
    });
    return result.changes > 0;
}

/**
 * Update instrument liquidity level.
 */
export function dbUpdateInstrumentLiquidity(key: string, liquidity: LiquidityLevel): boolean {
    const result = getStmts().updateInstrumentLiquidity.run({
        key,
        liquidity,
        updatedAt: new Date().toISOString(),
    });
    return result.changes > 0;
}

/**
 * Delete an instrument by key.
 */
export function dbDeleteInstrument(key: string): boolean {
    const result = getStmts().deleteInstrument.run(key);
    return result.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issuer CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get an issuer by address and currency. Returns null if not found.
 */
export function dbGetIssuer(address: string, currency: string): IssuerRecord | null {
    const row = getStmts().getIssuer.get(address, currency) as IssuerRow | undefined;
    return row ? rowToIssuer(row) : null;
}

/**
 * Upsert (insert or update) an issuer.
 */
export function dbUpsertIssuer(issuer: IssuerRecord): void {
    getStmts().upsertIssuer.run(issuerToRow(issuer));
}

/**
 * List all issuers, optionally filtered.
 */
export function dbListIssuers(filter?: {
    currency?: string | undefined;
    network?: Network | undefined;
    activeOnly?: boolean | undefined;
}): IssuerRecord[] {
    const s = getStmts();
    let rows: IssuerRow[];

    if (filter?.activeOnly && filter?.currency) {
        rows = s.listActiveIssuersByCurrency.all(filter.currency) as IssuerRow[];
    } else if (filter?.currency) {
        rows = s.listIssuersByCurrency.all(filter.currency) as IssuerRow[];
    } else if (filter?.network) {
        rows = s.listIssuersByNetwork.all(filter.network) as IssuerRow[];
    } else {
        rows = s.listIssuers.all() as IssuerRow[];
    }

    return rows.map(rowToIssuer);
}

/**
 * Update issuer status (active/disabled/delisted).
 */
export function dbUpdateIssuerStatus(address: string, currency: string, status: RegistryStatus): boolean {
    const result = getStmts().updateIssuerStatus.run({
        address,
        currency,
        status,
        updatedAt: new Date().toISOString(),
    });
    return result.changes > 0;
}

/**
 * Update issuer tier.
 */
export function dbUpdateIssuerTier(address: string, currency: string, tier: IssuerTier): boolean {
    const result = getStmts().updateIssuerTier.run({
        address,
        currency,
        tier,
        updatedAt: new Date().toISOString(),
    });
    return result.changes > 0;
}

/**
 * Delete an issuer.
 */
export function dbDeleteIssuer(address: string, currency: string): boolean {
    const result = getStmts().deleteIssuer.run(address, currency);
    return result.changes > 0;
}
