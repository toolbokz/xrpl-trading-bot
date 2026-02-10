#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        json: args.includes('--json'),
    };
}

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

function loadTradeHistory(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.warn('Failed to parse trade history:', err.message);
        return [];
    }
}

function safeDiv(a, b) {
    return b ? a / b : null;
}

async function fetchJson(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: err?.message || 'fetch-failed' };
    }
}

function computeSnapshotHealth(db, nowMs) {
    if (!db) return { snapshots24h: 0, snapshotsPerHour: 0, maxGapMs: null, gapCount: 0 };
    const sinceMs = nowMs - DAY_MS;
    const rows = db.prepare(
        'SELECT ts FROM market_snapshots WHERE ts >= ? ORDER BY ts ASC'
    ).all(sinceMs);

    if (!rows.length) {
        return { snapshots24h: 0, snapshotsPerHour: 0, maxGapMs: null, gapCount: 0 };
    }

    let maxGapMs = 0;
    let gapCount = 0;
    const deltas = [];
    for (let i = 1; i < rows.length; i += 1) {
        const delta = rows[i].ts - rows[i - 1].ts;
        deltas.push(delta);
    }

    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const gapThreshold = Math.max(5000, median * 3);

    for (const d of deltas) {
        if (d > gapThreshold) gapCount += 1;
        if (d > maxGapMs) maxGapMs = d;
    }

    const snapshotsPerHour = rows.length / 24;

    return { snapshots24h: rows.length, snapshotsPerHour, maxGapMs, gapCount };
}

function computePostFillCoverage(db) {
    if (!db) return { total: 0, with1s: 0, with3s: 0 };
    const row = db.prepare(
        'SELECT COUNT(*) as total, SUM(CASE WHEN postMid1s IS NOT NULL THEN 1 ELSE 0 END) as with1s, SUM(CASE WHEN postMid3s IS NOT NULL THEN 1 ELSE 0 END) as with3s FROM trade_events WHERE action = ?'
    ).get('fill');
    return row ?? { total: 0, with1s: 0, with3s: 0 };
}

function computeAdverseSelection1h(db, nowMs) {
    if (!db) return { sampleCount: 0, adverseCount: 0, adverseRate: 0 };
    const sinceMs = nowMs - HOUR_MS;
    const row = db.prepare(
        `SELECT 
            COUNT(*) as sampleCount,
            SUM(CASE WHEN adverseSelectionRisk = 1 THEN 1 ELSE 0 END) as adverseCount
         FROM market_snapshots
         WHERE ts >= ? AND adverseSelectionRisk IS NOT NULL`
    ).get(sinceMs);
    const sampleCount = row?.sampleCount ?? 0;
    const adverseCount = row?.adverseCount ?? 0;
    return { sampleCount, adverseCount, adverseRate: sampleCount ? adverseCount / sampleCount : 0 };
}

function computeTradeStats(trades, nowMs) {
    const sinceMs = nowMs - DAY_MS;
    const recent = trades.filter((t) => t && t.paper === false && t.timestamp >= sinceMs);
    const attempts = recent.filter((t) => t.status === 'REJECTED' || t.status === 'FILLED' || t.status === 'PARTIAL');
    const rejects = attempts.filter((t) => t.status === 'REJECTED');
    const fills = attempts.filter((t) => t.status === 'FILLED' || t.status === 'PARTIAL');

    return {
        attempts: attempts.length,
        fills: fills.length,
        rejects: rejects.length,
        rejectRate: safeDiv(rejects.length, attempts.length),
    };
}

async function main() {
    const { json } = parseArgs();
    const nowMs = Date.now();
    const feedbackDbPath = process.env.FEEDBACK_DB_PATH
        ? path.resolve(process.cwd(), process.env.FEEDBACK_DB_PATH)
        : path.resolve(process.cwd(), 'data', 'feedback.sqlite');
    const tradeHistoryPath = path.resolve(process.cwd(), 'trade_history.json');
    const apiBase = process.env.BOT_API_URL || 'http://127.0.0.1:3000';

    const db = loadFeedbackDb(feedbackDbPath);
    const trades = loadTradeHistory(tradeHistoryPath);

    const snapshotHealth = computeSnapshotHealth(db, nowMs);
    const postFill = computePostFillCoverage(db);
    const adverse1h = computeAdverseSelection1h(db, nowMs);
    const tradeStats = computeTradeStats(trades, nowMs);

    const healthRes = await fetchJson(`${apiBase}/api/health`);
    const balancesRes = await fetchJson(`${apiBase}/api/runtime/balances`);
    const eventsRes = await fetchJson(
        `${apiBase}/api/runtime/events?type=XRPL_RECONNECTED&startMs=${nowMs - DAY_MS}&endMs=${nowMs}`
    );

    const reconnects24h = eventsRes.ok ? (eventsRes.data?.count ?? 0) : null;
    const processRunning = healthRes.ok;

    const reserveFloor = Number(process.env.RESERVE_FLOOR_XRP || 0);
    const xrpBalance = balancesRes.ok ? balancesRes.data?.data?.xrpBalance ?? null : null;
    const reserveOk = xrpBalance != null ? xrpBalance >= reserveFloor : null;

    const report = {
        timestamp: new Date(nowMs).toISOString(),
        uptime: {
            processRunning,
            reconnects24h,
        },
        snapshotHealth: {
            snapshots24h: snapshotHealth.snapshots24h,
            snapshotsPerHour: snapshotHealth.snapshotsPerHour,
            maxGapMs: snapshotHealth.maxGapMs,
            gapCount: snapshotHealth.gapCount,
        },
        tradeStats,
        postFillCoverage: {
            totalFills: postFill.total ?? 0,
            with1s: postFill.with1s ?? 0,
            with3s: postFill.with3s ?? 0,
            coverage1s: safeDiv(postFill.with1s ?? 0, postFill.total ?? 0),
            coverage3s: safeDiv(postFill.with3s ?? 0, postFill.total ?? 0),
        },
        adverseSelection1h: adverse1h,
        reserveSafety: {
            xrpBalance,
            reserveFloor,
            reserveOk,
        },
        warnings: {
            apiHealth: healthRes.ok ? null : healthRes.error,
            balances: balancesRes.ok ? null : balancesRes.error,
            events: eventsRes.ok ? null : eventsRes.error,
        },
    };

    if (db) db.close();

    if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    console.log('=== Daily Health Check ===');
    console.log(`Timestamp: ${report.timestamp}`);
    console.log('');
    console.log(`Uptime: ${report.uptime.processRunning ? 'RUNNING' : 'DOWN'} | reconnects(24h): ${report.uptime.reconnects24h ?? 'n/a'}`);
    console.log(`Snapshots: ${report.snapshotHealth.snapshots24h} / 24h | ${report.snapshotHealth.snapshotsPerHour.toFixed(1)} per hour`);
    console.log(`Snapshot gaps: ${report.snapshotHealth.gapCount} | max gap: ${report.snapshotHealth.maxGapMs ?? 'n/a'} ms`);
    console.log(`Trades (24h): attempts=${report.tradeStats.attempts}, fills=${report.tradeStats.fills}, rejects=${report.tradeStats.rejects}, rejectRate=${report.tradeStats.rejectRate == null ? 'n/a' : (report.tradeStats.rejectRate * 100).toFixed(1) + '%'}`);
    console.log(`Post-fill coverage: 1s=${report.postFillCoverage.coverage1s == null ? 'n/a' : (report.postFillCoverage.coverage1s * 100).toFixed(1) + '%'} | 3s=${report.postFillCoverage.coverage3s == null ? 'n/a' : (report.postFillCoverage.coverage3s * 100).toFixed(1) + '%'} (fills=${report.postFillCoverage.totalFills})`);
    console.log(`Adverse selection 1h: ${(report.adverseSelection1h.adverseRate * 100).toFixed(1)}% (${report.adverseSelection1h.adverseCount}/${report.adverseSelection1h.sampleCount})`);
    console.log(`Reserve safety: balance=${report.reserveSafety.xrpBalance ?? 'n/a'} XRP | floor=${report.reserveSafety.reserveFloor} | ok=${report.reserveSafety.reserveOk == null ? 'n/a' : report.reserveSafety.reserveOk}`);
}

main();
