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

function asFinite(value, fallback = null) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function asPos(value, fallback = null) {
    const n = asFinite(value, fallback);
    if (n == null) return fallback;
    return n > 0 ? n : fallback;
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

function currencyToHex(currency) {
    const upper = String(currency ?? '').trim().toUpperCase();
    if (!upper) return upper;
    if (upper.length <= 3) return upper;
    if (/^[0-9A-F]{40}$/.test(upper)) return upper;
    return Buffer.from(upper, 'utf8').toString('hex').toUpperCase().padEnd(40, '0');
}

function canonicalizePairKey(pairKey) {
    const raw = String(pairKey ?? '').trim();
    const [base, quote, ...rest] = raw.split('/');
    if (!base || !quote || rest.length > 0) return raw.toUpperCase();
    return `${decodeCurrencyCode(base)}/${decodeCurrencyCode(quote)}`;
}

function getPairAliases(pairKey) {
    const canonical = canonicalizePairKey(pairKey);
    if (!canonical) return [];
    const aliases = new Set([
        canonical,
        canonical.toUpperCase(),
        String(pairKey ?? '').trim(),
        String(pairKey ?? '').trim().toUpperCase(),
    ]);
    const [base, quote] = canonical.split('/');
    if (base && quote) {
        const baseCode = base === 'XRP' ? 'XRP' : currencyToHex(base);
        const quoteCode = quote === 'XRP' ? 'XRP' : currencyToHex(quote);
        aliases.add(`${baseCode}/${quoteCode}`);
    }
    return Array.from(aliases).filter((v) => v.length > 0);
}

function keyFromRecord(pairKey, side, txHashOrId) {
    return `${canonicalizePairKey(pairKey)}|${String(side ?? '').toLowerCase()}|${String(txHashOrId ?? '').trim().toUpperCase()}`;
}

function sideSign(side) {
    return String(side ?? '').toLowerCase() === 'buy' ? 1 : -1;
}

function canonicalSlippageBps(side, expectedPrice, fillPrice) {
    const expected = asPos(expectedPrice, null);
    const fill = asPos(fillPrice, null);
    if (expected == null || fill == null) return null;
    const s = String(side ?? '').toLowerCase();
    if (s === 'buy') return ((fill - expected) / expected) * 10000;
    if (s === 'sell') return ((expected - fill) / expected) * 10000;
    return null;
}

function computeEffectiveSpreadBps(side, fillPrice, midDecision) {
    const fill = asPos(fillPrice, null);
    const mid = asPos(midDecision, null);
    if (fill == null || mid == null) return null;
    return 2 * sideSign(side) * ((fill - mid) / mid) * 10000;
}

function computeRealizedSpreadBps(side, fillPrice, midDecision, midAfter) {
    const fill = asPos(fillPrice, null);
    const mid = asPos(midDecision, null);
    const after = asPos(midAfter, null);
    if (fill == null || mid == null || after == null) return null;
    return 2 * sideSign(side) * ((fill - after) / mid) * 10000;
}

function computeImpactBps(side, midDecision, midAfter) {
    const mid = asPos(midDecision, null);
    const after = asPos(midAfter, null);
    if (mid == null || after == null) return null;
    return 2 * sideSign(side) * ((after - mid) / mid) * 10000;
}

function computeImplementationShortfallQuote(side, decisionPrice, fillPrice, filledBase) {
    const decision = asPos(decisionPrice, null);
    const fill = asPos(fillPrice, null);
    const base = asPos(filledBase, null);
    if (decision == null || fill == null || base == null) return null;
    const s = String(side ?? '').toLowerCase();
    if (s === 'buy') return (fill - decision) * base;
    if (s === 'sell') return (decision - fill) * base;
    return null;
}

function computeExecutionEdgeVsMid(side, midDecision, fillPrice) {
    const mid = asPos(midDecision, null);
    const fill = asPos(fillPrice, null);
    if (mid == null || fill == null) return null;
    return sideSign(side) * ((mid - fill) / mid) * 10000;
}

function computeExecutionEdgeVsBbo(side, midDecision, bidDecision, askDecision, fillPrice) {
    const mid = asPos(midDecision, null);
    const fill = asPos(fillPrice, null);
    if (mid == null || fill == null) return null;
    const s = String(side ?? '').toLowerCase();
    const bbo = s === 'buy' ? asPos(askDecision, null) : asPos(bidDecision, null);
    if (bbo == null) return null;
    return sideSign(side) * ((bbo - fill) / mid) * 10000;
}

function computeSignalExPost(side, midDecision, midDecisionH) {
    const mid = asPos(midDecision, null);
    const h = asPos(midDecisionH, null);
    if (mid == null || h == null) return null;
    return sideSign(side) * ((h - mid) / mid) * 10000;
}

function computeDriftBps(side, midDecision, midFillH) {
    const mid = asPos(midDecision, null);
    const h = asPos(midFillH, null);
    if (mid == null || h == null) return null;
    return sideSign(side) * ((h - mid) / mid) * 10000;
}

function computePnlExecQuote(side, midDecision, fillPrice, baseFilled) {
    const mid = asPos(midDecision, null);
    const fill = asPos(fillPrice, null);
    const base = asPos(baseFilled, null);
    if (mid == null || fill == null || base == null) return null;
    return sideSign(side) * (mid - fill) * base;
}

function computePnlDriftQuote(side, midDecision, midFillH, baseFilled) {
    const mid = asPos(midDecision, null);
    const h = asPos(midFillH, null);
    const base = asPos(baseFilled, null);
    if (mid == null || h == null || base == null) return null;
    return sideSign(side) * (h - mid) * base;
}

function roundNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    return Number(value.toFixed(12));
}

function getMid(snapshot) {
    if (!snapshot) return null;
    const explicitMid = asPos(snapshot.midPrice, null);
    if (explicitMid != null) return explicitMid;
    const bid = asPos(snapshot.bestBid, null);
    const ask = asPos(snapshot.bestAsk, null);
    if (bid != null && ask != null) return (bid + ask) / 2;
    return null;
}

function getSnapshotBefore(db, pairKey, refTs, toleranceMs) {
    const aliases = getPairAliases(pairKey);
    if (!aliases.length || !Number.isFinite(refTs)) return null;
    const placeholders = aliases.map(() => '?').join(', ');
    const sql = `
        SELECT *
        FROM market_snapshots
        WHERE pairKey IN (${placeholders})
          AND ts <= ?
          AND ts >= ?
        ORDER BY ts DESC
        LIMIT 1
    `;
    return db.prepare(sql).get(...aliases, refTs, refTs - toleranceMs) ?? null;
}

function dedupeTradeEvents(rows) {
    const bestByKey = new Map();
    for (const row of rows) {
        const pair = canonicalizePairKey(row.pairKey);
        const side = String(row.side ?? '').toLowerCase();
        const hashOrId = String(row.txHash ?? '').trim() || String(row.id);
        const key = keyFromRecord(pair, side, hashOrId);
        const prev = bestByKey.get(key);
        if (!prev || asFinite(row.ts, 0) > asFinite(prev.ts, 0) || (asFinite(row.ts, 0) === asFinite(prev.ts, 0) && String(row.id) > String(prev.id))) {
            bestByKey.set(key, row);
        }
    }
    return Array.from(bestByKey.values()).sort((a, b) => asFinite(a.ts, 0) - asFinite(b.ts, 0));
}

function normalizeStatus(action, fillRatio, isPartial, fillPrice, filledBase) {
    const normalizedAction = String(action ?? '').toLowerCase();
    if (normalizedAction === 'error') return 'REJECTED';
    if (normalizedAction === 'pending') return 'PENDING';
    if (normalizedAction === 'fill') {
        const hasFill = asPos(fillPrice, null) != null || asPos(filledBase, null) != null;
        if (!hasFill) return 'PENDING';
        if (asFinite(isPartial, 0) === 1) return 'PARTIAL';
        if (fillRatio != null && fillRatio < 0.999) return 'PARTIAL';
        return 'FILLED';
    }
    return 'UNKNOWN';
}

function main() {
    const { dbPath, write } = parseArgs(process.argv);
    if (!fs.existsSync(dbPath)) {
        throw new Error(`feedback db not found: ${dbPath}`);
    }

    const db = new Database(dbPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dbDir = path.dirname(dbPath);
    const backupPath = path.join(dbDir, `feedback.panels.backup.${timestamp}.sqlite`);
    const reportPath = path.join(dbDir, `feedback.panels.backfill.${timestamp}.json`);

    const beforeCounts = {
        tradeEvents: db.prepare('SELECT COUNT(*) AS n FROM trade_events').get().n,
        executionQualityEvents: db.prepare('SELECT COUNT(*) AS n FROM execution_quality_events').get().n,
        edgeAttributionEvents: db.prepare('SELECT COUNT(*) AS n FROM edge_attribution_events').get().n,
    };

    const rawTradeEvents = db.prepare('SELECT * FROM trade_events').all();
    const dedupedTrades = dedupeTradeEvents(rawTradeEvents);

    const existingEqRows = db.prepare('SELECT id, eventId, txHash, pairKeyCanonical, side FROM execution_quality_events').all();
    const existingEdgeRows = db.prepare('SELECT id, eventId, txHash, pairKeyCanonical, side FROM edge_attribution_events').all();
    const existingEqKeys = new Set(existingEqRows.map((row) => keyFromRecord(row.pairKeyCanonical, row.side, String(row.txHash ?? '').trim() || String(row.eventId ?? '').trim() || String(row.id))));
    const existingEdgeKeys = new Set(existingEdgeRows.map((row) => keyFromRecord(row.pairKeyCanonical, row.side, String(row.txHash ?? '').trim() || String(row.eventId ?? '').trim() || String(row.id))));

    const eqRecords = [];
    const edgeRecords = [];
    const skippedEq = [];
    const skippedEdge = [];

    for (const row of dedupedTrades) {
        const pair = canonicalizePairKey(row.pairKey);
        const side = String(row.side ?? '').toLowerCase();
        if (side !== 'buy' && side !== 'sell') {
            continue;
        }

        const txHash = String(row.txHash ?? '').trim() || null;
        const hashOrId = txHash || String(row.id);
        const dedupeKey = keyFromRecord(pair, side, hashOrId);
        if (existingEqKeys.has(dedupeKey)) {
            skippedEq.push({ id: row.id, txHash, reason: 'existing-eq-key' });
            continue;
        }

        const ts = asFinite(row.ts, Date.now());
        const pairAliases = JSON.stringify(getPairAliases(pair));
        const intentPrice = asPos(row.intentPrice, null);
        const fillPriceRaw = asPos(row.fillPrice, null);
        const fillBaseRaw = asPos(row.fillSizeBase, null);
        const fillQuoteRaw = asPos(row.fillSizeQuote, null);
        const fillPrice = fillPriceRaw != null
            ? fillPriceRaw
            : (fillBaseRaw != null && fillQuoteRaw != null ? (fillQuoteRaw / fillBaseRaw) : null);
        const amountBase = asPos(row.intentSizeBase, null);
        let filledBase = fillBaseRaw;
        let filledQuote = fillQuoteRaw;
        if (filledBase == null && filledQuote != null && fillPrice != null) {
            filledBase = filledQuote / fillPrice;
        }
        if (filledQuote == null && filledBase != null && fillPrice != null) {
            filledQuote = filledBase * fillPrice;
        }
        if (amountBase != null && filledBase != null && filledBase > amountBase + EPS) {
            filledBase = amountBase;
        }

        const fillRatio = asFinite(row.fillRatio, null) != null
            ? asFinite(row.fillRatio, null)
            : (amountBase != null && amountBase > 0 && filledBase != null ? Math.max(0, Math.min(1, filledBase / amountBase)) : null);

        const status = normalizeStatus(row.action, fillRatio, row.isPartial, fillPrice, filledBase);
        const source = asFinite(row.isBotTrade, null) == null
            ? 'unknown'
            : (asFinite(row.isBotTrade, 0) === 1 ? 'bot' : 'manual');
        const rejectReason = status === 'REJECTED'
            ? (String(row.error ?? '').trim() || String(row.resultCode ?? '').trim() || null)
            : null;

        const decisionSnapshot = getSnapshotBefore(db, pair, ts, 10_000);
        const decisionMid = asPos(row.decisionMidPrice, null) ?? getMid(decisionSnapshot);
        const decisionBid = asPos(row.decisionBestBid, null) ?? asPos(decisionSnapshot?.bestBid, null);
        const decisionAsk = asPos(row.decisionBestAsk, null) ?? asPos(decisionSnapshot?.bestAsk, null);
        const decisionPrice = decisionMid ?? intentPrice;
        const expectedPrice = intentPrice;
        const expectedPriceSource = expectedPrice != null
            ? (String(row.expectedPriceSource ?? '').trim() || 'fallback_intent')
            : null;

        const bboDecision = side === 'buy' ? decisionAsk : decisionBid;

        const target1m = ts + 60_000;
        const target5m = ts + 300_000;
        const snapshot1m = getSnapshotBefore(db, pair, target1m, 120_000);
        const snapshot5m = getSnapshotBefore(db, pair, target5m, 180_000);
        const midAfter1m = getMid(snapshot1m);
        const midAfter5m = getMid(snapshot5m);

        const slippageBpsVsIntent = asFinite(row.slippageBpsVsIntent, null) ?? canonicalSlippageBps(side, intentPrice, fillPrice);
        const slippageBpsVsMid = asFinite(row.slippageBpsVsMid, null) ?? canonicalSlippageBps(side, decisionMid, fillPrice);
        const slippageBpsVsBbo = asFinite(row.slippageBpsVsBbo, null) ?? canonicalSlippageBps(side, bboDecision, fillPrice);

        const flags = ['BACKFILLED_FROM_TRADE_EVENTS'];
        if (!decisionSnapshot && decisionMid == null) {
            flags.push('MISSING_DECISION_SNAPSHOT');
        }
        if (status === 'PENDING') {
            flags.push('LEGACY_PENDING');
        }

        const eqId = `bf-eq-${row.id}`;
        eqRecords.push({
            id: eqId,
            ts,
            eventId: row.id,
            txHash,
            pairKeyCanonical: pair,
            pairAliases,
            side,
            strategy: String(row.strategy ?? '').trim() || null,
            regime: String(row.entryFlowRegime ?? decisionSnapshot?.flowRegime ?? '').trim() || null,
            source,
            intentPrice,
            expectedPrice,
            expectedPriceSource,
            decisionMid,
            decisionBid,
            decisionAsk,
            fillPrice,
            amountBase,
            filledBase,
            filledQuote,
            slippageBpsVsIntent,
            slippageBpsVsMid,
            slippageBpsVsBbo,
            effSpreadBps: computeEffectiveSpreadBps(side, fillPrice, decisionMid),
            realizedSpreadBps1m: (status === 'FILLED' || status === 'PARTIAL')
                ? computeRealizedSpreadBps(side, fillPrice, decisionMid, midAfter1m)
                : null,
            realizedSpreadBps5m: (status === 'FILLED' || status === 'PARTIAL')
                ? computeRealizedSpreadBps(side, fillPrice, decisionMid, midAfter5m)
                : null,
            impactBps1m: (status === 'FILLED' || status === 'PARTIAL')
                ? computeImpactBps(side, decisionMid, midAfter1m)
                : null,
            impactBps5m: (status === 'FILLED' || status === 'PARTIAL')
                ? computeImpactBps(side, decisionMid, midAfter5m)
                : null,
            implShortfallQuote: computeImplementationShortfallQuote(side, decisionPrice, fillPrice, filledBase),
            fillRatio,
            status,
            rejectReason,
            flags: JSON.stringify(flags),
            guardQuarantined: 0,
            decisionTs: ts,
            submitTs: ts,
            validatedTs: ts,
            decisionToSubmitMs: 0,
            submitToValidatedMs: 0,
            decisionToValidatedMs: 0,
        });
        existingEqKeys.add(dedupeKey);

        const isFillLike = status === 'FILLED' || status === 'PARTIAL';
        if (!isFillLike || asPos(fillPrice, null) == null || asPos(filledBase, null) == null) {
            continue;
        }

        if (existingEdgeKeys.has(dedupeKey)) {
            skippedEdge.push({ id: row.id, txHash, reason: 'existing-edge-key' });
            continue;
        }

        const fillSnapshot = getSnapshotBefore(db, pair, ts, 10_000);
        const midFill = getMid(fillSnapshot);
        const decision1mSnapshot = getSnapshotBefore(db, pair, ts + 60_000, 120_000);
        const decision5mSnapshot = getSnapshotBefore(db, pair, ts + 300_000, 180_000);
        const fill1mSnapshot = getSnapshotBefore(db, pair, ts + 60_000, 120_000);
        const fill5mSnapshot = getSnapshotBefore(db, pair, ts + 300_000, 180_000);
        const midDecision1m = getMid(decision1mSnapshot);
        const midDecision5m = getMid(decision5mSnapshot);
        const midFill1m = getMid(fill1mSnapshot);
        const midFill5m = getMid(fill5mSnapshot);

        const pnlExecQuote = computePnlExecQuote(side, decisionMid, fillPrice, filledBase);
        const pnlDriftQuote1m = computePnlDriftQuote(side, decisionMid, midFill1m, filledBase);
        const pnlDriftQuote5m = computePnlDriftQuote(side, decisionMid, midFill5m, filledBase);

        edgeRecords.push({
            id: `bf-edge-${row.id}`,
            ts,
            eventId: row.id,
            txHash,
            pairKeyCanonical: pair,
            pairAliases,
            side,
            strategy: String(row.strategy ?? '').trim() || null,
            regime: String(row.entryFlowRegime ?? decisionSnapshot?.flowRegime ?? '').trim() || null,
            source,
            midDecision: decisionMid,
            bidDecision: decisionBid,
            askDecision: decisionAsk,
            fillPrice,
            midFill,
            mid1m: midFill1m,
            mid5m: midFill5m,
            baseFilled: filledBase,
            filledQuote,
            signalEdgeBpsExAnte: null,
            signalEdgeBpsExPost1m: computeSignalExPost(side, decisionMid, midDecision1m),
            signalEdgeBpsExPost5m: computeSignalExPost(side, decisionMid, midDecision5m),
            executionEdgeBpsVsMid: computeExecutionEdgeVsMid(side, decisionMid, fillPrice),
            executionEdgeBpsVsBbo: computeExecutionEdgeVsBbo(side, decisionMid, decisionBid, decisionAsk, fillPrice),
            driftBps1m: computeDriftBps(side, decisionMid, midFill1m),
            driftBps5m: computeDriftBps(side, decisionMid, midFill5m),
            pnlExecQuote,
            pnlDriftQuote1m,
            pnlTotalQuote1m: pnlExecQuote != null && pnlDriftQuote1m != null ? pnlExecQuote + pnlDriftQuote1m : null,
            pnlDriftQuote5m,
            pnlTotalQuote5m: pnlExecQuote != null && pnlDriftQuote5m != null ? pnlExecQuote + pnlDriftQuote5m : null,
            hasDecisionSnapshot: asPos(decisionMid, null) != null ? 1 : 0,
            hasHorizon1m: asPos(midFill1m, null) != null ? 1 : 0,
            hasHorizon5m: asPos(midFill5m, null) != null ? 1 : 0,
        });
        existingEdgeKeys.add(dedupeKey);
    }

    const insertEq = db.prepare(`
        INSERT INTO execution_quality_events (
            id, ts, eventId, txHash, pairKeyCanonical, pairAliases,
            side, strategy, regime, source,
            intentPrice, expectedPrice, expectedPriceSource,
            decisionMid, decisionBid, decisionAsk, fillPrice,
            amountBase, filledBase, filledQuote,
            slippageBpsVsIntent, slippageBpsVsMid, slippageBpsVsBbo,
            effSpreadBps, realizedSpreadBps1m, realizedSpreadBps5m,
            impactBps1m, impactBps5m, implShortfallQuote, fillRatio,
            status, rejectReason, flags, guardQuarantined,
            decisionTs, submitTs, validatedTs,
            decisionToSubmitMs, submitToValidatedMs, decisionToValidatedMs
        ) VALUES (
            @id, @ts, @eventId, @txHash, @pairKeyCanonical, @pairAliases,
            @side, @strategy, @regime, @source,
            @intentPrice, @expectedPrice, @expectedPriceSource,
            @decisionMid, @decisionBid, @decisionAsk, @fillPrice,
            @amountBase, @filledBase, @filledQuote,
            @slippageBpsVsIntent, @slippageBpsVsMid, @slippageBpsVsBbo,
            @effSpreadBps, @realizedSpreadBps1m, @realizedSpreadBps5m,
            @impactBps1m, @impactBps5m, @implShortfallQuote, @fillRatio,
            @status, @rejectReason, @flags, @guardQuarantined,
            @decisionTs, @submitTs, @validatedTs,
            @decisionToSubmitMs, @submitToValidatedMs, @decisionToValidatedMs
        )
    `);

    const insertEdge = db.prepare(`
        INSERT INTO edge_attribution_events (
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
    `);

    if (write) {
        fs.copyFileSync(dbPath, backupPath);
        db.transaction(() => {
            for (const record of eqRecords) {
                insertEq.run(record);
            }
            for (const record of edgeRecords) {
                insertEdge.run(record);
            }
        })();
    }

    const afterCounts = {
        tradeEvents: db.prepare('SELECT COUNT(*) AS n FROM trade_events').get().n,
        executionQualityEvents: db.prepare('SELECT COUNT(*) AS n FROM execution_quality_events').get().n,
        edgeAttributionEvents: db.prepare('SELECT COUNT(*) AS n FROM edge_attribution_events').get().n,
    };

    const report = {
        generatedAt: new Date().toISOString(),
        dbPath,
        writeApplied: write,
        backupPath: write ? backupPath : null,
        summary: {
            beforeCounts,
            afterCounts,
            rawTradeEvents: rawTradeEvents.length,
            dedupedTradeEvents: dedupedTrades.length,
            eqInserted: eqRecords.length,
            edgeInserted: edgeRecords.length,
            eqSkippedExisting: skippedEq.length,
            edgeSkippedExisting: skippedEdge.length,
        },
        sample: {
            eqFirst5: eqRecords.slice(0, 5).map((r) => ({
                ...r,
                slippageBpsVsIntent: roundNumber(r.slippageBpsVsIntent),
                slippageBpsVsMid: roundNumber(r.slippageBpsVsMid),
                slippageBpsVsBbo: roundNumber(r.slippageBpsVsBbo),
                effSpreadBps: roundNumber(r.effSpreadBps),
            })),
            edgeFirst5: edgeRecords.slice(0, 5).map((r) => ({
                ...r,
                executionEdgeBpsVsMid: roundNumber(r.executionEdgeBpsVsMid),
                driftBps1m: roundNumber(r.driftBps1m),
                pnlExecQuote: roundNumber(r.pnlExecQuote),
            })),
        },
        skipped: {
            eq: skippedEq,
            edge: skippedEdge,
        },
    };

    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    db.close();
    console.log(JSON.stringify({
        dbPath,
        writeApplied: write,
        backupPath: write ? backupPath : null,
        reportPath,
        beforeCounts,
        afterCounts,
        eqInserted: eqRecords.length,
        edgeInserted: edgeRecords.length,
        eqSkippedExisting: skippedEq.length,
        edgeSkippedExisting: skippedEdge.length,
    }, null, 2));
}

main();
