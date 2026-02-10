#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function loadFeedbackDb(dbPath) {
    if (!fs.existsSync(dbPath)) return null;
    try {
        // eslint-disable-next-line global-require
        const Database = require('better-sqlite3');
        return new Database(dbPath, { readonly: true });
    } catch (err) {
        console.warn('Failed to open feedback DB:', err.message);
        return null;
    }
}

function bucketSpread(spreadBps) {
    if (spreadBps == null) return 'unknown';
    if (spreadBps < 5) return '0-5';
    if (spreadBps < 10) return '5-10';
    if (spreadBps < 20) return '10-20';
    if (spreadBps < 40) return '20-40';
    return '40+';
}

function bucketSignal(signal) {
    if (signal == null) return 'unknown';
    if (signal < 0.4) return '0-40%';
    if (signal < 0.6) return '40-60%';
    if (signal < 0.8) return '60-80%';
    return '80%+';
}

function safeNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function computeNetBps(side, entryMid, postMid) {
    if (!entryMid || !postMid) return null;
    if (side === 'buy') return ((postMid - entryMid) / entryMid) * 10000;
    if (side === 'sell') return ((entryMid - postMid) / entryMid) * 10000;
    return null;
}

function addBucket(stats, key, net1s, net3s) {
    if (!stats[key]) {
        stats[key] = {
            trades: 0,
            with1s: 0,
            sumNet1s: 0,
            with3s: 0,
            sumNet3s: 0,
        };
    }
    const bucket = stats[key];
    bucket.trades += 1;
    if (net1s != null) {
        bucket.with1s += 1;
        bucket.sumNet1s += net1s;
    }
    if (net3s != null) {
        bucket.with3s += 1;
        bucket.sumNet3s += net3s;
    }
}

function formatBps(value) {
    if (value == null) return 'n/a';
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)} bps`;
}

function main() {
    const feedbackDbPath = process.env.FEEDBACK_DB_PATH
        ? path.resolve(process.cwd(), process.env.FEEDBACK_DB_PATH)
        : path.resolve(process.cwd(), 'data', 'feedback.sqlite');

    const db = loadFeedbackDb(feedbackDbPath);
    if (!db) {
        console.log('Feedback DB not found.');
        return;
    }

    const tradeCols = db.prepare("PRAGMA table_info(trade_events)").all().map((c) => c.name);
    const hasEntrySpread = tradeCols.includes('entrySpreadBps');
    const hasEntryFlowStrength = tradeCols.includes('entryFlowStrength');
    const hasEntryFlowCombined = tradeCols.includes('entryFlowCombined');
    const hasPost1s = tradeCols.includes('postMid1s');
    const hasPost3s = tradeCols.includes('postMid3s');

    const entrySpreadExpr = hasEntrySpread
        ? 'COALESCE(e.entrySpreadBps, s.spreadBps)'
        : 's.spreadBps';
    const entryFlowStrengthExpr = hasEntryFlowStrength
        ? 'COALESCE(e.entryFlowStrength, s.flowStrength)'
        : 's.flowStrength';
    const entryFlowCombinedExpr = hasEntryFlowCombined
        ? 'COALESCE(e.entryFlowCombined, s.flowCombined)'
        : 's.flowCombined';
    const postMid1sExpr = hasPost1s
        ? `COALESCE(
            e.postMid1s,
            (SELECT m.midPrice FROM market_snapshots m WHERE m.pairKey = e.pairKey AND m.ts BETWEEN e.ts + 900 AND e.ts + 1100 ORDER BY m.ts ASC LIMIT 1)
        )`
        : `(SELECT m.midPrice FROM market_snapshots m WHERE m.pairKey = e.pairKey AND m.ts BETWEEN e.ts + 900 AND e.ts + 1100 ORDER BY m.ts ASC LIMIT 1)`;
    const postMid3sExpr = hasPost3s
        ? `COALESCE(
            e.postMid3s,
            (SELECT m.midPrice FROM market_snapshots m WHERE m.pairKey = e.pairKey AND m.ts BETWEEN e.ts + 2900 AND e.ts + 3100 ORDER BY m.ts ASC LIMIT 1)
        )`
        : `(SELECT m.midPrice FROM market_snapshots m WHERE m.pairKey = e.pairKey AND m.ts BETWEEN e.ts + 2900 AND e.ts + 3100 ORDER BY m.ts ASC LIMIT 1)`;

    const fills = db.prepare(
        `SELECT
            e.id,
            e.pairKey,
            e.side,
            COALESCE(e.midPriceAtDecision, s.midPrice) AS entryMid,
            ${entrySpreadExpr} AS entrySpreadBps,
            ${entryFlowStrengthExpr} AS entryFlowStrength,
            ${entryFlowCombinedExpr} AS entryFlowCombined,
            ${postMid1sExpr} AS postMid1s,
            ${postMid3sExpr} AS postMid3s
        FROM trade_events e
        LEFT JOIN market_snapshots s
            ON s.pairKey = e.pairKey
            AND s.ts = (
                SELECT ms.ts FROM market_snapshots ms
                WHERE ms.pairKey = e.pairKey AND ms.ts <= e.ts
                ORDER BY ms.ts DESC
                LIMIT 1
            )
        WHERE e.action = 'fill'`
    ).all();

    const absCombined = fills
        .map((row) => safeNumber(row.entryFlowCombined))
        .filter((v) => v != null)
        .map((v) => Math.abs(v))
        .sort((a, b) => a - b);

    const p90Index = absCombined.length ? Math.floor(absCombined.length * 0.9) : -1;
    const p90Threshold = p90Index >= 0 ? absCombined[p90Index] : null;

    const stats = {};

    for (const row of fills) {
        const entryMid = safeNumber(row.entryMid);
        const postMid1s = safeNumber(row.postMid1s);
        const postMid3s = safeNumber(row.postMid3s);
        const net1s = computeNetBps(row.side, entryMid, postMid1s);
        const net3s = computeNetBps(row.side, entryMid, postMid3s);

        const spreadBucket = bucketSpread(safeNumber(row.entrySpreadBps));
        const signalBucket = bucketSignal(safeNumber(row.entryFlowStrength));
        const isExtreme = p90Threshold != null
            && safeNumber(row.entryFlowCombined) != null
            && Math.abs(row.entryFlowCombined) >= p90Threshold;
        const imbalanceType = isExtreme ? 'local_extreme' : 'global';

        const key = `${spreadBucket} | ${signalBucket} | ${imbalanceType}`;
        addBucket(stats, key, net1s, net3s);
    }

    const rows = Object.entries(stats)
        .map(([key, value]) => {
            const avgNet1s = value.with1s ? value.sumNet1s / value.with1s : null;
            const avgNet3s = value.with3s ? value.sumNet3s / value.with3s : null;
            return {
                key,
                trades: value.trades,
                with1s: value.with1s,
                with3s: value.with3s,
                avgNet1s,
                avgNet3s,
            };
        })
        .sort((a, b) => a.key.localeCompare(b.key));

    console.log('=== Bucket Backtest Report ===');
    console.log(`Feedback DB: ${feedbackDbPath}`);
    console.log(`Fills: ${fills.length}`);
    console.log(`Local extreme threshold (p90 abs(flowCombined)): ${p90Threshold == null ? 'n/a' : p90Threshold.toFixed(4)}`);
    console.log('');

    console.log('Spread | Signal | Imbalance | Trades | With 1s | Avg Net 1s | With 3s | Avg Net 3s');
    for (const row of rows) {
        const [spread, signal, imbalance] = row.key.split(' | ');
        console.log(
            `${spread} | ${signal} | ${imbalance} | ${row.trades} | ${row.with1s} | ${formatBps(row.avgNet1s)} | ${row.with3s} | ${formatBps(row.avgNet3s)}`
        );
    }

    const positive = rows
        .filter((row) => row.avgNet3s != null && row.avgNet3s > 0)
        .sort((a, b) => (b.avgNet3s ?? 0) - (a.avgNet3s ?? 0))
        .slice(0, 3);
    const churn = rows
        .filter((row) => row.avgNet3s != null && row.avgNet3s < 0)
        .sort((a, b) => (a.avgNet3s ?? 0) - (b.avgNet3s ?? 0))
        .slice(0, 3);

    console.log('');
    console.log('Top 3 positive expectancy (avgNet3s > 0):');
    if (!positive.length) {
        console.log('  none');
    } else {
        for (const row of positive) {
            console.log(`  ${row.key} -> ${formatBps(row.avgNet3s)} (n=${row.with3s}, trades=${row.trades})`);
        }
    }

    console.log('');
    console.log('Top 3 churn losses (avgNet3s < 0):');
    if (!churn.length) {
        console.log('  none');
    } else {
        for (const row of churn) {
            console.log(`  ${row.key} -> ${formatBps(row.avgNet3s)} (n=${row.with3s}, trades=${row.trades})`);
        }
    }

    db.close();
}

main();
