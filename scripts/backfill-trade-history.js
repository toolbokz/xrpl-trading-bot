#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const EPS = 1e-9;

function parseArgs(argv) {
    const args = {
        write: false,
        file: path.resolve(process.cwd(), 'trade_history.json'),
    };
    for (let i = 2; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--write') {
            args.write = true;
            continue;
        }
        if (token === '--file' && argv[i + 1]) {
            args.file = path.resolve(process.cwd(), argv[i + 1]);
            i++;
        }
    }
    return args;
}

function asFinite(value, fallback = 0) {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function asPos(value, fallback = 0) {
    const num = asFinite(value, fallback);
    return num > 0 ? num : fallback;
}

function maybePos(value) {
    const num = asFinite(value, 0);
    return num > 0 ? num : null;
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

function isFillLikeStatus(status) {
    return status === 'FILLED' || status === 'PARTIAL';
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildTypicalPriceByPair(records) {
    const map = new Map();
    for (const rec of records) {
        const pair = canonicalizePairKey(rec.pair);
        if (!pair) continue;
        const side = String(rec.side ?? '').toUpperCase();
        const status = String(rec.status ?? '').toUpperCase();
        if (!isFillLikeStatus(status)) continue;
        const p = asPos(rec.price, 0);
        if (p <= 0) continue;
        if (!map.has(pair)) map.set(pair, []);
        if (side === 'BUY') map.get(pair).push(p);
    }

    // fallback to any fill prices if no BUY references available
    for (const rec of records) {
        const pair = canonicalizePairKey(rec.pair);
        if (!pair || map.get(pair)?.length) continue;
        const status = String(rec.status ?? '').toUpperCase();
        if (!isFillLikeStatus(status)) continue;
        const p = asPos(rec.price, 0);
        if (p <= 0) continue;
        if (!map.has(pair)) map.set(pair, []);
        map.get(pair).push(p);
    }

    const out = new Map();
    for (const [pair, prices] of map.entries()) {
        const m = median(prices.filter((v) => v > 0));
        if (m != null) out.set(pair, m);
    }
    return out;
}

function snapshotRecord(rec) {
    return {
        pair: rec.pair,
        side: rec.side,
        status: rec.status,
        price: rec.price,
        amount: rec.amount,
        filled: rec.filled,
        amountBase: rec.amountBase,
        filledBase: rec.filledBase,
        filledQuote: rec.filledQuote,
        priceQuotePerBase: rec.priceQuotePerBase,
        source: rec.source,
    };
}

function sanitizeRecord(raw) {
    const rec = { ...raw };
    rec.side = String(rec.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    rec.status = ['FILLED', 'PARTIAL', 'REJECTED', 'PENDING'].includes(String(rec.status ?? '').toUpperCase())
        ? String(rec.status).toUpperCase()
        : 'PENDING';
    rec.source = rec.source === 'manual' ? 'manual' : 'bot';
    return rec;
}

function repairRecord(raw, typicalByPair) {
    const original = sanitizeRecord(raw);
    const repaired = { ...original };
    const repairFlags = [];
    const pairOriginal = String(original.pair ?? '');
    const canonicalPair = canonicalizePairKey(pairOriginal);
    repaired.pairOriginal = pairOriginal;
    repaired.pair = canonicalPair;

    let priceQuotePerBase = asPos(repaired.priceQuotePerBase ?? repaired.price, 0);
    const amountBase = asPos(repaired.amountBase ?? repaired.amount, 0);
    let filledBase = asPos(repaired.filledBase ?? repaired.filled, 0);
    let filledQuote = asPos(repaired.filledQuote, 0);

    const refs = [
        maybePos(repaired.intentPrice),
        maybePos(repaired.expectedPrice),
        maybePos(repaired.entryPrice),
        maybePos(repaired.midPriceAtDecision),
    ].filter((v) => v != null);

    let invertedByReference = false;
    if (repaired.side === 'SELL' && isFillLikeStatus(repaired.status) && priceQuotePerBase > 0) {
        invertedByReference = refs.some((ref) => Math.abs((ref * priceQuotePerBase) - 1) < 0.02);
    }
    const typical = typicalByPair.get(canonicalPair) ?? null;
    const invertedByTypical = repaired.side === 'SELL'
        && isFillLikeStatus(repaired.status)
        && canonicalPair === 'XRP/RLUSD'
        && priceQuotePerBase > 0
        && priceQuotePerBase < 1
        && (typical != null && typical > 1.05);

    if (invertedByReference || invertedByTypical) {
        priceQuotePerBase = priceQuotePerBase > 0 ? (1 / priceQuotePerBase) : 0;
        repairFlags.push('INVERTED_PRICE_FIXED');
    }

    // Legacy unit mix: SELL filled column storing quote amount.
    if (repaired.side === 'SELL' && isFillLikeStatus(repaired.status) && filledQuote <= 0 && amountBase > 0 && filledBase > amountBase + EPS) {
        filledQuote = filledBase;
        filledBase = priceQuotePerBase > 0 ? (filledQuote / priceQuotePerBase) : 0;
        repairFlags.push('UNIT_MIX_FIXED');
    }

    if (filledQuote <= 0 && filledBase > 0 && priceQuotePerBase > 0) {
        filledQuote = filledBase * priceQuotePerBase;
    }

    if (filledBase <= 0 && filledQuote > 0 && priceQuotePerBase > 0) {
        filledBase = filledQuote / priceQuotePerBase;
    }

    if (amountBase > 0 && filledBase > amountBase + EPS) {
        filledBase = amountBase;
        repairFlags.push('FILLED_BASE_CLAMPED');
    }

    if (repaired.status === 'PARTIAL' && amountBase > 0 && filledBase >= amountBase * 0.999) {
        repaired.status = 'FILLED';
        repairFlags.push('STATUS_PARTIAL_TO_FILLED');
    }

    repaired.price = priceQuotePerBase;
    repaired.priceQuotePerBase = priceQuotePerBase;
    repaired.amount = amountBase;
    repaired.amountBase = amountBase;
    repaired.filled = filledBase;
    repaired.filledBase = filledBase;
    repaired.filledQuote = filledQuote > 0 ? filledQuote : undefined;
    repaired.recordType = repaired.source === 'manual' ? 'MANUAL' : 'BOT';
    if (repairFlags.length > 0) {
        repaired.repairFlags = Array.from(new Set([...(repaired.repairFlags || []), ...repairFlags]));
    }

    return {
        original,
        repaired,
        repairFlags,
        changed: JSON.stringify(snapshotRecord(original)) !== JSON.stringify(snapshotRecord(repaired)),
    };
}

function statusPriority(status) {
    if (status === 'FILLED') return 3;
    if (status === 'REJECTED') return 2;
    if (status === 'PARTIAL') return 1;
    return 0;
}

function hasUnitIntegrity(record) {
    const amount = asPos(record.amountBase ?? record.amount, 0);
    const filled = asPos(record.filledBase ?? record.filled, 0);
    if (amount <= 0) return true;
    return filled <= amount + EPS;
}

function pickWinner(records) {
    return [...records].sort((a, b) => {
        const aTuple = [
            statusPriority(a.status),
            hasUnitIntegrity(a) ? 1 : 0,
            asPos(a.priceQuotePerBase ?? a.price, 0) > 0 ? 1 : 0,
            a.source === 'bot' ? 1 : 0,
            asFinite(a.timestamp, 0),
        ];
        const bTuple = [
            statusPriority(b.status),
            hasUnitIntegrity(b) ? 1 : 0,
            asPos(b.priceQuotePerBase ?? b.price, 0) > 0 ? 1 : 0,
            b.source === 'bot' ? 1 : 0,
            asFinite(b.timestamp, 0),
        ];

        for (let i = 0; i < aTuple.length; i++) {
            if (aTuple[i] !== bTuple[i]) return bTuple[i] - aTuple[i];
        }
        return 0;
    })[0];
}

function dedupeByHash(records) {
    const noHash = [];
    const byHash = new Map();
    for (const rec of records) {
        const hash = String(rec.hash ?? '').trim();
        if (!hash) {
            noHash.push(rec);
            continue;
        }
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash).push(rec);
    }

    const deduped = [...noHash];
    const dropped = [];

    for (const [hash, group] of byHash.entries()) {
        const manual = group.filter((r) => r.source === 'manual');
        const nonManual = group.filter((r) => r.source !== 'manual');

        if (manual.length > 0 && nonManual.length > 0) {
            const winner = pickWinner(nonManual);
            if (winner) deduped.push(winner);

            for (const rec of manual) {
                rec.recordType = 'MANUAL';
                rec.excludeFromAnalytics = true;
                deduped.push(rec);
            }

            for (const rec of group) {
                if (rec !== winner && !manual.includes(rec)) {
                    dropped.push({
                        hash,
                        droppedId: rec.id,
                        keptId: winner?.id ?? null,
                        reason: 'duplicate-hash-lower-priority',
                    });
                }
            }
            continue;
        }

        const winner = pickWinner(group);
        if (winner) deduped.push(winner);
        for (const rec of group) {
            if (rec !== winner) {
                dropped.push({
                    hash,
                    droppedId: rec.id,
                    keptId: winner?.id ?? null,
                    reason: 'duplicate-hash-lower-priority',
                });
            }
        }
    }

    deduped.sort((a, b) => asFinite(a.timestamp, 0) - asFinite(b.timestamp, 0));
    return { deduped, dropped };
}

function countReciprocalAnomalies(records, typicalByPair) {
    let count = 0;
    for (const rec of records) {
        const side = String(rec.side ?? '').toUpperCase();
        const status = String(rec.status ?? '').toUpperCase();
        if (side !== 'SELL' || !isFillLikeStatus(status)) continue;
        const price = asPos(rec.priceQuotePerBase ?? rec.price, 0);
        if (price <= 0) continue;

        const refs = [
            maybePos(rec.intentPrice),
            maybePos(rec.expectedPrice),
            maybePos(rec.entryPrice),
            maybePos(rec.midPriceAtDecision),
        ].filter((v) => v != null);
        if (refs.some((ref) => Math.abs((ref * price) - 1) < 0.02)) {
            count++;
            continue;
        }

        const pair = canonicalizePairKey(rec.pair);
        const typical = typicalByPair.get(pair);
        if (pair === 'XRP/RLUSD' && typical != null && typical > 1.05 && price < 1) {
            count++;
        }
    }
    return count;
}

function main() {
    const { write, file } = parseArgs(process.argv);
    if (!fs.existsSync(file)) {
        throw new Error(`trade history file not found: ${file}`);
    }

    const rawText = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) {
        throw new Error(`Expected JSON array in ${file}`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.dirname(file);
    const backupPath = path.join(dir, `trade_history.backup.${timestamp}.json`);
    const cleanedPath = path.join(dir, `trade_history.cleaned.${timestamp}.json`);
    const changesPath = path.join(dir, `trade_history.changes.${timestamp}.json`);

    fs.writeFileSync(backupPath, rawText, 'utf8');

    const typicalByPair = buildTypicalPriceByPair(parsed);
    const repairs = [];
    const cleanedPreDedupe = [];
    for (const row of parsed) {
        const { original, repaired, repairFlags, changed } = repairRecord(row, typicalByPair);
        cleanedPreDedupe.push(repaired);
        if (changed || repairFlags.length > 0) {
            repairs.push({
                id: original.id ?? null,
                hash: original.hash ?? null,
                pairOriginal: original.pair,
                pairCanonical: repaired.pair,
                repairFlags,
                before: snapshotRecord(original),
                after: snapshotRecord(repaired),
            });
        }
    }

    const { deduped, dropped } = dedupeByHash(cleanedPreDedupe);

    const pairCounts = {};
    for (const rec of deduped) {
        const pair = canonicalizePairKey(rec.pair);
        pairCounts[pair] = (pairCounts[pair] || 0) + 1;
    }

    const repairedInverted = repairs.filter((r) => r.repairFlags.includes('INVERTED_PRICE_FIXED')).length;
    const repairedUnitMix = repairs.filter((r) => r.repairFlags.includes('UNIT_MIX_FIXED')).length;
    const reciprocalAnomalies = countReciprocalAnomalies(deduped, typicalByPair);

    const changes = {
        generatedAt: new Date().toISOString(),
        sourceFile: file,
        backupFile: backupPath,
        cleanedFile: cleanedPath,
        writeApplied: write,
        summary: {
            inputRecords: parsed.length,
            outputRecords: deduped.length,
            invertedPriceFixes: repairedInverted,
            unitMixFixes: repairedUnitMix,
            statusFixes: repairs.filter((r) => r.repairFlags.includes('STATUS_PARTIAL_TO_FILLED')).length,
            duplicatesRemoved: dropped.length,
            remainingReciprocalAnomalies: reciprocalAnomalies,
            pairCounts,
        },
        droppedDuplicates: dropped,
        repairedRecords: repairs,
    };

    fs.writeFileSync(cleanedPath, `${JSON.stringify(deduped, null, 2)}\n`, 'utf8');
    fs.writeFileSync(changesPath, `${JSON.stringify(changes, null, 2)}\n`, 'utf8');

    if (write) {
        fs.writeFileSync(file, `${JSON.stringify(deduped, null, 2)}\n`, 'utf8');
    }

    console.log(JSON.stringify({
        sourceFile: file,
        backupFile: backupPath,
        cleanedFile: cleanedPath,
        changesFile: changesPath,
        writeApplied: write,
        ...changes.summary,
    }, null, 2));
}

main();
