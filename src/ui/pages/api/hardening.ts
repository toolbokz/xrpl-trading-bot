import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../lib/localApi';
import { withApiRouteContext } from '../../lib/localApi/withApiRouteContext';
import fs from 'fs';
import path from 'path';

/* ── Phase / day mapping from the 30-day runbook ── */

interface DayMeta {
    day: number;
    phase: number;
    label: string;
    scenarios: string[];
    isGateDay: boolean;
    gateTarget: string | null;
}

const RUNBOOK_DAYS: DayMeta[] = [
    // Phase 1: Observability & Determinism (Days 1-7)
    { day: 1, phase: 1, label: 'Event determinism baseline', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 2, phase: 1, label: 'Timestamp chain integrity', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 3, phase: 1, label: 'Replay determinism', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 4, phase: 1, label: 'Duplicate input resilience', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 5, phase: 1, label: 'Kill-switch timing (dry-run)', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 6, phase: 1, label: 'Restart parity', scenarios: ['S5'], isGateDay: false, gateTarget: null },
    { day: 7, phase: 1, label: 'Gate review → Phase 2', scenarios: [], isGateDay: true, gateTarget: 'phase2' },
    // Phase 2: Execution & Reconciliation Stress (Days 8-15)
    { day: 8, phase: 2, label: 'Simulated execution activation', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 9, phase: 2, label: 'Burst throughput', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 10, phase: 2, label: 'Burst fill reconciliation', scenarios: ['S1'], isGateDay: false, gateTarget: null },
    { day: 11, phase: 2, label: 'Cancel/replace race', scenarios: ['S2'], isGateDay: false, gateTarget: null },
    { day: 12, phase: 2, label: 'Boundary jitter', scenarios: ['S3'], isGateDay: false, gateTarget: null },
    { day: 13, phase: 2, label: 'Close variance spikes', scenarios: ['S4'], isGateDay: false, gateTarget: null },
    { day: 14, phase: 2, label: 'Combined stress', scenarios: ['S1', 'S2', 'S3', 'S4', 'S5'], isGateDay: false, gateTarget: null },
    { day: 15, phase: 2, label: 'Gate review → Phase 3', scenarios: [], isGateDay: true, gateTarget: 'phase3' },
    // Phase 3: XRPL Edge Case Simulation (Days 16-23)
    { day: 16, phase: 3, label: 'S1 partial fill bursts', scenarios: ['S1'], isGateDay: false, gateTarget: null },
    { day: 17, phase: 3, label: 'S2 cancel/replace collision', scenarios: ['S2'], isGateDay: false, gateTarget: null },
    { day: 18, phase: 3, label: 'Deterministic finality', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 19, phase: 3, label: 'Sequence continuity', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 20, phase: 3, label: 'S5 restart during exposure', scenarios: ['S5'], isGateDay: false, gateTarget: null },
    { day: 21, phase: 3, label: 'S6 volatility convergence', scenarios: ['S6'], isGateDay: false, gateTarget: null },
    { day: 22, phase: 3, label: 'Kill-switch compound stress', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 23, phase: 3, label: 'Gate review → Phase 4', scenarios: [], isGateDay: true, gateTarget: 'phase4' },
    // Phase 4: Controlled Micro-Capital Live Trial (Days 24-30)
    { day: 24, phase: 4, label: 'Initial micro-live run', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 25, phase: 4, label: 'Extended micro-live', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 26, phase: 4, label: 'Controlled concurrency', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 27, phase: 4, label: 'Live restart drill', scenarios: ['S5'], isGateDay: false, gateTarget: null },
    { day: 28, phase: 4, label: 'Boundary timing live drill', scenarios: ['S3'], isGateDay: false, gateTarget: null },
    { day: 29, phase: 4, label: 'Endurance run (6 hrs)', scenarios: [], isGateDay: false, gateTarget: null },
    { day: 30, phase: 4, label: 'Final Go/No-Go decision', scenarios: [], isGateDay: true, gateTarget: 'latency-capable' },
];

/* ── Data shape returned to UI ── */

interface ScenarioRunSummary {
    id: string;
    title: string;
    pass: boolean;
    exitCode: number;
}

interface DailyScore {
    total: number;
    categories: {
        dataIntegrity: number;
        executionDeterminism: number;
        reconciliationReliability: number;
        riskEnforcementTiming: number;
        operationalStability: number;
    };
}

interface GateResult {
    target: string;
    pass: boolean;
    reasons: string[];
}

interface DayResult {
    date: string;
    overallPass: boolean | null;
    score: DailyScore | null;
    gate: GateResult | null;
    scenarioRuns: ScenarioRunSummary[];
    handoffCount: number;
}

export interface HardeningResponse {
    requestId: string;
    runbookDays: DayMeta[];
    dayResults: Record<string, DayResult>;
    availableDates: string[];
    gateThresholds: Record<string, { minTotal: number; keyCategory: string; minCategoryScore: number }>;
}

/* ── Helpers ── */

function readJsonSafe(filePath: string): unknown | null {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function scanHardeningDir(): string[] {
    const hardeningRoot = path.resolve(process.cwd(), 'data', 'hardening');
    if (!fs.existsSync(hardeningRoot)) return [];
    return fs.readdirSync(hardeningRoot)
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .sort();
}

function loadDayResult(dateKey: string): DayResult {
    const dayDir = path.resolve(process.cwd(), 'data', 'hardening', dateKey);
    const result: DayResult = {
        date: dateKey,
        overallPass: null,
        score: null,
        gate: null,
        scenarioRuns: [],
        handoffCount: 0,
    };

    // Load daily-score.json
    const scoreData = readJsonSafe(path.join(dayDir, 'daily-score.json')) as Record<string, unknown> | null;
    if (scoreData?.score) {
        const s = scoreData.score as Record<string, unknown>;
        result.score = {
            total: Number(s.total || 0),
            categories: {
                dataIntegrity: Number((s.categories as Record<string, unknown>)?.dataIntegrity || 0),
                executionDeterminism: Number((s.categories as Record<string, unknown>)?.executionDeterminism || 0),
                reconciliationReliability: Number((s.categories as Record<string, unknown>)?.reconciliationReliability || 0),
                riskEnforcementTiming: Number((s.categories as Record<string, unknown>)?.riskEnforcementTiming || 0),
                operationalStability: Number((s.categories as Record<string, unknown>)?.operationalStability || 0),
            },
        };
    }

    // Find the latest handoff report
    if (fs.existsSync(dayDir)) {
        const handoffFiles = fs.readdirSync(dayDir).filter((f) => /^handoff-.*\.json$/.test(f)).sort();
        result.handoffCount = handoffFiles.length;
        const latestHandoff = handoffFiles.length > 0
            ? readJsonSafe(path.join(dayDir, handoffFiles[handoffFiles.length - 1]!)) as Record<string, unknown> | null
            : null;

        if (latestHandoff) {
            const summary = latestHandoff.summary as Record<string, unknown> | undefined;
            result.overallPass = summary?.overallPass === true ? true : summary?.overallPass === false ? false : null;

            // Gate
            const gate = latestHandoff.gate as Record<string, unknown> | undefined;
            if (gate?.executed === true) {
                result.gate = {
                    target: String(gate.target || ''),
                    pass: gate.pass === true,
                    reasons: Array.isArray(gate.reasons) ? gate.reasons.map(String) : [],
                };
            }

            // Scenario runs
            const runs = latestHandoff.scenarioRuns as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(runs)) {
                result.scenarioRuns = runs.map((r) => ({
                    id: String(r.id || ''),
                    title: String(r.title || ''),
                    pass: r.pass === true,
                    exitCode: Number(r.exitCode || 1),
                }));
            }
        }
    }

    return result;
}

/* ── Handler ── */

function handler(req: LocalRequest, res: NextApiResponse<HardeningResponse>) {
    const dates = scanHardeningDir();
    const dayResults: Record<string, DayResult> = {};
    for (const d of dates) {
        dayResults[d] = loadDayResult(d);
    }

    return res.status(200).json({
        requestId: req.requestId,
        runbookDays: RUNBOOK_DAYS,
        dayResults,
        availableDates: dates,
        gateThresholds: {
            phase2: { minTotal: 72, keyCategory: 'dataIntegrity', minCategoryScore: 16 },
            phase3: { minTotal: 78, keyCategory: 'executionDeterminism', minCategoryScore: 16 },
            phase4: { minTotal: 84, keyCategory: 'riskEnforcementTiming', minCategoryScore: 17 },
            'latency-capable': { minTotal: 88, keyCategory: 'all', minCategoryScore: 16 },
        },
    });
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
