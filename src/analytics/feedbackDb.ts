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
import { canonicalizePairKey, getPairKeyAliases } from '../xrpl/currency';

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
    // Cost realism fields
    slippageBpsVsIntent: number | null;
    slippageBpsVsMid: number | null;
    slippageBpsVsBbo?: number | null;
    expectedPriceSource?: 'intent' | 'mid' | 'bbo' | 'fallback_intent' | null;
    decisionMidPrice?: number | null;
    decisionBestBid?: number | null;
    decisionBestAsk?: number | null;
    spreadPaidBps: number | null;
    edgeBpsVsMid: number | null;
    netEdgeBpsVsMid: number | null;
    txFeeXrp: number | null;
    ammFeeBps: number | null;
    fillRatio: number | null;
    isPartial: number | null; // 1 = true, 0 = false
    // Entry snapshot (captured at decision time)
    entrySpreadBps: number | null;
    entryFlowCombined: number | null;
    entryFlowStrength: number | null;
    entryFlowRegime: FlowRegime | null;
    // Post-fill snapshots (captured after fill)
    postMid1s: number | null;
    postSpread1s: number | null;
    postFlowCombined1s: number | null;
    postFlowStrength1s: number | null;
    postFlowRegime1s: FlowRegime | null;
    postMid3s: number | null;
    postSpread3s: number | null;
    postFlowCombined3s: number | null;
    postFlowStrength3s: number | null;
    postFlowRegime3s: FlowRegime | null;
    // Beginner-friendly edge fields
    entryMid: number | null;
    entrySignalStrength: number | null;
    entryLocalExtreme: number | null; // 1 = true, 0 = false, null = unknown
    postSignal1s: number | null;
    postSignal3s: number | null;
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
    /** 1 = adverse selection risk detected, 0 = not detected, null = unknown */
    adverseSelectionRisk: number | null;
}

export interface ExecutionQualityEventRecord {
    id: string;
    ts: number;
    eventId: string | null;
    txHash: string | null;
    pairKeyCanonical: string;
    pairAliases: string | null; // JSON array
    side: 'buy' | 'sell' | null;
    strategy: string | null;
    regime: FlowRegime | null;
    source: 'bot' | 'manual' | 'unknown';
    venue?: string | null;
    intentPrice: number | null;
    expectedPrice: number | null;
    expectedPriceSource: 'intent' | 'mid' | 'bbo' | 'fallback_intent' | null;
    baselineTs?: number | null;
    baselineBestBid?: number | null;
    baselineBestAsk?: number | null;
    baselineMid?: number | null;
    baselineSpreadBps?: number | null;
    baselineSource?: string | null;
    expectedRule?: string | null;
    slippageBaselineUsed?: string | null;
    priceConvention?: 'quote_per_base' | 'base_per_quote' | null;
    baselineBookAgeMs?: number | null;
    fillTs?: number | null;
    decisionMid: number | null;
    decisionBid: number | null;
    decisionAsk: number | null;
    fillPrice: number | null;
    amountBase: number | null;
    filledBase: number | null;
    filledQuote: number | null;
    slippageBpsVsIntent: number | null;
    slippageBpsVsMid: number | null;
    slippageBpsVsBbo: number | null;
    effSpreadBps: number | null;
    realizedSpreadBps1m: number | null;
    realizedSpreadBps5m: number | null;
    impactBps1m: number | null;
    impactBps5m: number | null;
    implShortfallQuote: number | null;
    fillRatio: number | null;
    status: string | null;
    rejectReason: string | null;
    flags: string | null; // JSON array
    guardQuarantined: number | null; // 1=true, 0=false, null=unknown
    decisionTs: number | null;
    submitTs: number | null;
    submitResponseTs?: number | null;
    validatedTs: number | null;
    submitResultEngine?: string | null;
    submitError?: string | null;
    decisionToSubmitMs: number | null;
    submitToValidatedMs: number | null;
    decisionToValidatedMs: number | null;
}

export interface EdgeAttributionEventRecord {
    id: string;
    ts: number;
    eventId: string | null;
    txHash: string | null;
    pairKeyCanonical: string;
    pairAliases: string | null; // JSON array
    side: 'buy' | 'sell' | null;
    strategy: string | null;
    regime: FlowRegime | null;
    source: 'bot' | 'manual' | 'unknown';
    midDecision: number | null;
    bidDecision: number | null;
    askDecision: number | null;
    fillPrice: number | null;
    midFill: number | null;
    mid1m: number | null;
    mid5m: number | null;
    baseFilled: number | null;
    filledQuote: number | null;
    signalEdgeBpsExAnte: number | null;
    signalEdgeBpsExPost1m: number | null;
    signalEdgeBpsExPost5m: number | null;
    executionEdgeBpsVsMid: number | null;
    executionEdgeBpsVsBbo: number | null;
    driftBps1m: number | null;
    driftBps5m: number | null;
    pnlExecQuote: number | null;
    pnlDriftQuote1m: number | null;
    pnlTotalQuote1m: number | null;
    pnlDriftQuote5m: number | null;
    pnlTotalQuote5m: number | null;
    hasDecisionSnapshot: number | null;
    hasHorizon1m: number | null;
    hasHorizon5m: number | null;
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
    insertExecutionQualityEvent: Statement;
    updateExecutionQualityHorizons: Statement;
    insertEdgeAttributionEvent: Statement;
    updateEdgeAttributionHorizons: Statement;
    updateTradeEventPostFill1s: Statement;
    updateTradeEventPostFill3s: Statement;
    pruneTradeEvents: Statement;
    pruneSnapshots: Statement;
    pruneExecutionQualityEvents: Statement;
    pruneEdgeAttributionEvents: Statement;
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
            midPriceAtDecision REAL,
            slippageBpsVsIntent REAL,
            slippageBpsVsMid REAL,
            slippageBpsVsBbo REAL,
            expectedPriceSource TEXT,
            decisionMidPrice REAL,
            decisionBestBid REAL,
            decisionBestAsk REAL,
            spreadPaidBps REAL,
            edgeBpsVsMid REAL,
            netEdgeBpsVsMid REAL,
            txFeeXrp REAL,
            ammFeeBps REAL,
            fillRatio REAL,
            isPartial INTEGER,
            entrySpreadBps REAL,
            entryFlowCombined REAL,
            entryFlowStrength REAL,
            entryFlowRegime TEXT,
            postMid1s REAL,
            postSpread1s REAL,
            postFlowCombined1s REAL,
            postFlowStrength1s REAL,
            postFlowRegime1s TEXT,
            postMid3s REAL,
            postSpread3s REAL,
            postFlowCombined3s REAL,
            postFlowStrength3s REAL,
            postFlowRegime3s TEXT,
            entryMid REAL,
            entrySignalStrength REAL,
            entryLocalExtreme INTEGER,
            postSignal1s REAL,
            postSignal3s REAL
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

    db.exec(`
        CREATE TABLE IF NOT EXISTS execution_quality_events (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            eventId TEXT,
            txHash TEXT,
            pairKeyCanonical TEXT NOT NULL,
            pairAliases TEXT,
            side TEXT,
            strategy TEXT,
            regime TEXT,
            source TEXT,
            venue TEXT,
            intentPrice REAL,
            expectedPrice REAL,
            expectedPriceSource TEXT,
            baselineTs INTEGER,
            baselineBestBid REAL,
            baselineBestAsk REAL,
            baselineMid REAL,
            baselineSpreadBps REAL,
            baselineSource TEXT,
            expectedRule TEXT,
            slippageBaselineUsed TEXT,
            priceConvention TEXT,
            baselineBookAgeMs REAL,
            fillTs INTEGER,
            decisionMid REAL,
            decisionBid REAL,
            decisionAsk REAL,
            fillPrice REAL,
            amountBase REAL,
            filledBase REAL,
            filledQuote REAL,
            slippageBpsVsIntent REAL,
            slippageBpsVsMid REAL,
            slippageBpsVsBbo REAL,
            effSpreadBps REAL,
            realizedSpreadBps1m REAL,
            realizedSpreadBps5m REAL,
            impactBps1m REAL,
            impactBps5m REAL,
            implShortfallQuote REAL,
            fillRatio REAL,
            status TEXT,
            rejectReason TEXT,
            flags TEXT,
            guardQuarantined INTEGER,
            decisionTs INTEGER,
            submitTs INTEGER,
            submitResponseTs INTEGER,
            validatedTs INTEGER,
            submitResultEngine TEXT,
            submitError TEXT,
            decisionToSubmitMs INTEGER,
            submitToValidatedMs INTEGER,
            decisionToValidatedMs INTEGER
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS edge_attribution_events (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            eventId TEXT,
            txHash TEXT,
            pairKeyCanonical TEXT NOT NULL,
            pairAliases TEXT,
            side TEXT,
            strategy TEXT,
            regime TEXT,
            source TEXT,
            midDecision REAL,
            bidDecision REAL,
            askDecision REAL,
            fillPrice REAL,
            midFill REAL,
            mid1m REAL,
            mid5m REAL,
            baseFilled REAL,
            filledQuote REAL,
            signalEdgeBpsExAnte REAL,
            signalEdgeBpsExPost1m REAL,
            signalEdgeBpsExPost5m REAL,
            executionEdgeBpsVsMid REAL,
            executionEdgeBpsVsBbo REAL,
            driftBps1m REAL,
            driftBps5m REAL,
            pnlExecQuote REAL,
            pnlDriftQuote1m REAL,
            pnlTotalQuote1m REAL,
            pnlDriftQuote5m REAL,
            pnlTotalQuote5m REAL,
            hasDecisionSnapshot INTEGER,
            hasHorizon1m INTEGER,
            hasHorizon5m INTEGER
        )
    `);

    // Create indices for efficient queries
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trade_events_pair_ts ON trade_events(pairKey, ts);
        CREATE INDEX IF NOT EXISTS idx_trade_events_strategy_ts ON trade_events(strategy, ts);
        CREATE INDEX IF NOT EXISTS idx_trade_events_regime ON trade_events(ts);
        CREATE INDEX IF NOT EXISTS idx_trade_events_txhash ON trade_events(txHash);
        CREATE INDEX IF NOT EXISTS idx_trade_events_pair_strategy_ts_desc ON trade_events(pairKey, strategy, ts DESC);
        CREATE INDEX IF NOT EXISTS idx_trade_events_pair_action_ts_desc ON trade_events(pairKey, action, ts DESC);
        CREATE INDEX IF NOT EXISTS idx_snapshots_pair_ts ON market_snapshots(pairKey, ts);
        CREATE INDEX IF NOT EXISTS idx_snapshots_regime_ts ON market_snapshots(flowRegime, ts);
        CREATE INDEX IF NOT EXISTS idx_eq_events_pair_ts ON execution_quality_events(pairKeyCanonical, ts);
        CREATE INDEX IF NOT EXISTS idx_eq_events_strategy_ts ON execution_quality_events(strategy, ts);
        CREATE INDEX IF NOT EXISTS idx_eq_events_side_ts ON execution_quality_events(side, ts);
        CREATE INDEX IF NOT EXISTS idx_eq_events_source_ts ON execution_quality_events(source, ts);
        CREATE INDEX IF NOT EXISTS idx_eq_events_regime_ts ON execution_quality_events(regime, ts);
        CREATE INDEX IF NOT EXISTS idx_eq_events_txhash ON execution_quality_events(txHash);
        CREATE INDEX IF NOT EXISTS idx_eq_events_pair_strategy_side_source_ts_desc
            ON execution_quality_events(pairKeyCanonical, strategy, side, source, ts DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_eq_events_txhash_not_null_unique
            ON execution_quality_events(txHash) WHERE txHash IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_edge_attr_pair_ts ON edge_attribution_events(pairKeyCanonical, ts);
        CREATE INDEX IF NOT EXISTS idx_edge_attr_strategy_ts ON edge_attribution_events(strategy, ts);
        CREATE INDEX IF NOT EXISTS idx_edge_attr_side_ts ON edge_attribution_events(side, ts);
        CREATE INDEX IF NOT EXISTS idx_edge_attr_regime_ts ON edge_attribution_events(regime, ts);
        CREATE INDEX IF NOT EXISTS idx_edge_attr_source_ts ON edge_attribution_events(source, ts);
        CREATE INDEX IF NOT EXISTS idx_edge_attr_txhash ON edge_attribution_events(txHash);
        CREATE INDEX IF NOT EXISTS idx_edge_attr_pair_strategy_side_source_ts_desc
            ON edge_attribution_events(pairKeyCanonical, strategy, side, source, ts DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_attr_txhash_not_null_unique
            ON edge_attribution_events(txHash) WHERE txHash IS NOT NULL;
    `);

    logger.debug('Feedback database schema initialized');
}

/**
 * Cost realism columns to add to existing databases
 */
const TRADE_EVENT_EXTRA_COLUMNS = {
    slippageBpsVsIntent: 'REAL',
    slippageBpsVsMid: 'REAL',
    slippageBpsVsBbo: 'REAL',
    expectedPriceSource: 'TEXT',
    decisionMidPrice: 'REAL',
    decisionBestBid: 'REAL',
    decisionBestAsk: 'REAL',
    spreadPaidBps: 'REAL',
    edgeBpsVsMid: 'REAL',
    netEdgeBpsVsMid: 'REAL',
    txFeeXrp: 'REAL',
    ammFeeBps: 'REAL',
    fillRatio: 'REAL',
    isPartial: 'INTEGER',
    entrySpreadBps: 'REAL',
    entryFlowCombined: 'REAL',
    entryFlowStrength: 'REAL',
    entryFlowRegime: 'TEXT',
    postMid1s: 'REAL',
    postSpread1s: 'REAL',
    postFlowCombined1s: 'REAL',
    postFlowStrength1s: 'REAL',
    postFlowRegime1s: 'TEXT',
    postMid3s: 'REAL',
    postSpread3s: 'REAL',
    postFlowCombined3s: 'REAL',
    postFlowStrength3s: 'REAL',
    postFlowRegime3s: 'TEXT',
    entryMid: 'REAL',
    entrySignalStrength: 'REAL',
    entryLocalExtreme: 'INTEGER',
    postSignal1s: 'REAL',
    postSignal3s: 'REAL',
} as const;

/**
 * Snapshot columns added after initial schema (migration)
 */
const SNAPSHOT_EXTRA_COLUMNS = {
    adverseSelectionRisk: 'INTEGER',
} as const;

/**
 * Execution quality columns (for forward-compatible migrations)
 */
const EXECUTION_QUALITY_EXTRA_COLUMNS = {
    eventId: 'TEXT',
    txHash: 'TEXT',
    pairKeyCanonical: 'TEXT',
    pairAliases: 'TEXT',
    side: 'TEXT',
    strategy: 'TEXT',
    regime: 'TEXT',
    source: 'TEXT',
    venue: 'TEXT',
    intentPrice: 'REAL',
    expectedPrice: 'REAL',
    expectedPriceSource: 'TEXT',
    baselineTs: 'INTEGER',
    baselineBestBid: 'REAL',
    baselineBestAsk: 'REAL',
    baselineMid: 'REAL',
    baselineSpreadBps: 'REAL',
    baselineSource: 'TEXT',
    expectedRule: 'TEXT',
    slippageBaselineUsed: 'TEXT',
    priceConvention: 'TEXT',
    baselineBookAgeMs: 'REAL',
    fillTs: 'INTEGER',
    decisionMid: 'REAL',
    decisionBid: 'REAL',
    decisionAsk: 'REAL',
    fillPrice: 'REAL',
    amountBase: 'REAL',
    filledBase: 'REAL',
    filledQuote: 'REAL',
    slippageBpsVsIntent: 'REAL',
    slippageBpsVsMid: 'REAL',
    slippageBpsVsBbo: 'REAL',
    effSpreadBps: 'REAL',
    realizedSpreadBps1m: 'REAL',
    realizedSpreadBps5m: 'REAL',
    impactBps1m: 'REAL',
    impactBps5m: 'REAL',
    implShortfallQuote: 'REAL',
    fillRatio: 'REAL',
    status: 'TEXT',
    rejectReason: 'TEXT',
    flags: 'TEXT',
    guardQuarantined: 'INTEGER',
    decisionTs: 'INTEGER',
    submitTs: 'INTEGER',
    submitResponseTs: 'INTEGER',
    validatedTs: 'INTEGER',
    submitResultEngine: 'TEXT',
    submitError: 'TEXT',
    decisionToSubmitMs: 'INTEGER',
    submitToValidatedMs: 'INTEGER',
    decisionToValidatedMs: 'INTEGER',
} as const;

const EDGE_ATTRIBUTION_EXTRA_COLUMNS = {
    eventId: 'TEXT',
    txHash: 'TEXT',
    pairKeyCanonical: 'TEXT',
    pairAliases: 'TEXT',
    side: 'TEXT',
    strategy: 'TEXT',
    regime: 'TEXT',
    source: 'TEXT',
    midDecision: 'REAL',
    bidDecision: 'REAL',
    askDecision: 'REAL',
    fillPrice: 'REAL',
    midFill: 'REAL',
    mid1m: 'REAL',
    mid5m: 'REAL',
    baseFilled: 'REAL',
    filledQuote: 'REAL',
    signalEdgeBpsExAnte: 'REAL',
    signalEdgeBpsExPost1m: 'REAL',
    signalEdgeBpsExPost5m: 'REAL',
    executionEdgeBpsVsMid: 'REAL',
    executionEdgeBpsVsBbo: 'REAL',
    driftBps1m: 'REAL',
    driftBps5m: 'REAL',
    pnlExecQuote: 'REAL',
    pnlDriftQuote1m: 'REAL',
    pnlTotalQuote1m: 'REAL',
    pnlDriftQuote5m: 'REAL',
    pnlTotalQuote5m: 'REAL',
    hasDecisionSnapshot: 'INTEGER',
    hasHorizon1m: 'INTEGER',
    hasHorizon5m: 'INTEGER',
} as const;

/**
 * Ensure columns exist on a table (for migrations without a full migration system)
 * Uses PRAGMA table_info to check existing columns and ALTER TABLE to add missing ones
 */
function ensureColumns(db: DatabaseType, table: string, columns: Record<string, string>): void {
    try {
        const existingCols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
        const existingNames = new Set(existingCols.map(c => c.name));

        const added: string[] = [];
        for (const [name, type] of Object.entries(columns)) {
            if (!existingNames.has(name)) {
                db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
                added.push(name);
            }
        }

        if (added.length > 0) {
            logger.info({ table, columns: added }, 'Added missing columns to feedback database');
        }
    } catch (err) {
        logger.warn({ err, table }, 'Failed to ensure columns exist');
    }
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
                txHash, ledgerIndex, resultCode, error, isBotTrade, midPriceAtDecision,
                slippageBpsVsIntent, slippageBpsVsMid, slippageBpsVsBbo,
                expectedPriceSource, decisionMidPrice, decisionBestBid, decisionBestAsk,
                spreadPaidBps,
                edgeBpsVsMid, netEdgeBpsVsMid, txFeeXrp, ammFeeBps, fillRatio, isPartial,
                entrySpreadBps, entryFlowCombined, entryFlowStrength, entryFlowRegime,
                postMid1s, postSpread1s, postFlowCombined1s, postFlowStrength1s, postFlowRegime1s,
                postMid3s, postSpread3s, postFlowCombined3s, postFlowStrength3s, postFlowRegime3s,
                entryMid, entrySignalStrength, entryLocalExtreme, postSignal1s, postSignal3s
            ) VALUES (
                @id, @ts, @pairKey, @strategy, @action, @side,
                @intentPrice, @intentSizeBase, @intentSizeQuote,
                @fillPrice, @fillSizeBase, @fillSizeQuote,
                @txHash, @ledgerIndex, @resultCode, @error, @isBotTrade, @midPriceAtDecision,
                @slippageBpsVsIntent, @slippageBpsVsMid, @slippageBpsVsBbo,
                @expectedPriceSource, @decisionMidPrice, @decisionBestBid, @decisionBestAsk,
                @spreadPaidBps,
                @edgeBpsVsMid, @netEdgeBpsVsMid, @txFeeXrp, @ammFeeBps, @fillRatio, @isPartial,
                @entrySpreadBps, @entryFlowCombined, @entryFlowStrength, @entryFlowRegime,
                @postMid1s, @postSpread1s, @postFlowCombined1s, @postFlowStrength1s, @postFlowRegime1s,
                @postMid3s, @postSpread3s, @postFlowCombined3s, @postFlowStrength3s, @postFlowRegime3s,
                @entryMid, @entrySignalStrength, @entryLocalExtreme, @postSignal1s, @postSignal3s
            )
        `),
        insertExecutionQualityEvent: db.prepare(`
            INSERT OR IGNORE INTO execution_quality_events (
                id, ts, eventId, txHash, pairKeyCanonical, pairAliases,
                side, strategy, regime, source, venue,
                intentPrice, expectedPrice, expectedPriceSource,
                baselineTs, baselineBestBid, baselineBestAsk, baselineMid, baselineSpreadBps,
                baselineSource, expectedRule, slippageBaselineUsed, priceConvention, baselineBookAgeMs, fillTs,
                decisionMid, decisionBid, decisionAsk, fillPrice,
                amountBase, filledBase, filledQuote,
                slippageBpsVsIntent, slippageBpsVsMid, slippageBpsVsBbo,
                effSpreadBps, realizedSpreadBps1m, realizedSpreadBps5m,
                impactBps1m, impactBps5m, implShortfallQuote, fillRatio,
                status, rejectReason, flags, guardQuarantined,
                decisionTs, submitTs, submitResponseTs, validatedTs,
                submitResultEngine, submitError,
                decisionToSubmitMs, submitToValidatedMs, decisionToValidatedMs
            ) VALUES (
                @id, @ts, @eventId, @txHash, @pairKeyCanonical, @pairAliases,
                @side, @strategy, @regime, @source, @venue,
                @intentPrice, @expectedPrice, @expectedPriceSource,
                @baselineTs, @baselineBestBid, @baselineBestAsk, @baselineMid, @baselineSpreadBps,
                @baselineSource, @expectedRule, @slippageBaselineUsed, @priceConvention, @baselineBookAgeMs, @fillTs,
                @decisionMid, @decisionBid, @decisionAsk, @fillPrice,
                @amountBase, @filledBase, @filledQuote,
                @slippageBpsVsIntent, @slippageBpsVsMid, @slippageBpsVsBbo,
                @effSpreadBps, @realizedSpreadBps1m, @realizedSpreadBps5m,
                @impactBps1m, @impactBps5m, @implShortfallQuote, @fillRatio,
                @status, @rejectReason, @flags, @guardQuarantined,
                @decisionTs, @submitTs, @submitResponseTs, @validatedTs,
                @submitResultEngine, @submitError,
                @decisionToSubmitMs, @submitToValidatedMs, @decisionToValidatedMs
            )
        `),
        updateExecutionQualityHorizons: db.prepare(`
            UPDATE execution_quality_events
            SET realizedSpreadBps1m = COALESCE(@realizedSpreadBps1m, realizedSpreadBps1m),
                realizedSpreadBps5m = COALESCE(@realizedSpreadBps5m, realizedSpreadBps5m),
                impactBps1m = COALESCE(@impactBps1m, impactBps1m),
                impactBps5m = COALESCE(@impactBps5m, impactBps5m)
            WHERE id = @id
        `),
        insertEdgeAttributionEvent: db.prepare(`
            INSERT OR IGNORE INTO edge_attribution_events (
                id, ts, eventId, txHash, pairKeyCanonical, pairAliases,
                side, strategy, regime, source,
                midDecision, bidDecision, askDecision, fillPrice,
                midFill, mid1m, mid5m,
                baseFilled, filledQuote,
                signalEdgeBpsExAnte, signalEdgeBpsExPost1m, signalEdgeBpsExPost5m,
                executionEdgeBpsVsMid, executionEdgeBpsVsBbo,
                driftBps1m, driftBps5m,
                pnlExecQuote, pnlDriftQuote1m, pnlTotalQuote1m, pnlDriftQuote5m, pnlTotalQuote5m,
                hasDecisionSnapshot, hasHorizon1m, hasHorizon5m
            ) VALUES (
                @id, @ts, @eventId, @txHash, @pairKeyCanonical, @pairAliases,
                @side, @strategy, @regime, @source,
                @midDecision, @bidDecision, @askDecision, @fillPrice,
                @midFill, @mid1m, @mid5m,
                @baseFilled, @filledQuote,
                @signalEdgeBpsExAnte, @signalEdgeBpsExPost1m, @signalEdgeBpsExPost5m,
                @executionEdgeBpsVsMid, @executionEdgeBpsVsBbo,
                @driftBps1m, @driftBps5m,
                @pnlExecQuote, @pnlDriftQuote1m, @pnlTotalQuote1m, @pnlDriftQuote5m, @pnlTotalQuote5m,
                @hasDecisionSnapshot, @hasHorizon1m, @hasHorizon5m
            )
        `),
        updateEdgeAttributionHorizons: db.prepare(`
            UPDATE edge_attribution_events
            SET mid1m = COALESCE(@mid1m, mid1m),
                mid5m = COALESCE(@mid5m, mid5m),
                signalEdgeBpsExPost1m = COALESCE(@signalEdgeBpsExPost1m, signalEdgeBpsExPost1m),
                signalEdgeBpsExPost5m = COALESCE(@signalEdgeBpsExPost5m, signalEdgeBpsExPost5m),
                driftBps1m = COALESCE(@driftBps1m, driftBps1m),
                driftBps5m = COALESCE(@driftBps5m, driftBps5m),
                pnlDriftQuote1m = COALESCE(@pnlDriftQuote1m, pnlDriftQuote1m),
                pnlTotalQuote1m = COALESCE(@pnlTotalQuote1m, pnlTotalQuote1m),
                pnlDriftQuote5m = COALESCE(@pnlDriftQuote5m, pnlDriftQuote5m),
                pnlTotalQuote5m = COALESCE(@pnlTotalQuote5m, pnlTotalQuote5m),
                hasHorizon1m = COALESCE(@hasHorizon1m, hasHorizon1m),
                hasHorizon5m = COALESCE(@hasHorizon5m, hasHorizon5m)
            WHERE id = @id
        `),
        updateTradeEventPostFill1s: db.prepare(`
            UPDATE trade_events
            SET postMid1s = @postMid1s,
                postSpread1s = @postSpread1s,
                postFlowCombined1s = @postFlowCombined1s,
                postFlowStrength1s = @postFlowStrength1s,
                postFlowRegime1s = @postFlowRegime1s,
                postSignal1s = @postSignal1s
            WHERE id = @id
        `),
        updateTradeEventPostFill3s: db.prepare(`
            UPDATE trade_events
            SET postMid3s = @postMid3s,
                postSpread3s = @postSpread3s,
                postFlowCombined3s = @postFlowCombined3s,
                postFlowStrength3s = @postFlowStrength3s,
                postFlowRegime3s = @postFlowRegime3s,
                postSignal3s = @postSignal3s
            WHERE id = @id
        `),
        insertSnapshot: db.prepare(`
            INSERT INTO market_snapshots (
                id, ts, pairKey, ledgerIndex, midPrice, spreadBps,
                bestBid, bestAsk, bidDepthBase, askDepthBase,
                flowRegime, flowImbalance, flowDepthImbalance, flowCombined, flowStrength,
                vwap, vwapDeviationBps, tradeCount, volumeVelocity,
                adverseSelectionRisk
            ) VALUES (
                @id, @ts, @pairKey, @ledgerIndex, @midPrice, @spreadBps,
                @bestBid, @bestAsk, @bidDepthBase, @askDepthBase,
                @flowRegime, @flowImbalance, @flowDepthImbalance, @flowCombined, @flowStrength,
                @vwap, @vwapDeviationBps, @tradeCount, @volumeVelocity,
                @adverseSelectionRisk
            )
        `),
        pruneTradeEvents: db.prepare(`
            DELETE FROM trade_events WHERE ts < ?
        `),
        pruneSnapshots: db.prepare(`
            DELETE FROM market_snapshots WHERE ts < ?
        `),
        pruneExecutionQualityEvents: db.prepare(`
            DELETE FROM execution_quality_events WHERE ts < ?
        `),
        pruneEdgeAttributionEvents: db.prepare(`
            DELETE FROM edge_attribution_events WHERE ts < ?
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

        // Ensure cost realism columns exist (handles existing databases)
        ensureColumns(dbInstance, 'trade_events', TRADE_EVENT_EXTRA_COLUMNS);

        // Ensure adverse selection column exists on snapshots
        ensureColumns(dbInstance, 'market_snapshots', SNAPSHOT_EXTRA_COLUMNS);

        // Ensure execution quality columns exist
        ensureColumns(dbInstance, 'execution_quality_events', EXECUTION_QUALITY_EXTRA_COLUMNS);
        ensureColumns(dbInstance, 'edge_attribution_events', EDGE_ATTRIBUTION_EXTRA_COLUMNS);

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
export function insertTradeEvent(event: TradeEventRecord): string | null {
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
            slippageBpsVsIntent: event.slippageBpsVsIntent,
            slippageBpsVsMid: event.slippageBpsVsMid,
            slippageBpsVsBbo: event.slippageBpsVsBbo ?? null,
            expectedPriceSource: event.expectedPriceSource ?? null,
            decisionMidPrice: event.decisionMidPrice ?? null,
            decisionBestBid: event.decisionBestBid ?? null,
            decisionBestAsk: event.decisionBestAsk ?? null,
            spreadPaidBps: event.spreadPaidBps,
            edgeBpsVsMid: event.edgeBpsVsMid,
            netEdgeBpsVsMid: event.netEdgeBpsVsMid,
            txFeeXrp: event.txFeeXrp,
            ammFeeBps: event.ammFeeBps,
            fillRatio: event.fillRatio,
            isPartial: event.isPartial,
            entrySpreadBps: event.entrySpreadBps,
            entryFlowCombined: event.entryFlowCombined,
            entryFlowStrength: event.entryFlowStrength,
            entryFlowRegime: event.entryFlowRegime,
            postMid1s: event.postMid1s,
            postSpread1s: event.postSpread1s,
            postFlowCombined1s: event.postFlowCombined1s,
            postFlowStrength1s: event.postFlowStrength1s,
            postFlowRegime1s: event.postFlowRegime1s,
            postMid3s: event.postMid3s,
            postSpread3s: event.postSpread3s,
            postFlowCombined3s: event.postFlowCombined3s,
            postFlowStrength3s: event.postFlowStrength3s,
            postFlowRegime3s: event.postFlowRegime3s,
            entryMid: event.entryMid,
            entrySignalStrength: event.entrySignalStrength,
            entryLocalExtreme: event.entryLocalExtreme,
            postSignal1s: event.postSignal1s,
            postSignal3s: event.postSignal3s,
        });
        return event.id;
    } catch (err) {
        logger.warn({ err, eventId: event.id }, 'Failed to insert trade event');
    }
    return null;
}

export function insertExecutionQualityEvent(event: ExecutionQualityEventRecord): string | null {
    try {
        const stmt = getStatements().insertExecutionQualityEvent;
        const result = stmt.run({
            id: event.id,
            ts: event.ts,
            eventId: event.eventId,
            txHash: event.txHash,
            pairKeyCanonical: event.pairKeyCanonical,
            pairAliases: event.pairAliases,
            side: event.side,
            strategy: event.strategy,
            regime: event.regime,
            source: event.source,
            venue: event.venue ?? null,
            intentPrice: event.intentPrice,
            expectedPrice: event.expectedPrice,
            expectedPriceSource: event.expectedPriceSource,
            baselineTs: event.baselineTs ?? null,
            baselineBestBid: event.baselineBestBid ?? null,
            baselineBestAsk: event.baselineBestAsk ?? null,
            baselineMid: event.baselineMid ?? null,
            baselineSpreadBps: event.baselineSpreadBps ?? null,
            baselineSource: event.baselineSource ?? null,
            expectedRule: event.expectedRule ?? null,
            slippageBaselineUsed: event.slippageBaselineUsed ?? null,
            priceConvention: event.priceConvention ?? null,
            baselineBookAgeMs: event.baselineBookAgeMs ?? null,
            fillTs: event.fillTs ?? null,
            decisionMid: event.decisionMid,
            decisionBid: event.decisionBid,
            decisionAsk: event.decisionAsk,
            fillPrice: event.fillPrice,
            amountBase: event.amountBase,
            filledBase: event.filledBase,
            filledQuote: event.filledQuote,
            slippageBpsVsIntent: event.slippageBpsVsIntent,
            slippageBpsVsMid: event.slippageBpsVsMid,
            slippageBpsVsBbo: event.slippageBpsVsBbo,
            effSpreadBps: event.effSpreadBps,
            realizedSpreadBps1m: event.realizedSpreadBps1m,
            realizedSpreadBps5m: event.realizedSpreadBps5m,
            impactBps1m: event.impactBps1m,
            impactBps5m: event.impactBps5m,
            implShortfallQuote: event.implShortfallQuote,
            fillRatio: event.fillRatio,
            status: event.status,
            rejectReason: event.rejectReason,
            flags: event.flags,
            guardQuarantined: event.guardQuarantined,
            decisionTs: event.decisionTs,
            submitTs: event.submitTs,
            submitResponseTs: event.submitResponseTs ?? null,
            validatedTs: event.validatedTs,
            submitResultEngine: event.submitResultEngine ?? null,
            submitError: event.submitError ?? null,
            decisionToSubmitMs: event.decisionToSubmitMs,
            submitToValidatedMs: event.submitToValidatedMs,
            decisionToValidatedMs: event.decisionToValidatedMs,
        });
        if (result.changes === 0) {
            return null;
        }
        return event.id;
    } catch (err) {
        logger.warn({ err, eventId: event.id }, 'Failed to insert execution quality event');
    }
    return null;
}

export function updateExecutionQualityHorizons(input: {
    id: string;
    realizedSpreadBps1m?: number | null;
    realizedSpreadBps5m?: number | null;
    impactBps1m?: number | null;
    impactBps5m?: number | null;
}): number {
    try {
        const stmt = getStatements().updateExecutionQualityHorizons;
        const result = stmt.run({
            id: input.id,
            realizedSpreadBps1m: input.realizedSpreadBps1m ?? null,
            realizedSpreadBps5m: input.realizedSpreadBps5m ?? null,
            impactBps1m: input.impactBps1m ?? null,
            impactBps5m: input.impactBps5m ?? null,
        });
        return result.changes;
    } catch (err) {
        logger.warn({ err, eventId: input.id }, 'Failed to update execution quality horizons');
    }
    return 0;
}

export function insertEdgeAttributionEvent(event: EdgeAttributionEventRecord): string | null {
    try {
        const stmt = getStatements().insertEdgeAttributionEvent;
        const result = stmt.run({
            id: event.id,
            ts: event.ts,
            eventId: event.eventId,
            txHash: event.txHash,
            pairKeyCanonical: event.pairKeyCanonical,
            pairAliases: event.pairAliases,
            side: event.side,
            strategy: event.strategy,
            regime: event.regime,
            source: event.source,
            midDecision: event.midDecision,
            bidDecision: event.bidDecision,
            askDecision: event.askDecision,
            fillPrice: event.fillPrice,
            midFill: event.midFill,
            mid1m: event.mid1m,
            mid5m: event.mid5m,
            baseFilled: event.baseFilled,
            filledQuote: event.filledQuote,
            signalEdgeBpsExAnte: event.signalEdgeBpsExAnte,
            signalEdgeBpsExPost1m: event.signalEdgeBpsExPost1m,
            signalEdgeBpsExPost5m: event.signalEdgeBpsExPost5m,
            executionEdgeBpsVsMid: event.executionEdgeBpsVsMid,
            executionEdgeBpsVsBbo: event.executionEdgeBpsVsBbo,
            driftBps1m: event.driftBps1m,
            driftBps5m: event.driftBps5m,
            pnlExecQuote: event.pnlExecQuote,
            pnlDriftQuote1m: event.pnlDriftQuote1m,
            pnlTotalQuote1m: event.pnlTotalQuote1m,
            pnlDriftQuote5m: event.pnlDriftQuote5m,
            pnlTotalQuote5m: event.pnlTotalQuote5m,
            hasDecisionSnapshot: event.hasDecisionSnapshot,
            hasHorizon1m: event.hasHorizon1m,
            hasHorizon5m: event.hasHorizon5m,
        });
        if (result.changes === 0) {
            return null;
        }
        return event.id;
    } catch (err) {
        logger.warn({ err, eventId: event.id }, 'Failed to insert edge attribution event');
    }
    return null;
}

export function updateEdgeAttributionHorizons(input: {
    id: string;
    mid1m?: number | null;
    mid5m?: number | null;
    signalEdgeBpsExPost1m?: number | null;
    signalEdgeBpsExPost5m?: number | null;
    driftBps1m?: number | null;
    driftBps5m?: number | null;
    pnlDriftQuote1m?: number | null;
    pnlTotalQuote1m?: number | null;
    pnlDriftQuote5m?: number | null;
    pnlTotalQuote5m?: number | null;
    hasHorizon1m?: number | null;
    hasHorizon5m?: number | null;
}): number {
    try {
        const stmt = getStatements().updateEdgeAttributionHorizons;
        const result = stmt.run({
            id: input.id,
            mid1m: input.mid1m ?? null,
            mid5m: input.mid5m ?? null,
            signalEdgeBpsExPost1m: input.signalEdgeBpsExPost1m ?? null,
            signalEdgeBpsExPost5m: input.signalEdgeBpsExPost5m ?? null,
            driftBps1m: input.driftBps1m ?? null,
            driftBps5m: input.driftBps5m ?? null,
            pnlDriftQuote1m: input.pnlDriftQuote1m ?? null,
            pnlTotalQuote1m: input.pnlTotalQuote1m ?? null,
            pnlDriftQuote5m: input.pnlDriftQuote5m ?? null,
            pnlTotalQuote5m: input.pnlTotalQuote5m ?? null,
            hasHorizon1m: input.hasHorizon1m ?? null,
            hasHorizon5m: input.hasHorizon5m ?? null,
        });
        return result.changes;
    } catch (err) {
        logger.warn({ err, eventId: input.id }, 'Failed to update edge attribution horizons');
    }
    return 0;
}

/**
 * Update post-fill snapshot fields on a trade event.
 */
export function updateTradeEventPostFill1s(input: {
    id: string;
    postMid1s: number | null;
    postSpread1s: number | null;
    postFlowCombined1s: number | null;
    postFlowStrength1s: number | null;
    postFlowRegime1s: FlowRegime | null;
    postSignal1s: number | null;
}): number {
    try {
        const stmt = getStatements().updateTradeEventPostFill1s;
        const result = stmt.run({
            id: input.id,
            postMid1s: input.postMid1s,
            postSpread1s: input.postSpread1s,
            postFlowCombined1s: input.postFlowCombined1s,
            postFlowStrength1s: input.postFlowStrength1s,
            postFlowRegime1s: input.postFlowRegime1s,
            postSignal1s: input.postSignal1s,
        });
        return result.changes;
    } catch (err) {
        logger.warn({ err, eventId: input.id }, 'Failed to update post-fill 1s snapshot');
    }
    return 0;
}

export function updateTradeEventPostFill3s(input: {
    id: string;
    postMid3s: number | null;
    postSpread3s: number | null;
    postFlowCombined3s: number | null;
    postFlowStrength3s: number | null;
    postFlowRegime3s: FlowRegime | null;
    postSignal3s: number | null;
}): number {
    try {
        const stmt = getStatements().updateTradeEventPostFill3s;
        const result = stmt.run({
            id: input.id,
            postMid3s: input.postMid3s,
            postSpread3s: input.postSpread3s,
            postFlowCombined3s: input.postFlowCombined3s,
            postFlowStrength3s: input.postFlowStrength3s,
            postFlowRegime3s: input.postFlowRegime3s,
            postSignal3s: input.postSignal3s,
        });
        return result.changes;
    } catch (err) {
        logger.warn({ err, eventId: input.id }, 'Failed to update post-fill 3s snapshot');
    }
    return 0;
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
            adverseSelectionRisk: snapshot.adverseSelectionRisk ?? null,
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
                    slippageBpsVsIntent: event.slippageBpsVsIntent,
                    slippageBpsVsMid: event.slippageBpsVsMid,
                    slippageBpsVsBbo: event.slippageBpsVsBbo ?? null,
                    expectedPriceSource: event.expectedPriceSource ?? null,
                    decisionMidPrice: event.decisionMidPrice ?? null,
                    decisionBestBid: event.decisionBestBid ?? null,
                    decisionBestAsk: event.decisionBestAsk ?? null,
                    spreadPaidBps: event.spreadPaidBps,
                    edgeBpsVsMid: event.edgeBpsVsMid,
                    netEdgeBpsVsMid: event.netEdgeBpsVsMid,
                    txFeeXrp: event.txFeeXrp,
                    ammFeeBps: event.ammFeeBps,
                    fillRatio: event.fillRatio,
                    isPartial: event.isPartial,
                    entrySpreadBps: event.entrySpreadBps,
                    entryFlowCombined: event.entryFlowCombined,
                    entryFlowStrength: event.entryFlowStrength,
                    entryFlowRegime: event.entryFlowRegime,
                    postMid1s: event.postMid1s,
                    postSpread1s: event.postSpread1s,
                    postFlowCombined1s: event.postFlowCombined1s,
                    postFlowStrength1s: event.postFlowStrength1s,
                    postFlowRegime1s: event.postFlowRegime1s,
                    postMid3s: event.postMid3s,
                    postSpread3s: event.postSpread3s,
                    postFlowCombined3s: event.postFlowCombined3s,
                    postFlowStrength3s: event.postFlowStrength3s,
                    postFlowRegime3s: event.postFlowRegime3s,
                    entryMid: event.entryMid,
                    entrySignalStrength: event.entrySignalStrength,
                    entryLocalExtreme: event.entryLocalExtreme,
                    postSignal1s: event.postSignal1s,
                    postSignal3s: event.postSignal3s,
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
                    adverseSelectionRisk: snapshot.adverseSelectionRisk ?? null,
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
        stmts.pruneExecutionQualityEvents.run(cutoffTs);
        stmts.pruneEdgeAttributionEvents.run(cutoffTs);

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

export interface ExecutionQualityQueryFilters {
    pairKey?: string;
    sinceMs?: number;
    strategy?: string;
    side?: 'buy' | 'sell';
    source?: 'bot' | 'manual' | 'unknown';
}

export interface EdgeAttributionQueryFilters {
    pairKey?: string;
    sinceMs?: number;
    strategy?: string;
    side?: 'buy' | 'sell';
    source?: 'bot' | 'manual' | 'unknown';
}

function appendPairFilter(sql: string, params: any[], pairKey: string | undefined, column: string = 'pairKey'): string {
    if (!pairKey) return sql;
    const aliases = getPairKeyAliases(pairKey);
    if (aliases.length === 0) {
        params.push(pairKey);
        return `${sql} AND ${column} = ?`;
    }
    const placeholders = aliases.map(() => '?').join(', ');
    params.push(...aliases);
    return `${sql} AND ${column} IN (${placeholders})`;
}

/**
 * Get trade events with optional filters
 */
export function queryTradeEvents(filters: QueryFilters = {}): TradeEventRecord[] {
    const db = getFeedbackDb();
    let sql = 'SELECT * FROM trade_events WHERE 1=1';
    const params: any[] = [];

    sql = appendPairFilter(sql, params, filters.pairKey ? canonicalizePairKey(filters.pairKey) : undefined);
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

export function queryExecutionQualityEvents(filters: ExecutionQualityQueryFilters = {}): ExecutionQualityEventRecord[] {
    const db = getFeedbackDb();
    let sql = 'SELECT * FROM execution_quality_events WHERE 1=1';
    const params: any[] = [];

    sql = appendPairFilter(sql, params, filters.pairKey ? canonicalizePairKey(filters.pairKey) : undefined, 'pairKeyCanonical');
    if (filters.sinceMs) {
        sql += ' AND ts >= ?';
        params.push(filters.sinceMs);
    }
    if (filters.strategy) {
        sql += ' AND strategy = ?';
        params.push(filters.strategy);
    }
    if (filters.side) {
        sql += ' AND side = ?';
        params.push(filters.side);
    }
    if (filters.source) {
        sql += ' AND source = ?';
        params.push(filters.source);
    }

    sql += ' ORDER BY ts DESC';
    try {
        return db.prepare(sql).all(...params) as ExecutionQualityEventRecord[];
    } catch (err) {
        logger.warn({ err, filters }, 'Failed to query execution quality events');
        return [];
    }
}

export function queryEdgeAttributionEvents(filters: EdgeAttributionQueryFilters = {}): EdgeAttributionEventRecord[] {
    const db = getFeedbackDb();
    let sql = 'SELECT * FROM edge_attribution_events WHERE 1=1';
    const params: any[] = [];

    sql = appendPairFilter(sql, params, filters.pairKey ? canonicalizePairKey(filters.pairKey) : undefined, 'pairKeyCanonical');
    if (filters.sinceMs) {
        sql += ' AND ts >= ?';
        params.push(filters.sinceMs);
    }
    if (filters.strategy) {
        sql += ' AND strategy = ?';
        params.push(filters.strategy);
    }
    if (filters.side) {
        sql += ' AND side = ?';
        params.push(filters.side);
    }
    if (filters.source) {
        sql += ' AND source = ?';
        params.push(filters.source);
    }

    sql += ' ORDER BY ts DESC';
    try {
        return db.prepare(sql).all(...params) as EdgeAttributionEventRecord[];
    } catch (err) {
        logger.warn({ err, filters }, 'Failed to query edge attribution events');
        return [];
    }
}

export function hasExecutionQualityTxHash(txHash: string): boolean {
    if (!txHash) return false;
    const db = getFeedbackDb();
    try {
        const row = db.prepare('SELECT 1 as found FROM execution_quality_events WHERE txHash = ? LIMIT 1').get(txHash) as { found?: number } | undefined;
        return row?.found === 1;
    } catch (err) {
        logger.warn({ err, txHash }, 'Failed to query execution quality hash existence');
        return false;
    }
}

export function hasEdgeAttributionTxHash(txHash: string): boolean {
    if (!txHash) return false;
    const db = getFeedbackDb();
    try {
        const row = db.prepare('SELECT 1 as found FROM edge_attribution_events WHERE txHash = ? LIMIT 1').get(txHash) as { found?: number } | undefined;
        return row?.found === 1;
    } catch (err) {
        logger.warn({ err, txHash }, 'Failed to query edge attribution hash existence');
        return false;
    }
}

/**
 * Get market snapshots with optional filters
 */
export function querySnapshots(filters: QueryFilters = {}): MarketSnapshotRecord[] {
    const db = getFeedbackDb();
    let sql = 'SELECT * FROM market_snapshots WHERE 1=1';
    const params: any[] = [];

    sql = appendPairFilter(sql, params, filters.pairKey ? canonicalizePairKey(filters.pairKey) : undefined);
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
        const aliases = getPairKeyAliases(canonicalizePairKey(pairKey));
        const placeholders = aliases.map(() => '?').join(', ');
        const where = aliases.length > 0 ? `pairKey IN (${placeholders})` : 'pairKey = ?';
        const params = aliases.length > 0 ? aliases : [pairKey];
        return db.prepare(`
            SELECT * FROM market_snapshots 
            WHERE ${where}
            ORDER BY ts DESC 
            LIMIT 1
        `).get(...params) as MarketSnapshotRecord | null;
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
        const aliases = getPairKeyAliases(canonicalizePairKey(pairKey));
        const placeholders = aliases.map(() => '?').join(', ');
        const where = aliases.length > 0 ? `pairKey IN (${placeholders})` : 'pairKey = ?';
        const baseParams = aliases.length > 0 ? aliases : [pairKey];

        const before = db.prepare(`
            SELECT * FROM market_snapshots
            WHERE ${where} AND ts BETWEEN ? AND ?
            ORDER BY ts DESC
            LIMIT 1
        `).get(...baseParams, ts - toleranceMs, ts) as MarketSnapshotRecord | null;

        const after = db.prepare(`
            SELECT * FROM market_snapshots
            WHERE ${where} AND ts BETWEEN ? AND ?
            ORDER BY ts ASC
            LIMIT 1
        `).get(...baseParams, ts, ts + toleranceMs) as MarketSnapshotRecord | null;

        if (!before) return after;
        if (!after) return before;

        const beforeDiff = Math.abs(before.ts - ts);
        const afterDiff = Math.abs(after.ts - ts);
        return beforeDiff <= afterDiff ? before : after;
    } catch (err) {
        logger.warn({ err, pairKey, ts }, 'Failed to get snapshot near timestamp');
        return null;
    }
}

/**
 * Count records for statistics
 */
export function countRecords(): {
    tradeEvents: number;
    snapshots: number;
    executionQualityEvents: number;
    edgeAttributionEvents: number;
} {
    const db = getFeedbackDb();
    try {
        const events = db.prepare('SELECT COUNT(*) as count FROM trade_events').get() as { count: number };
        const snapshots = db.prepare('SELECT COUNT(*) as count FROM market_snapshots').get() as { count: number };
        const executionQualityEvents = db.prepare('SELECT COUNT(*) as count FROM execution_quality_events').get() as { count: number };
        const edgeAttributionEvents = db.prepare('SELECT COUNT(*) as count FROM edge_attribution_events').get() as { count: number };
        return {
            tradeEvents: events.count,
            snapshots: snapshots.count,
            executionQualityEvents: executionQualityEvents.count,
            edgeAttributionEvents: edgeAttributionEvents.count,
        };
    } catch (err) {
        logger.warn({ err }, 'Failed to count records');
        return { tradeEvents: 0, snapshots: 0, executionQualityEvents: 0, edgeAttributionEvents: 0 };
    }
}
