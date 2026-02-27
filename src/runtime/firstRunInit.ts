/**
 * First-Run Initialization Module
 *
 * Detects whether the bot is starting for the first time (or after a reset)
 * and ensures all required directories, database schemas, and seed data are
 * created before the trading runtime begins.
 *
 * This module is idempotent — safe to call on every startup.
 *
 * Behaviour when HISTORY_MODE=none (default):
 *   - Creates data/ directory if missing
 *   - SQLite databases are lazily created by their respective modules
 *     (feedbackDb, exposureStore, instrumentRegistry) with CREATE IF NOT EXISTS
 *   - Instrument registry auto-seeds from built-in definitions (seedIfEmpty)
 *   - Logs first-run detection so operators know the bot is starting clean
 *   - Sets a boot timestamp that strategies can use to ignore pre-boot data
 *
 * Behaviour when HISTORY_MODE=backfill:
 *   - Same as above, but allows strategies to request historical backfill
 *
 * @module runtime/firstRunInit
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Boot Timestamp Singleton
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Timestamp (ms) of when the bot booted.  Strategies in HISTORY_MODE=none
 * should only use data with ts >= bootTimestampMs.
 */
let bootTimestampMs: number = 0;

/**
 * Whether the current startup detected a first-run (clean) state.
 */
let isFirstRun: boolean = false;

export function getBootTimestampMs(): number {
    return bootTimestampMs;
}

export function getIsFirstRun(): boolean {
    return isFirstRun;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init Logic
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), 'data');

/**
 * Sentinel files whose absence indicates a first-run / post-reset state.
 * We check for any of the three main SQLite databases.
 */
const SENTINEL_PATHS = [
    () => process.env.FEEDBACK_DB_PATH || join(DATA_DIR, 'feedback.sqlite'),
    () => process.env.EXPOSURE_DB_PATH || join(DATA_DIR, 'exposure.sqlite'),
    () => process.env.INSTRUMENT_DB_PATH || join(DATA_DIR, 'instruments.sqlite'),
];

/**
 * Run first-run initialization.
 *
 * Call this early in the startup sequence (before TradingRuntime.start()).
 * It is synchronous and fast.
 */
export function initFirstRun(): { isFirstRun: boolean; bootTimestampMs: number } {
    bootTimestampMs = Date.now();

    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
        logger.info({ dataDir: DATA_DIR }, 'Created data directory');
    }

    // Detect first-run by checking if any sentinel DB exists
    const anySentinelExists = SENTINEL_PATHS.some((getPath) => existsSync(getPath()));
    isFirstRun = !anySentinelExists;

    const historyMode = process.env.HISTORY_MODE === 'backfill' ? 'backfill' : 'none';

    if (isFirstRun) {
        logger.info(
            {
                bootTimestampMs,
                historyMode,
                dataDir: DATA_DIR,
            },
            '🆕  First-run detected — bot will start with clean state. ' +
            'All databases will be created fresh. Instrument registry will be seeded from built-in definitions.',
        );
    } else {
        logger.info(
            {
                bootTimestampMs,
                historyMode,
            },
            'Existing data detected — normal startup.',
        );
    }

    if (historyMode === 'none') {
        logger.info(
            { bootTimestampMs: new Date(bootTimestampMs).toISOString() },
            'HISTORY_MODE=none — strategies will only use data accumulated after boot.',
        );
    }

    return { isFirstRun, bootTimestampMs };
}
