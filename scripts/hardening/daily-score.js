#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseArgs, utcDateKey, ensureDir, readJson, writeJson, toNumber } = require('./common');

function usage() {
    console.log([
        'Usage: node scripts/hardening/daily-score.js [options]',
        '',
        'Options:',
        '  --date YYYY-MM-DD              Date key (default: today UTC)',
        '  --inputDir <path>              Root input dir (default: data/hardening)',
        '  --manualFile <path>            Manual metrics file override',
        '  --outputFile <path>            Output score file override',
    ].join('\n'));
}

function loadScenarioResults(dayDir) {
    if (!fs.existsSync(dayDir)) return [];
    return fs.readdirSync(dayDir)
        .filter((name) => name.endsWith('.json') && /^S[1-6]-/.test(name))
        .map((name) => readJson(path.join(dayDir, name), null))
        .filter(Boolean);
}

function createManualTemplate(filePath) {
    const template = {
        replayDivergenceCount: null,
        missingTerminalTransitions: null,
        duplicateTerminalTransitions: null,
        boundaryMisclassificationRate: null,
        persistentDriftIncidents: null,
        reconcileConvergenceCyclesP95: null,
        killSwitchTriggerLedgersP95: null,
        staleFeedFalseNegatives: null,
        restartRecoveryMsP95: null,
        stateRebuildMsP95: null,
        unresolvedTier3Plus: false,
        tier4Or5Today: false,
        tier4Or5Last7d: false,
        unmatchedLedgerTxState72h: null,
        submitToInclusionLedgersP95: null,
    };
    writeJson(filePath, template);
    return template;
}

function clampScore(value) {
    return Math.max(0, Math.min(20, Math.round(value * 10) / 10));
}

function buildScores(inputs) {
    const {
        scenarioResults,
        manual,
        health,
    } = inputs;

    const aggregated = scenarioResults.reduce((acc, r) => {
        const ev = r.eventCounts || {};
        Object.keys(ev).forEach((k) => {
            acc[k] = (acc[k] || 0) + (Number(ev[k]) || 0);
        });
        acc.totalRuns += 1;
        if (!r.pass) acc.failedRuns += 1;
        if (r.observed?.truncated) acc.truncatedRuns += 1;
        if (!r.fetchStatus?.healthOk || !r.fetchStatus?.runtimeOk || !r.fetchStatus?.eventsOk) acc.fetchErrorRuns += 1;
        return acc;
    }, { totalRuns: 0, failedRuns: 0, truncatedRuns: 0, fetchErrorRuns: 0 });

    const submitAttempts = aggregated.SUBMIT_ATTEMPT || 0;
    const submitFails = aggregated.SUBMIT_FAIL || 0;
    const submitFailRate = submitAttempts > 0 ? submitFails / submitAttempts : 0;

    let dataIntegrity = 20;
    if (aggregated.fetchErrorRuns > 0) dataIntegrity -= Math.min(8, aggregated.fetchErrorRuns * 2);
    if (aggregated.truncatedRuns > 0) dataIntegrity -= Math.min(4, aggregated.truncatedRuns);
    if (toNumber(manual.replayDivergenceCount, 0) > 0) dataIntegrity -= 8;
    if (toNumber(manual.missingTerminalTransitions, 0) > 0) dataIntegrity -= 6;
    if (toNumber(manual.duplicateTerminalTransitions, 0) > 0) dataIntegrity -= 6;
    dataIntegrity = clampScore(dataIntegrity);

    let executionDeterminism = 20;
    if (submitFailRate > 0.10) executionDeterminism -= 6;
    if (submitFailRate > 0.25) executionDeterminism -= 6;
    const boundaryRate = toNumber(manual.boundaryMisclassificationRate, 0);
    if (boundaryRate > 0.001) executionDeterminism -= 4;
    if (boundaryRate > 0.01) executionDeterminism -= 4;
    executionDeterminism = clampScore(executionDeterminism);

    let reconciliationReliability = 20;
    const drift = toNumber(manual.persistentDriftIncidents, 0);
    if (drift > 0) reconciliationReliability -= Math.min(10, drift * 2);
    const convergeP95 = toNumber(manual.reconcileConvergenceCyclesP95, 0);
    if (convergeP95 > 2) reconciliationReliability -= 6;
    if (toNumber(manual.unmatchedLedgerTxState72h, 0) > 0) reconciliationReliability -= 8;
    reconciliationReliability = clampScore(reconciliationReliability);

    let riskEnforcementTiming = 20;
    const killSwitchLedgers = toNumber(manual.killSwitchTriggerLedgersP95, 0);
    if (killSwitchLedgers > 1) riskEnforcementTiming -= 6;
    if (killSwitchLedgers > 2) riskEnforcementTiming -= 6;
    if (toNumber(manual.staleFeedFalseNegatives, 0) > 0) riskEnforcementTiming -= 8;
    riskEnforcementTiming = clampScore(riskEnforcementTiming);

    let operationalStability = 20;
    const restartP95 = toNumber(manual.restartRecoveryMsP95, 0);
    const rebuildP95 = toNumber(manual.stateRebuildMsP95, 0);
    if (restartP95 > 120000) operationalStability -= 5;
    if (rebuildP95 > 120000) operationalStability -= 5;
    if (aggregated.failedRuns > 0) operationalStability -= Math.min(6, aggregated.failedRuns);
    if (!health?.uptime?.processRunning) operationalStability -= 6;
    operationalStability = clampScore(operationalStability);

    const total = Math.round((dataIntegrity + executionDeterminism + reconciliationReliability + riskEnforcementTiming + operationalStability) * 10) / 10;

    return {
        categories: {
            dataIntegrity,
            executionDeterminism,
            reconciliationReliability,
            riskEnforcementTiming,
            operationalStability,
        },
        total,
        diagnostics: {
            scenarioRuns: aggregated.totalRuns,
            failedRuns: aggregated.failedRuns,
            truncatedRuns: aggregated.truncatedRuns,
            fetchErrorRuns: aggregated.fetchErrorRuns,
            submitAttempts,
            submitFails,
            submitFailRate,
        },
    };
}

function runDailyHealthCheck() {
    try {
        const raw = execSync('node scripts/daily-health-check.js --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(raw);
    } catch {
        return { uptime: { processRunning: false }, warning: 'daily-health-check unavailable' };
    }
}

function main() {
    const args = parseArgs();
    if (args.help || args.h) {
        usage();
        process.exit(0);
    }

    const dateKey = String(args.date || utcDateKey());
    const inputRoot = path.resolve(process.cwd(), String(args.inputDir || path.join('data', 'hardening')));
    const dayDir = path.join(inputRoot, dateKey);
    ensureDir(dayDir);

    const scenarioResults = loadScenarioResults(dayDir);
    const manualFile = path.resolve(process.cwd(), String(args.manualFile || path.join(dayDir, 'manual-metrics.json')));
    let manual = readJson(manualFile, null);
    let manualTemplateCreated = false;
    if (!manual) {
        manual = createManualTemplate(manualFile);
        manualTemplateCreated = true;
    }

    const health = runDailyHealthCheck();
    const score = buildScores({ scenarioResults, manual, health });

    const outputFile = path.resolve(process.cwd(), String(args.outputFile || path.join(dayDir, 'daily-score.json')));
    const output = {
        schemaVersion: 1,
        date: dateKey,
        generatedAt: new Date().toISOString(),
        manualTemplateCreated,
        files: {
            dayDir,
            manualFile,
            outputFile,
        },
        score,
        hardStops: {
            unresolvedTier3Plus: Boolean(manual.unresolvedTier3Plus),
            tier4Or5Today: Boolean(manual.tier4Or5Today),
            tier4Or5Last7d: Boolean(manual.tier4Or5Last7d),
        },
        context: {
            scenarioCount: scenarioResults.length,
            dailyHealth: health,
        },
    };

    writeJson(outputFile, output);

    console.log(`[daily-score] date=${dateKey}`);
    console.log(`[daily-score] total=${score.total}/100`);
    console.log(`[daily-score] categories=${JSON.stringify(score.categories)}`);
    console.log(`[daily-score] wrote ${path.relative(process.cwd(), outputFile)}`);
    if (manualTemplateCreated) {
        console.log(`[daily-score] created manual metrics template: ${path.relative(process.cwd(), manualFile)}`);
        console.log('[daily-score] fill manual metrics before using gate decisions.');
    }
}

main();
