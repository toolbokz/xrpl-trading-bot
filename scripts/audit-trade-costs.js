#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function safeAvg(values) {
    if (!values.length) return null;
    const sum = values.reduce((acc, val) => acc + val, 0);
    return sum / values.length;
}

function safeNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function formatBps(value) {
    if (value == null) return 'n/a';
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)} bps`;
}

function formatXrp(value) {
    if (value == null) return 'n/a';
    return `${value.toFixed(6)} XRP`;
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

function loadFeedbackDb(dbPath) {
    if (!fs.existsSync(dbPath)) return null;
    try {
        // Lazy require to avoid failing when dependency not installed.
        // eslint-disable-next-line global-require
        const Database = require('better-sqlite3');
        return new Database(dbPath, { readonly: true });
    } catch (err) {
        console.warn('Failed to open feedback DB:', err.message);
        return null;
    }
}

function summarizeTradeHistory(trades) {
    const liveTrades = trades.filter((trade) => trade && trade.paper === false);
    const filledTrades = liveTrades.filter((trade) => trade.status === 'FILLED' || trade.status === 'PARTIAL');
    const rejectedTrades = liveTrades.filter((trade) => trade.status === 'REJECTED');

    const avgFee = safeAvg(filledTrades.map((trade) => safeNumber(trade.fee)).filter((v) => v != null));
    const avgSlippageBps = safeAvg(
        filledTrades
            .map((trade) => safeNumber(trade.slippageBps))
            .filter((v) => v != null)
    );
    const feeBps = filledTrades
        .filter((trade) => trade.filled && trade.filled > 0 && trade.fee != null)
        .map((trade) => (trade.fee / trade.filled) * 10000);
    const avgFeeBps = safeAvg(feeBps);

    const totalAttempts = filledTrades.length + rejectedTrades.length;
    const rejectionRate = totalAttempts > 0 ? rejectedTrades.length / totalAttempts : null;

    return {
        filledCount: filledTrades.length,
        rejectedCount: rejectedTrades.length,
        avgFee,
        avgSlippageBps,
        avgFeeBps,
        rejectionRate,
    };
}

function summarizeFeedbackDb(db) {
    if (!db) return null;

    const offerCreateFee = db
        .prepare('SELECT AVG(txFeeXrp) as avgFee, COUNT(*) as count FROM trade_events WHERE action = ? AND txFeeXrp IS NOT NULL')
        .get('offer_create');
    const offerCancelFee = db
        .prepare('SELECT AVG(txFeeXrp) as avgFee, COUNT(*) as count FROM trade_events WHERE action = ? AND txFeeXrp IS NOT NULL')
        .get('offer_cancel');

    const fills = db
        .prepare(
            `SELECT pairKey, side, fillPrice, fillSizeBase, slippageBpsVsMid, spreadPaidBps, edgeBpsVsMid, netEdgeBpsVsMid, txFeeXrp
             FROM trade_events
             WHERE action = 'fill'`
        )
        .all();

    const slippageVsMid = [];
    const spreadPaid = [];
    const edgeVsMid = [];
    const netEdgeVsMid = [];
    const feeBps = [];

    for (const fill of fills) {
        if (fill.slippageBpsVsMid != null) slippageVsMid.push(fill.slippageBpsVsMid);
        if (fill.spreadPaidBps != null) spreadPaid.push(fill.spreadPaidBps);
        if (fill.edgeBpsVsMid != null) edgeVsMid.push(fill.edgeBpsVsMid);
        if (fill.netEdgeBpsVsMid != null) netEdgeVsMid.push(fill.netEdgeBpsVsMid);

        if (fill.txFeeXrp != null && fill.fillSizeBase != null && fill.fillSizeBase > 0) {
            const isXrpBase = typeof fill.pairKey === 'string' && fill.pairKey.startsWith('XRP/');
            if (isXrpBase) {
                feeBps.push((fill.txFeeXrp / fill.fillSizeBase) * 10000);
            }
        }
    }

    return {
        offerCreateFee: { avgFee: offerCreateFee?.avgFee ?? null, count: offerCreateFee?.count ?? 0 },
        offerCancelFee: { avgFee: offerCancelFee?.avgFee ?? null, count: offerCancelFee?.count ?? 0 },
        avgSlippageVsMid: safeAvg(slippageVsMid),
        avgSpreadPaid: safeAvg(spreadPaid),
        avgEdgeVsMid: safeAvg(edgeVsMid),
        avgNetEdgeVsMid: safeAvg(netEdgeVsMid),
        avgFeeBps: safeAvg(feeBps),
        fillCount: fills.length,
        feeBpsCount: feeBps.length,
    };
}

function main() {
    const tradeHistoryPath = path.resolve(process.cwd(), 'trade_history.json');
    const feedbackDbPath = process.env.FEEDBACK_DB_PATH
        ? path.resolve(process.cwd(), process.env.FEEDBACK_DB_PATH)
        : path.resolve(process.cwd(), 'data', 'feedback.sqlite');

    const tradeHistory = loadTradeHistory(tradeHistoryPath);
    const tradeSummary = summarizeTradeHistory(tradeHistory);
    const db = loadFeedbackDb(feedbackDbPath);
    const dbSummary = summarizeFeedbackDb(db);

    if (db) db.close();

    console.log('=== XRPL Trading Bot Cost Audit ===');
    console.log(`Trade history path: ${tradeHistoryPath}`);
    console.log(`Feedback DB path:   ${feedbackDbPath} (${dbSummary ? 'loaded' : 'missing'})`);
    console.log('');

    if (dbSummary) {
        console.log('Offer fees (from feedback DB):');
        console.log(`  OfferCreate avg fee: ${formatXrp(dbSummary.offerCreateFee.avgFee)} (${dbSummary.offerCreateFee.count} samples)`);
        console.log(`  OfferCancel avg fee: ${formatXrp(dbSummary.offerCancelFee.avgFee)} (${dbSummary.offerCancelFee.count} samples)`);
        console.log('');

        console.log('Execution cost (fills):');
        console.log(`  Avg slippage vs mid: ${formatBps(dbSummary.avgSlippageVsMid)} (${dbSummary.fillCount} fills)`);
        console.log(`  Avg spread paid:     ${formatBps(dbSummary.avgSpreadPaid)}`);
        console.log(`  Avg edge vs mid:     ${formatBps(dbSummary.avgEdgeVsMid)}`);
        console.log(`  Avg net edge vs mid: ${formatBps(dbSummary.avgNetEdgeVsMid)}`);
        console.log(`  Avg fee (bps):       ${formatBps(dbSummary.avgFeeBps)} (${dbSummary.feeBpsCount} fills)`);
        console.log('');
    }

    console.log('Trade history (fallback):');
    console.log(`  Filled trades:   ${tradeSummary.filledCount}`);
    console.log(`  Rejected trades: ${tradeSummary.rejectedCount}`);
    console.log(`  Avg fee:         ${formatXrp(tradeSummary.avgFee)}`);
    console.log(`  Avg slippage:    ${formatBps(tradeSummary.avgSlippageBps)}`);
    console.log(`  Avg fee (bps):   ${formatBps(tradeSummary.avgFeeBps)}`);
    console.log(`  Rejection rate:  ${tradeSummary.rejectionRate == null ? 'n/a' : (tradeSummary.rejectionRate * 100).toFixed(2) + '%'}`);
    console.log('');

    let minSpreadBps = null;
    let realizedEdgeBps = null;

    if (dbSummary && dbSummary.avgSpreadPaid != null) {
        const slippage = dbSummary.avgSlippageVsMid ?? 0;
        const feeBps = dbSummary.avgFeeBps ?? 0;
        minSpreadBps = Math.max(0, dbSummary.avgSpreadPaid + slippage + feeBps);
        if (dbSummary.avgNetEdgeVsMid != null) {
            realizedEdgeBps = dbSummary.avgNetEdgeVsMid - feeBps;
        }
    } else if (tradeSummary.avgSlippageBps != null || tradeSummary.avgFeeBps != null) {
        const slippage = tradeSummary.avgSlippageBps ?? 0;
        const feeBps = tradeSummary.avgFeeBps ?? 0;
        minSpreadBps = Math.max(0, slippage + feeBps);
    }

    console.log('Derived metrics:');
    console.log(`  Estimated minimum profitable spread: ${formatBps(minSpreadBps)}`);
    console.log(`  Avg realized edge per trade:         ${formatBps(realizedEdgeBps)}`);
}

main();
