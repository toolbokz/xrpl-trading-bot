#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const { parseArgs, utcDateKey, readJson } = require('./common');

function usage() {
    console.log([
        'Usage: node scripts/hardening/gate.js --target <phase2|phase3|phase4|latency-capable> [options]',
        '',
        'Options:',
        '  --target <name>               Gate target (required)',
        '  --date YYYY-MM-DD             Date key for default score file',
        '  --scoreFile <path>            Explicit score file path',
    ].join('\n'));
}

function evaluateGate(target, payload) {
    const score = payload?.score;
    const cat = score?.categories || {};
    const total = Number(score?.total || 0);
    const hard = payload?.hardStops || {};
    const manual = payload?.context?.manualMetrics || {};
    const reasons = [];

    if (hard.unresolvedTier3Plus) reasons.push('unresolved Tier 3+ incidents present');
    if (hard.tier4Or5Today) reasons.push('Tier 4/5 incident occurred today');

    const noCategoryBelow16 = ['dataIntegrity', 'executionDeterminism', 'reconciliationReliability', 'riskEnforcementTiming', 'operationalStability']
        .every((k) => Number(cat[k] || 0) >= 16);

    switch (target) {
        case 'phase2': // Phase 1 -> 2
            if (total < 72) reasons.push('total score below 72');
            if (Number(cat.dataIntegrity || 0) < 16) reasons.push('dataIntegrity below 16');
            break;
        case 'phase3': // Phase 2 -> 3
            if (total < 78) reasons.push('total score below 78');
            if (Number(cat.executionDeterminism || 0) < 16) reasons.push('executionDeterminism below 16');
            if (Number(cat.reconciliationReliability || 0) < 16) reasons.push('reconciliationReliability below 16');
            break;
        case 'phase4': // Phase 3 -> 4
            if (total < 84) reasons.push('total score below 84');
            if (Number(cat.riskEnforcementTiming || 0) < 17) reasons.push('riskEnforcementTiming below 17');
            break;
        case 'latency-capable': // Exit Phase 4
            if (total < 88) reasons.push('total score below 88');
            if (!noCategoryBelow16) reasons.push('one or more categories below 16');
            if (hard.tier4Or5Last7d) reasons.push('Tier 4/5 occurred in last 7 days');
            if (Number(manual.unmatchedLedgerTxState72h || 0) > 0) reasons.push('unmatched ledger tx/state in last 72h');
            if (Number(manual.submitToInclusionLedgersP95 || 999) > 2) reasons.push('submit-to-inclusion p95 > 2 ledgers');
            break;
        default:
            reasons.push(`unsupported target: ${target}`);
    }

    return {
        pass: reasons.length === 0,
        reasons,
        total,
        categories: cat,
    };
}

function main() {
    const args = parseArgs();
    if (args.help || args.h) {
        usage();
        process.exit(0);
    }

    const target = String(args.target || '').trim();
    if (!target) {
        usage();
        console.error('\nError: --target is required');
        process.exit(1);
    }

    const dateKey = String(args.date || utcDateKey());
    const defaultScoreFile = path.resolve(process.cwd(), 'data', 'hardening', dateKey, 'daily-score.json');
    const scoreFile = path.resolve(process.cwd(), String(args.scoreFile || defaultScoreFile));

    const payload = readJson(scoreFile, null);
    if (!payload) {
        console.error(`[gate] score file not found or invalid: ${scoreFile}`);
        process.exit(1);
    }

    // attach manual metrics for strict checks
    const manualFile = payload?.files?.manualFile;
    if (manualFile) {
        payload.context = payload.context || {};
        payload.context.manualMetrics = readJson(manualFile, {});
    }

    const result = evaluateGate(target, payload);

    console.log(`[gate] target=${target}`);
    console.log(`[gate] score=${result.total}/100`);
    console.log(`[gate] pass=${result.pass}`);
    if (!result.pass) {
        console.log('[gate] reasons:');
        result.reasons.forEach((r) => console.log(` - ${r}`));
        process.exit(2);
    }
}

main();
