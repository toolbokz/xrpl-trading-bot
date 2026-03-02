#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const {
    parseArgs,
    nowIso,
    utcDateKey,
    ensureDir,
    writeJson,
    fetchJson,
    sleep,
    runCommand,
    toNumber,
} = require('./common');
const { SCENARIOS, TRACKED_EVENT_TYPES } = require('./scenarios');

function usage() {
    console.log([
        'Usage: node scripts/hardening/scenario-runner.js --scenario S1 [options]',
        '',
        'Options:',
        '  --scenario <S1..S6>          Scenario card ID (required)',
        '  --durationSec <n>            Observation window seconds (default: 300)',
        '  --apiBase <url>              Runtime API base (default: http://127.0.0.1:3000)',
        '  --pairKey <XRP/RLUSD>        Optional pairKey filter for events',
        '  --inject-command "<cmd>"     Optional command run after warmup',
        '  --inject-at-sec <n>          Injection timing offset (default: 10)',
        '  --outputDir <path>           Output root (default: data/hardening)',
    ].join('\n'));
}

async function getBusSeq(apiBase) {
    const res = await fetchJson(`${apiBase}/api/runtime/events?limit=1`);
    const seq = res?.data?.seq;
    return Number.isFinite(seq) ? seq : 0;
}

function summarizeEvents(events) {
    const counts = Object.fromEntries(TRACKED_EVENT_TYPES.map((t) => [t, 0]));
    for (const ev of events || []) {
        if (!ev || typeof ev !== 'object') continue;
        const t = ev.eventType;
        if (typeof t === 'string' && Object.prototype.hasOwnProperty.call(counts, t)) {
            counts[t] += 1;
        }
    }
    return counts;
}

function evaluateChecks(eventCounts, healthOk) {
    const submitAttempts = eventCounts.SUBMIT_ATTEMPT || 0;
    const submitFails = eventCounts.SUBMIT_FAIL || 0;
    const submitFailRate = submitAttempts > 0 ? submitFails / submitAttempts : 0;

    return {
        healthOk,
        submitAttempts,
        submitFailRate,
        reconnectEvents: eventCounts.XRPL_RECONNECTED || 0,
        disconnectEvents: eventCounts.XRPL_DISCONNECTED || 0,
        riskBlocks: eventCounts.RISK_BLOCK || 0,
        feedStaleEvents: eventCounts.FEED_STALE || 0,
    };
}

async function main() {
    const args = parseArgs();
    if (args.help || args.h) {
        usage();
        process.exit(0);
    }

    const scenarioId = String(args.scenario || '').toUpperCase();
    if (!scenarioId || !SCENARIOS[scenarioId]) {
        usage();
        console.error('\nError: --scenario must be one of', Object.keys(SCENARIOS).join(', '));
        process.exit(1);
    }

    const scenario = SCENARIOS[scenarioId];
    const durationSec = Math.max(30, toNumber(args.durationSec, 300));
    const injectAtSec = Math.max(1, toNumber(args['inject-at-sec'], 10));
    const apiBase = String(args.apiBase || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const pairKey = typeof args.pairKey === 'string' ? args.pairKey : '';
    const injectCommand = typeof args['inject-command'] === 'string' ? args['inject-command'] : '';

    const dateKey = utcDateKey();
    const outputRoot = path.resolve(process.cwd(), String(args.outputDir || path.join('data', 'hardening')));
    const outputDir = path.join(outputRoot, dateKey);
    ensureDir(outputDir);

    const startedAtMs = Date.now();
    const startedAtIso = nowIso();

    console.log(`\n[scenario-runner] Starting ${scenario.id}: ${scenario.title}`);
    console.log(`[scenario-runner] Objective: ${scenario.objective}`);
    console.log(`[scenario-runner] Recommended injection: ${scenario.recommendedInjection}`);
    if (!injectCommand) {
        console.log('[scenario-runner] No --inject-command provided; running observe-only capture.');
    }

    const seqStart = await getBusSeq(apiBase);

    if (injectCommand) {
        await sleep(injectAtSec * 1000);
        console.log(`[scenario-runner] Running injection command at +${injectAtSec}s`);
        const cmdRes = runCommand(injectCommand);
        if (!cmdRes.ok) {
            console.warn('[scenario-runner] Injection command failed:', cmdRes.stderr || cmdRes.stdout || 'unknown');
        }
    }

    const elapsedMs = Date.now() - startedAtMs;
    const remainingMs = Math.max(0, (durationSec * 1000) - elapsedMs);
    if (remainingMs > 0) await sleep(remainingMs);

    const endedAtMs = Date.now();
    const endedAtIso = nowIso();

    const healthRes = await fetchJson(`${apiBase}/api/health`);
    const runtimeRes = await fetchJson(`${apiBase}/api/metrics/runtime`);
    const balancesRes = await fetchJson(`${apiBase}/api/runtime/balances`);

    let eventsUrl = `${apiBase}/api/runtime/events?afterSeq=${seqStart}&limit=500`;
    if (pairKey) eventsUrl += `&pairKey=${encodeURIComponent(pairKey)}`;
    const eventsRes = await fetchJson(eventsUrl);
    const events = Array.isArray(eventsRes?.data?.events) ? eventsRes.data.events : [];

    const eventCounts = summarizeEvents(events);
    const checks = evaluateChecks(eventCounts, Boolean(healthRes.ok));

    const observed = {
        eventCount: events.length,
        truncated: events.length >= 500,
        runtimeState: runtimeRes?.data?.meta?.runtimeState ?? runtimeRes?.data?.runtimeState ?? null,
        executionAllowed: runtimeRes?.data?.meta?.executionAllowed ?? runtimeRes?.data?.executionAllowed ?? null,
        pairKey: runtimeRes?.data?.meta?.pairKey ?? runtimeRes?.data?.pairKey ?? null,
    };

    const pass = checks.healthOk && checks.submitFailRate <= 0.25 && (!observed.truncated);

    const result = {
        schemaVersion: 1,
        scenario,
        startedAtIso,
        endedAtIso,
        startedAtMs,
        endedAtMs,
        durationSec,
        apiBase,
        pairKey: pairKey || null,
        inputs: {
            injectCommand: injectCommand || null,
            injectAtSec,
            seqStart,
        },
        fetchStatus: {
            healthOk: healthRes.ok,
            runtimeOk: runtimeRes.ok,
            balancesOk: balancesRes.ok,
            eventsOk: eventsRes.ok,
        },
        eventCounts,
        checks,
        observed,
        pass,
        notes: observed.truncated
            ? ['Event buffer truncated at 500; rerun with shorter duration or add polling aggregator.']
            : [],
    };

    const timestamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(outputDir, `${scenario.id}-${timestamp}.json`);
    writeJson(outputFile, result);

    console.log(`[scenario-runner] Completed. pass=${pass ? 'true' : 'false'}`);
    console.log(`[scenario-runner] Wrote result: ${path.relative(process.cwd(), outputFile)}`);

    process.exit(pass ? 0 : 2);
}

main().catch((err) => {
    console.error('[scenario-runner] Fatal error:', err?.message || err);
    process.exit(1);
});
