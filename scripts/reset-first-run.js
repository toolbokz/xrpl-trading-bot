#!/usr/bin/env node

/**
 * FIRST RUN RESET — Wipe all bot historical data and state.
 *
 * Clears every persistence layer so the bot behaves like a fresh install:
 *   - SQLite databases (feedback, exposure, instruments)
 *   - JSON state files (adaptive-state, regime-policy, regime-smoothed, breaker_*)
 *   - Trade history (trade_history.json + backup/cleaned/changes variants)
 *   - PnL CSV export
 *   - Audit log
 *   - Redis breaker keys (if REDIS_URL set)
 *   - data/_archive directory
 *   - .next/cache (Next.js data cache)
 *
 * What is PRESERVED:
 *   - .env, secrets, wallet seed, API keys
 *   - Source code, node_modules, package.json
 *   - Documentation, config files
 *   - data/.mainnet-live-ack safety lock file
 *
 * Usage:
 *   node scripts/reset-first-run.js            # dev mode (interactive confirm)
 *   node scripts/reset-first-run.js --force     # skip confirmation
 *   NODE_ENV=production node scripts/reset-first-run.js --force --prod  # production
 *
 * Exit codes:
 *   0 — success
 *   1 — failure or user cancelled
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─── Configuration ───────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const args = process.argv.slice(2);
const FLAG_FORCE = args.includes('--force');
const FLAG_PROD = args.includes('--prod');
const FLAG_DRY_RUN = args.includes('--dry-run');

const isProduction = process.env.NODE_ENV === 'production' || FLAG_PROD;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let cleared = [];
let skipped = [];
let failed = [];

function log(msg) {
    console.log(msg);
}

function logOk(msg) {
    console.log(`${GREEN}  ✓${RESET} ${msg}`);
}

function logSkip(msg) {
    console.log(`${DIM}  - ${msg}${RESET}`);
}

function logFail(msg) {
    console.error(`${RED}  ✗ ${msg}${RESET}`);
}

function logSection(title) {
    console.log(`\n${CYAN}▸ ${title}${RESET}`);
}

/**
 * Delete a file if it exists. Returns true if deleted, false if not found.
 */
function deleteFile(filePath, label) {
    const rel = path.relative(ROOT, filePath);
    try {
        if (fs.existsSync(filePath)) {
            if (FLAG_DRY_RUN) {
                logOk(`[dry-run] Would delete: ${rel}`);
                cleared.push(rel);
                return true;
            }
            fs.unlinkSync(filePath);
            logOk(`Deleted: ${rel}`);
            cleared.push(rel);
            return true;
        }
        logSkip(`Not found: ${rel}`);
        skipped.push(rel);
        return false;
    } catch (err) {
        logFail(`Failed to delete ${rel}: ${err.message}`);
        failed.push({ path: rel, error: err.message });
        return false;
    }
}

/**
 * Delete files matching a glob pattern in a directory.
 */
function deleteGlob(dir, pattern, label) {
    try {
        if (!fs.existsSync(dir)) {
            logSkip(`Directory not found: ${path.relative(ROOT, dir)}`);
            return 0;
        }
        const files = fs.readdirSync(dir);
        const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
        let count = 0;
        for (const file of files) {
            if (regex.test(file)) {
                const full = path.join(dir, file);
                if (fs.statSync(full).isFile()) {
                    deleteFile(full, label);
                    count++;
                }
            }
        }
        if (count === 0) {
            logSkip(`No ${label} files matched in ${path.relative(ROOT, dir)}`);
        }
        return count;
    } catch (err) {
        logFail(`Failed to scan ${path.relative(ROOT, dir)}: ${err.message}`);
        failed.push({ path: path.relative(ROOT, dir), error: err.message });
        return 0;
    }
}

/**
 * Recursively remove a directory.
 */
function deleteDir(dirPath, label) {
    const rel = path.relative(ROOT, dirPath);
    try {
        if (fs.existsSync(dirPath)) {
            if (FLAG_DRY_RUN) {
                logOk(`[dry-run] Would remove directory: ${rel}`);
                cleared.push(`${rel}/`);
                return true;
            }
            fs.rmSync(dirPath, { recursive: true, force: true });
            logOk(`Removed directory: ${rel}`);
            cleared.push(`${rel}/`);
            return true;
        }
        logSkip(`Directory not found: ${rel}`);
        skipped.push(`${rel}/`);
        return false;
    } catch (err) {
        logFail(`Failed to remove ${rel}: ${err.message}`);
        failed.push({ path: rel, error: err.message });
        return false;
    }
}

/**
 * Flush Redis breaker keys if REDIS_URL is set.
 */
async function flushRedisBreaker() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        logSkip('No REDIS_URL set — skipping Redis flush');
        skipped.push('redis:breaker:*');
        return;
    }

    try {
        const redis = require('redis');
        const client = redis.createClient({ url: redisUrl });
        client.on('error', () => { }); // suppress during reset
        await client.connect();

        // Scan and delete all breaker keys
        let cursor = '0';
        let deletedCount = 0;
        do {
            const result = await client.scan(cursor, { MATCH: 'breaker:*', COUNT: 100 });
            cursor = result.cursor?.toString() ?? '0';
            const keys = result.keys || [];
            if (keys.length > 0) {
                if (!FLAG_DRY_RUN) {
                    await client.del(keys);
                }
                deletedCount += keys.length;
            }
        } while (cursor !== '0');

        await client.quit();

        if (deletedCount > 0) {
            logOk(`${FLAG_DRY_RUN ? '[dry-run] Would delete' : 'Deleted'} ${deletedCount} Redis breaker key(s)`);
            cleared.push(`redis:breaker:* (${deletedCount} keys)`);
        } else {
            logSkip('No Redis breaker keys found');
            skipped.push('redis:breaker:*');
        }
    } catch (err) {
        // Redis is optional — don't fail the whole reset
        logSkip(`Redis not reachable (${err.message}) — skipping`);
        skipped.push('redis:breaker:*');
    }
}

/**
 * Ask for user confirmation.
 */
function confirm(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
        });
    });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n${CYAN}╔═══════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${CYAN}║         XRPL Trading Bot — First Run Reset            ║${RESET}`);
    console.log(`${CYAN}╚═══════════════════════════════════════════════════════╝${RESET}\n`);

    if (FLAG_DRY_RUN) {
        log(`${YELLOW}DRY RUN MODE — no files will actually be deleted${RESET}\n`);
    }

    // Safety: require --force + --prod for production
    if (isProduction && !FLAG_FORCE) {
        logFail('Production reset requires both --force and --prod flags.');
        logFail('Usage: NODE_ENV=production node scripts/reset-first-run.js --force --prod');
        process.exit(1);
    }

    // Interactive confirmation in non-force mode
    if (!FLAG_FORCE && !FLAG_DRY_RUN) {
        log(`${YELLOW}⚠  This will permanently delete ALL bot historical data.${RESET}`);
        log(`${YELLOW}   Secrets, config, and source code will be preserved.${RESET}\n`);

        if (isProduction) {
            log(`${RED}   *** PRODUCTION ENVIRONMENT DETECTED ***${RESET}\n`);
        }

        const ok = await confirm(`${YELLOW}   Continue? (y/N): ${RESET}`);
        if (!ok) {
            log('\nReset cancelled.');
            process.exit(1);
        }
    }

    // ── 1. SQLite Databases ──────────────────────────────────────────────────

    logSection('SQLite Databases');

    // Feedback DB (trade_events, market_snapshots, execution_quality_events, edge_attribution_events)
    const feedbackDbPath = process.env.FEEDBACK_DB_PATH || path.join(DATA_DIR, 'feedback.sqlite');
    deleteFile(feedbackDbPath, 'feedback DB');
    deleteFile(`${feedbackDbPath}-shm`, 'feedback DB SHM');
    deleteFile(`${feedbackDbPath}-wal`, 'feedback DB WAL');

    // Exposure DB (exposure_fills, exposure_state)
    const exposureDbPath = process.env.EXPOSURE_DB_PATH || path.join(DATA_DIR, 'exposure.sqlite');
    deleteFile(exposureDbPath, 'exposure DB');
    deleteFile(`${exposureDbPath}-shm`, 'exposure DB SHM');
    deleteFile(`${exposureDbPath}-wal`, 'exposure DB WAL');

    // Instruments DB (instruments, issuers — will be re-seeded on startup)
    const instrumentDbPath = process.env.INSTRUMENT_DB_PATH || path.join(DATA_DIR, 'instruments.sqlite');
    deleteFile(instrumentDbPath, 'instruments DB');
    deleteFile(`${instrumentDbPath}-shm`, 'instruments DB SHM');
    deleteFile(`${instrumentDbPath}-wal`, 'instruments DB WAL');

    // ── 2. JSON State Files ──────────────────────────────────────────────────

    logSection('JSON State Files');

    // Adaptive learner state
    const adaptiveStatePath = process.env.ADAPTIVE_STATE_PATH || path.join(DATA_DIR, 'adaptive-state.json');
    deleteFile(adaptiveStatePath, 'adaptive state');

    // Regime policy state
    deleteFile(path.join(DATA_DIR, 'regime-policy.json'), 'regime policy');
    deleteFile(path.join(DATA_DIR, 'regime-smoothed.json'), 'regime smoothed state');

    // Circuit breaker file store (breaker_*.json)
    deleteGlob(DATA_DIR, /^breaker_.*\.json$/, 'breaker state');

    // ── 3. Trade History ─────────────────────────────────────────────────────

    logSection('Trade History');

    // Main trade history
    deleteFile(path.join(ROOT, 'trade_history.json'), 'trade history');

    // Backup/cleaned/changes variants (from backfill scripts)
    deleteGlob(ROOT, /^trade_history\.(backup|cleaned|changes)\..*\.json$/, 'trade history artifacts');

    // ── 4. PnL CSV ───────────────────────────────────────────────────────────

    logSection('PnL Export');

    const csvPath = process.env.CSV_EXPORT_PATH || 'pnl.csv';
    deleteFile(path.resolve(ROOT, csvPath), 'PnL CSV');

    // ── 5. Audit Log ─────────────────────────────────────────────────────────

    logSection('Audit Log');

    deleteFile(path.join(DATA_DIR, 'audit.log'), 'audit log');

    // ── 6. Archive Directory ─────────────────────────────────────────────────

    logSection('Archive Directory');

    deleteDir(path.join(DATA_DIR, '_archive'), 'archive directory');

    // ── 7. Redis Breaker Keys ────────────────────────────────────────────────

    logSection('Redis');

    await flushRedisBreaker();

    // ── 8. Next.js Cache ─────────────────────────────────────────────────────

    logSection('Next.js Cache');

    deleteDir(path.join(ROOT, '.next', 'cache'), 'Next.js cache');
    deleteDir(path.join(ROOT, 'src', 'ui', '.next', 'cache'), 'Next.js UI cache');

    // ── 9. Backfill script artifacts ─────────────────────────────────────────

    logSection('Script Artifacts');

    deleteGlob(DATA_DIR, /^feedback\.backfill\..*\.json$/, 'feedback backfill reports');
    deleteGlob(DATA_DIR, /^feedback\.panels\.backfill\..*\.json$/, 'feedback panels backfill reports');

    // ── 10. Ensure data directory still exists ───────────────────────────────

    if (!FLAG_DRY_RUN) {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            logOk('Re-created data/ directory');
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log(`\n${CYAN}═══════════════════════════════════════════════════════${RESET}`);
    console.log(`${CYAN}  RESET SUMMARY${RESET}`);
    console.log(`${CYAN}═══════════════════════════════════════════════════════${RESET}`);

    if (cleared.length > 0) {
        console.log(`\n${GREEN}  Cleared (${cleared.length}):${RESET}`);
        for (const item of cleared) {
            console.log(`    ${GREEN}✓${RESET} ${item}`);
        }
    }

    if (skipped.length > 0) {
        console.log(`\n${DIM}  Skipped / not found (${skipped.length}):${RESET}`);
        for (const item of skipped) {
            console.log(`    ${DIM}- ${item}${RESET}`);
        }
    }

    if (failed.length > 0) {
        console.log(`\n${RED}  Failed (${failed.length}):${RESET}`);
        for (const item of failed) {
            console.log(`    ${RED}✗ ${item.path}: ${item.error}${RESET}`);
        }
    }

    console.log('');

    if (failed.length > 0) {
        logFail(`Reset completed with ${failed.length} error(s).`);
        process.exit(1);
    }

    if (FLAG_DRY_RUN) {
        log(`${YELLOW}Dry run complete — no changes were made.${RESET}`);
    } else {
        log(`${GREEN}✓ First-run reset complete.${RESET}`);
        log(`${DIM}  The bot will recreate schemas and seed data on next startup.${RESET}`);
        log(`${DIM}  Instrument registry will be auto-seeded from built-in definitions.${RESET}`);
        log(`${DIM}  Run: npm run dev${RESET}`);
    }

    console.log('');
    process.exit(0);
}

main().catch((err) => {
    console.error(`\n${RED}Fatal error during reset:${RESET}`, err);
    process.exit(1);
});
