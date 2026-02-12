#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const EPS = 1e-9;

function parseArgs(argv) {
    const args = {
        write: false,
        dbPath: process.env.FEEDBACK_DB_PATH
            ? path.resolve(process.cwd(), process.env.FEEDBACK_DB_PATH)
            : path.resolve(process.cwd(), 'data', 'feedback.sqlite'),
    };
    for (let i = 2; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--write') {
            args.write = true;
            continue;
        }
        if (token === '--db' && argv[i + 1]) {
            args.dbPath = path.resolve(process.cwd(), argv[i + 1]);
            i++;
        }
    }
    return args;
}

function asFinite(value, fallback = 0) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function asPos(value, fallback = 0) {
    const n = asFinite(value, fallback);
    return n > 0 ? n : fallback;
}

function maybePos(value) {
    const n = asFinite(value, 0);
    return n > 0 ? n : null;
}

function decodeCurrencyCode(code) {
    const upper = String(code ?? '').trim().toUpperCase();
    if (!upper) return upper;
    if (!/^[0-9A-F]{40}$/.test(upper)) return upper;
    try {
        const decoded = Buffer.from(upper, 'hex').toString('ascii').replace(/\0/g, '').trim().toUpperCase();
        return decoded || upper;
    } catch {
        return upper;
    }
}

function canonicalizePairKey(pairKey) {
    const raw = String(pairKey ?? '').trim();
    const [base, quote, ...rest] = raw.split('/');
    if (!base || !quote || rest.length > 0) return raw.toUpperCase();
    return `${decodeCurrencyCode(base)}/${decodeCurrencyCode(quote)}`;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

function isFillLike(event) {
    return event.action === 'fill' || (event.action === 'offer_create' && asPos(event.fillPrice, 0) > 0);
}

function buildTypicalByPair(events) {
    const perPair = new Map();
    for (const e of events) {
        if (!isFillLike(e)) continue;
        const pair = canonicalizePairKey(e.pairKey);
        const side = String(e.side ?? '').toLowerCase();
        if (side !== 'buy') continue;
        const p = asPos(e.fillPrice, 0);
        if (p <= 0) continue;
        if (!perPair.has(pair)) perPair.set(pair, []);
        perPair.get(pair).push(p);
    }
    for (const e of events) {
        if (!isFillLike(e)) continue;
        const pair = canonicalizePairKey(e.pairKey);
        if (perPair.get(pair)?.length) continue;
        const p = asPos(e.fillPrice, 0);
        if (p <= 0) continue;
        if (!perPair.has(pair)) perPair.set(pair, []);
        perPair.get(pair).push(p);
    }
    const out = new Map();
    for (const [pair, prices] of perPair.entries()) {
        const m = median(prices.filter((v) => v > 0));
        if (m != null) out.set(pair, m);
    }
    return out;
}

function normalizeEvent(row, typicalByPair) {
    const updated = { ...row };
    const repairFlags = [];
    let unitIntegrity = true;

    updated.pairKey = canonicalizePairKey(row.pairKey);
    if (updated.pairKey !== row.pairKey) {
        repairFlags.push('PAIR_CANONICALIZED');
    }

    if (!isFillLike(updated)) {
        return { updated, repairFlags, unitIntegrity };
    }

    const side = String(updated.side ?? '').toLowerCase();
    let fillPrice = asPos(updated.fillPrice, 0);
    const intentPrice = maybePos(updated.intentPrice);
    const mid = maybePos(updated.midPriceAtDecision);
    const amountBase = asPos(updated.intentSizeBase, 0);
    let fillBase = asPos(updated.fillSizeBase, 0);
    let fillQuote = asPos(updated.fillSizeQuote, 0);

    const invertedByReference = side === 'sell'
        && fillPrice > 0
        && intentPrice != null
        && Math.abs((intentPrice * fillPrice) - 1) < 0.02;
    const typical = typicalByPair.get(updated.pairKey) ?? null;
    const invertedByTypical = side === 'sell'
        && fillPrice > 0
        && updated.pairKey === 'XRP/RLUSD'
        && fillPrice < 1
        && (typical != null && typical > 1.05);

    if (invertedByReference || invertedByTypical) {
        fillPrice = fillPrice > 0 ? (1 / fillPrice) : 0;
        repairFlags.push('INVERTED_PRICE_FIXED');
    }

    if (side === 'sell' && fillQuote <= 0 && amountBase > 0 && fillBase > amountBase + EPS) {
        fillQuote = fillBase;
        fillBase = fillPrice > 0 ? (fillQuote / fillPrice) : 0;
        repairFlags.push('UNIT_MIX_FIXED');
    }

    if (fillQuote <= 0 && fillBase > 0 && fillPrice > 0) {
        fillQuote = fillBase * fillPrice;
    }
    if (fillBase <= 0 && fillQuote > 0 && fillPrice > 0) {
        fillBase = fillQuote / fillPrice;
    }
    if (amountBase > 0 && fillBase > amountBase + EPS) {
        fillBase = amountBase;
        repairFlags.push('FILL_BASE_CLAMPED');
    }

    unitIntegrity = amountBase <= 0 || fillBase <= amountBase + EPS;

    updated.fillPrice = fillPrice > 0 ? fillPrice : null;
    updated.fillSizeBase = fillBase > 0 ? fillBase : null;
    updated.fillSizeQuote = fillQuote > 0 ? fillQuote : null;

    if (intentPrice != null && fillPrice > 0 && (side === 'buy' || side === 'sell')) {
        const slippage = side === 'buy'
            ? ((fillPrice - intentPrice) / intentPrice) * 10000
            : ((intentPrice - fillPrice) / intentPrice) * 10000;
        updated.slippageBpsVsIntent = slippage;
    }

    if (mid != null && fillPrice > 0 && (side === 'buy' || side === 'sell')) {
        const raw = ((fillPrice - mid) / mid) * 10000;
        updated.edgeBpsVsMid = side === 'buy' ? -raw : raw;
    }

    return { updated, repairFlags, unitIntegrity };
}

function dedupeFillHashes(events, unitIntegrityById) {
    const byHash = new Map();
    for (const e of events) {
        const hash = String(e.txHash ?? '').trim();
        if (!hash || !isFillLike(e)) continue;
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash).push(e);
    }

    const dropped = [];
    const keepIds = new Set(events.map((e) => e.id));

    function actionPriority(action) {
        if (action === 'fill') return 2;
        if (action === 'offer_create') return 1;
        return 0;
    }

    for (const [hash, group] of byHash.entries()) {
        if (group.length <= 1) continue;
        const sorted = [...group].sort((a, b) => {
            const aTuple = [
                actionPriority(a.action),
                asFinite(a.isBotTrade, 0),
                unitIntegrityById.get(a.id) ? 1 : 0,
                String(a.resultCode ?? '') === 'tesSUCCESS' ? 1 : 0,
                asPos(a.fillRatio, 0),
                asFinite(a.ts, 0),
            ];
            const bTuple = [
                actionPriority(b.action),
                asFinite(b.isBotTrade, 0),
                unitIntegrityById.get(b.id) ? 1 : 0,
                String(b.resultCode ?? '') === 'tesSUCCESS' ? 1 : 0,
                asPos(b.fillRatio, 0),
                asFinite(b.ts, 0),
            ];
            for (let i = 0; i < aTuple.length; i++) {
                if (aTuple[i] !== bTuple[i]) return bTuple[i] - aTuple[i];
            }
            return 0;
        });
        const winner = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
            const loser = sorted[i];
            keepIds.delete(loser.id);
            dropped.push({
                txHash: hash,
                droppedId: loser.id,
                keptId: winner.id,
                reason: 'duplicate-fill-hash-lower-priority',
            });
        }
    }

    return { keepIds, dropped };
}

function computeReciprocalAnomalies(events) {
    let count = 0;
    for (const e of events) {
        if (!isFillLike(e)) continue;
        if (String(e.side ?? '').toLowerCase() !== 'sell') continue;
        const intent = maybePos(e.intentPrice);
        const fill = maybePos(e.fillPrice);
        if (intent == null || fill == null) continue;
        if (Math.abs((intent * fill) - 1) < 0.02) count++;
    }
    return count;
}

function computeAvgSlippage(events) {
    const vals = [];
    for (const e of events) {
        if (!isFillLike(e)) continue;
        if (asFinite(e.isBotTrade, 0) !== 1) continue;
        const slip = asFinite(e.slippageBpsVsIntent, NaN);
        if (Number.isFinite(slip)) vals.push(slip);
    }
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function main() {
    const { dbPath, write } = parseArgs(process.argv);
    if (!fs.existsSync(dbPath)) {
        throw new Error(`feedback db not found: ${dbPath}`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dbDir = path.dirname(dbPath);
    const backupPath = path.join(dbDir, `feedback.backup.${timestamp}.sqlite`);
    const reportPath = path.join(dbDir, `feedback.backfill.${timestamp}.json`);

    const db = new Database(dbPath);
    const tradeEvents = db.prepare('SELECT * FROM trade_events').all();
    const marketSnapshots = db.prepare('SELECT id, pairKey FROM market_snapshots').all();

    const beforeReciprocal = computeReciprocalAnomalies(tradeEvents);
    const beforeAvgSlippage = computeAvgSlippage(tradeEvents);

    const typicalByPair = buildTypicalByPair(tradeEvents);
    const normalizedEvents = [];
    const repairLog = [];
    const unitIntegrityById = new Map();

    for (const row of tradeEvents) {
        const { updated, repairFlags, unitIntegrity } = normalizeEvent(row, typicalByPair);
        normalizedEvents.push(updated);
        unitIntegrityById.set(updated.id, unitIntegrity);
        if (repairFlags.length > 0) {
            repairLog.push({
                id: row.id,
                txHash: row.txHash ?? null,
                repairFlags,
                before: {
                    pairKey: row.pairKey,
                    fillPrice: row.fillPrice,
                    fillSizeBase: row.fillSizeBase,
                    fillSizeQuote: row.fillSizeQuote,
                    slippageBpsVsIntent: row.slippageBpsVsIntent,
                    edgeBpsVsMid: row.edgeBpsVsMid,
                },
                after: {
                    pairKey: updated.pairKey,
                    fillPrice: updated.fillPrice,
                    fillSizeBase: updated.fillSizeBase,
                    fillSizeQuote: updated.fillSizeQuote,
                    slippageBpsVsIntent: updated.slippageBpsVsIntent,
                    edgeBpsVsMid: updated.edgeBpsVsMid,
                },
            });
        }
    }

    const { keepIds, dropped } = dedupeFillHashes(normalizedEvents, unitIntegrityById);
    const filteredEvents = normalizedEvents.filter((e) => keepIds.has(e.id));
    const afterReciprocal = computeReciprocalAnomalies(filteredEvents);
    const afterAvgSlippage = computeAvgSlippage(filteredEvents);

    const snapshotUpdates = marketSnapshots
        .map((s) => ({ id: s.id, pairKey: canonicalizePairKey(s.pairKey), oldPairKey: s.pairKey }))
        .filter((s) => s.pairKey !== s.oldPairKey);

    if (write) {
        fs.copyFileSync(dbPath, backupPath);
        const updateStmt = db.prepare(`
            UPDATE trade_events
            SET pairKey = ?,
                fillPrice = ?,
                fillSizeBase = ?,
                fillSizeQuote = ?,
                slippageBpsVsIntent = ?,
                edgeBpsVsMid = ?
            WHERE id = ?
        `);
        const updateSnapshotStmt = db.prepare('UPDATE market_snapshots SET pairKey = ? WHERE id = ?');
        const deleteStmt = db.prepare('DELETE FROM trade_events WHERE id = ?');

        const tx = db.transaction(() => {
            for (const e of normalizedEvents) {
                updateStmt.run(
                    e.pairKey,
                    e.fillPrice,
                    e.fillSizeBase,
                    e.fillSizeQuote,
                    e.slippageBpsVsIntent,
                    e.edgeBpsVsMid,
                    e.id,
                );
            }
            for (const s of snapshotUpdates) {
                updateSnapshotStmt.run(s.pairKey, s.id);
            }
            for (const d of dropped) {
                deleteStmt.run(d.droppedId);
            }
        });
        tx();
    }

    db.close();

    const summary = {
        dbPath,
        backupPath: write ? backupPath : null,
        reportPath,
        writeApplied: write,
        totals: {
            inputTradeEvents: tradeEvents.length,
            outputTradeEvents: filteredEvents.length,
            repairedEvents: repairLog.length,
            droppedDuplicates: dropped.length,
            canonicalizedSnapshots: snapshotUpdates.length,
        },
        reciprocalAnomalies: {
            before: beforeReciprocal,
            after: afterReciprocal,
        },
        avgSlippageBpsVsIntent: {
            before: beforeAvgSlippage,
            after: afterAvgSlippage,
        },
    };

    const report = {
        generatedAt: new Date().toISOString(),
        summary,
        dropped,
        repairs: repairLog,
        snapshotPairUpdates: snapshotUpdates,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
}

main();
