#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    parseArgs,
    utcDateKey,
    nowIso,
    ensureDir,
    readJson,
    writeJson,
    toNumber,
} = require('./common');
const { SCENARIOS } = require('./scenarios');

function usage() {
    console.log([
        'Usage: node scripts/hardening/day.js [options]',
        '',
        'Runs shift orchestration: scenario set -> score -> gate -> handoff report.',
        '',
        'Options:',
        '  --date YYYY-MM-DD              Date key (default: today UTC)',
        '  --target <phase2|phase3|phase4|latency-capable>',
        '  --scenarios S1,S3,S5           Override default scenario set',
        '  --durationSec <n>              Per-scenario duration (default: 120)',
        '  --apiBase <url>                Runtime API base (default: http://127.0.0.1:3000)',
        '  --pairKey <XRP/RLUSD>          Optional pairKey filter passed to runner',
        '  --outputDir <path>             Output root (default: data/hardening)',
        '  --shift <label>                Shift label for handoff report',
        '  --continueOnFail <true|false>  Continue scenarios after a failed run (default: true)',
        '',
        'Examples:',
        '  node scripts/hardening/day.js --target phase2 --date 2026-03-01',
        '  node scripts/hardening/day.js --scenarios S3,S4 --durationSec 90 --shift night-A',
    ].join('\n'));
}

function listScenarioFiles(dayDir) {
    if (!fs.existsSync(dayDir)) return [];
    return fs.readdirSync(dayDir)
        .filter((name) => /^S[1-6]-.*\.json$/.test(name))
        .map((name) => path.join(dayDir, name));
}

function resolveScenarioSet(args) {
    if (typeof args.scenarios === 'string' && args.scenarios.trim().length > 0) {
        const list = args.scenarios
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
        const invalid = list.filter((id) => !SCENARIOS[id]);
        if (invalid.length > 0) {
            throw new Error(`Invalid scenario IDs: ${invalid.join(', ')}`);
        }
        return list;
    }

    const target = String(args.target || '').trim();
    if (target === 'phase2') return ['S3', 'S4'];
    if (target === 'phase3') return ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
    if (target === 'phase4') return ['S5', 'S3'];
    if (target === 'latency-capable') return ['S3', 'S5'];

    return ['S3'];
}

function toBoolFlag(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).toLowerCase().trim();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return fallback;
}

function spawnNode(scriptPath, scriptArgs) {
    return spawnSync('node', [scriptPath, ...scriptArgs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function latestFile(files) {
    if (!files.length) return null;
    return files
        .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].filePath;
}

function buildMarkdownReport(input) {
    const {
        generatedAt,
        date,
        shift,
        target,
        scenarioRuns,
        score,
        gate,
        reportJsonPath,
    } = input;

    const lines = [];
    lines.push('# Hardening Shift Handoff Report');
    lines.push('');
    lines.push(`- Generated At (UTC): ${generatedAt}`);
    lines.push(`- Date: ${date}`);
    lines.push(`- Shift: ${shift || 'unspecified'}`);
    lines.push(`- Gate Target: ${target || 'none'}`);
    lines.push(`- Report JSON: ${reportJsonPath}`);
    lines.push('');

    lines.push('## Scenario Runs');
    lines.push('');
    if (!scenarioRuns.length) {
        lines.push('- No scenarios executed.');
    } else {
        for (const run of scenarioRuns) {
            lines.push(`- ${run.id}: pass=${run.pass} exitCode=${run.exitCode} file=${run.outputFile || 'n/a'}`);
            if (run.notes && run.notes.length) {
                run.notes.forEach((n) => lines.push(`  - note: ${n}`));
            }
        }
    }
    lines.push('');

    lines.push('## Daily Score');
    lines.push('');
    if (!score) {
        lines.push('- Score unavailable.');
    } else {
        lines.push(`- Total: ${score.total}/100`);
        lines.push(`- DataIntegrity: ${score.categories.dataIntegrity}`);
        lines.push(`- ExecutionDeterminism: ${score.categories.executionDeterminism}`);
        lines.push(`- ReconciliationReliability: ${score.categories.reconciliationReliability}`);
        lines.push(`- RiskEnforcementTiming: ${score.categories.riskEnforcementTiming}`);
        lines.push(`- OperationalStability: ${score.categories.operationalStability}`);
    }
    lines.push('');

    lines.push('## Gate Decision');
    lines.push('');
    if (!gate || !gate.target) {
        lines.push('- Gate step skipped (no target specified).');
    } else {
        lines.push(`- Target: ${gate.target}`);
        lines.push(`- Pass: ${gate.pass}`);
        lines.push(`- Exit Code: ${gate.exitCode}`);
        if (gate.reasons.length) {
            lines.push('- Reasons:');
            gate.reasons.forEach((r) => lines.push(`  - ${r}`));
        }
    }

    return `${lines.join('\n')}\n`;
}

function main() {
    const args = parseArgs();
    if (args.help || args.h) {
        usage();
        process.exit(0);
    }

    const date = String(args.date || utcDateKey());
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const shift = typeof args.shift === 'string' ? args.shift.trim() : '';
    const durationSec = Math.max(30, toNumber(args.durationSec, 120));
    const apiBase = String(args.apiBase || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const pairKey = typeof args.pairKey === 'string' ? args.pairKey : '';
    const continueOnFail = toBoolFlag(args.continueOnFail, true);

    const outputRoot = path.resolve(process.cwd(), String(args.outputDir || path.join('data', 'hardening')));
    const dayDir = path.join(outputRoot, date);
    ensureDir(dayDir);

    const scenarios = resolveScenarioSet(args);

    console.log(`[hardening:day] date=${date} target=${target || 'none'} scenarios=${scenarios.join(',')}`);

    const runnerScript = path.resolve(process.cwd(), 'scripts', 'hardening', 'scenario-runner.js');
    const scoreScript = path.resolve(process.cwd(), 'scripts', 'hardening', 'daily-score.js');
    const gateScript = path.resolve(process.cwd(), 'scripts', 'hardening', 'gate.js');

    const scenarioRuns = [];

    for (const scenarioId of scenarios) {
        const beforeFiles = new Set(listScenarioFiles(dayDir));

        const runnerArgs = [
            '--scenario', scenarioId,
            '--durationSec', String(durationSec),
            '--apiBase', apiBase,
            '--outputDir', outputRoot,
        ];
        if (pairKey) {
            runnerArgs.push('--pairKey', pairKey);
        }

        const startedAt = nowIso();
        const proc = spawnNode(runnerScript, runnerArgs);
        const endedAt = nowIso();

        const afterFiles = listScenarioFiles(dayDir);
        const createdFiles = afterFiles.filter((f) => !beforeFiles.has(f));
        const outputFile = latestFile(createdFiles) || latestFile(afterFiles);
        const resultJson = outputFile ? readJson(outputFile, null) : null;

        const runSummary = {
            id: scenarioId,
            title: SCENARIOS[scenarioId]?.title || scenarioId,
            startedAt,
            endedAt,
            exitCode: Number.isInteger(proc.status) ? proc.status : 1,
            pass: Boolean(resultJson?.pass),
            outputFile: outputFile ? path.relative(process.cwd(), outputFile) : null,
            notes: resultJson?.notes || [],
            stdout: (proc.stdout || '').trim(),
            stderr: (proc.stderr || '').trim(),
        };

        scenarioRuns.push(runSummary);

        console.log(`[hardening:day] scenario ${scenarioId} exitCode=${runSummary.exitCode} pass=${runSummary.pass}`);

        if (runSummary.exitCode !== 0 && !continueOnFail) {
            console.log('[hardening:day] stopping scenario set due to failure and continueOnFail=false');
            break;
        }
    }

    const scoreProc = spawnNode(scoreScript, ['--date', date, '--inputDir', outputRoot]);
    const scoreFile = path.join(dayDir, 'daily-score.json');
    const scorePayload = readJson(scoreFile, null);

    const score = scorePayload?.score
        ? {
            total: scorePayload.score.total,
            categories: scorePayload.score.categories,
            diagnostics: scorePayload.score.diagnostics,
        }
        : null;

    let gate = {
        target: target || null,
        executed: false,
        pass: null,
        exitCode: null,
        reasons: [],
        stdout: '',
        stderr: '',
    };

    if (target) {
        const gateProc = spawnNode(gateScript, ['--target', target, '--date', date, '--scoreFile', scoreFile]);
        const text = `${gateProc.stdout || ''}\n${gateProc.stderr || ''}`;
        const reasonLines = text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('- '))
            .map((line) => line.replace(/^-\s*/, ''));

        gate = {
            target,
            executed: true,
            pass: (gateProc.status === 0),
            exitCode: gateProc.status,
            reasons: reasonLines,
            stdout: (gateProc.stdout || '').trim(),
            stderr: (gateProc.stderr || '').trim(),
        };
    }

    const anyScenarioFailed = scenarioRuns.some((r) => !r.pass || r.exitCode !== 0);
    const scoreAvailable = Boolean(score);
    const overallPass = target
        ? (!anyScenarioFailed && scoreAvailable && gate.executed && gate.pass === true)
        : (!anyScenarioFailed && scoreAvailable);

    const generatedAt = nowIso();
    const report = {
        schemaVersion: 1,
        generatedAt,
        date,
        shift: shift || null,
        target: target || null,
        config: {
            durationSec,
            apiBase,
            pairKey: pairKey || null,
            outputRoot: path.relative(process.cwd(), outputRoot),
            continueOnFail,
        },
        scenariosRequested: scenarios,
        scenarioRuns,
        scoreFile: path.relative(process.cwd(), scoreFile),
        score,
        gate,
        summary: {
            scenarioCount: scenarioRuns.length,
            scenarioFailures: scenarioRuns.filter((r) => !r.pass || r.exitCode !== 0).length,
            overallPass,
        },
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportJsonPathAbs = path.join(dayDir, `handoff-${stamp}.json`);
    writeJson(reportJsonPathAbs, report);

    const reportMdPathAbs = path.join(dayDir, `handoff-${stamp}.md`);
    const reportMd = buildMarkdownReport({
        generatedAt,
        date,
        shift,
        target,
        scenarioRuns,
        score,
        gate,
        reportJsonPath: path.relative(process.cwd(), reportJsonPathAbs),
    });
    fs.writeFileSync(reportMdPathAbs, reportMd, 'utf8');

    console.log(`[hardening:day] score total=${score?.total ?? 'n/a'}`);
    if (target) console.log(`[hardening:day] gate pass=${gate.pass}`);
    console.log(`[hardening:day] report json: ${path.relative(process.cwd(), reportJsonPathAbs)}`);
    console.log(`[hardening:day] report md:   ${path.relative(process.cwd(), reportMdPathAbs)}`);
    console.log(`[hardening:day] overallPass=${overallPass}`);

    process.exit(overallPass ? 0 : 2);
}

try {
    main();
} catch (err) {
    console.error('[hardening:day] fatal:', err?.message || err);
    process.exit(1);
}
