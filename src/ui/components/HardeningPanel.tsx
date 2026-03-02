'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, CheckCircle2, XCircle, Clock, ChevronDown, ChevronRight, RefreshCw, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { Panel } from './Panel';

/* ── Types mirroring the API response ── */

interface DayMeta {
    day: number;
    phase: number;
    label: string;
    scenarios: string[];
    isGateDay: boolean;
    gateTarget: string | null;
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

interface ScenarioRunSummary {
    id: string;
    title: string;
    pass: boolean;
    exitCode: number;
}

interface DayResult {
    date: string;
    overallPass: boolean | null;
    score: DailyScore | null;
    gate: GateResult | null;
    scenarioRuns: ScenarioRunSummary[];
    handoffCount: number;
}

interface GateThreshold {
    minTotal: number;
    keyCategory: string;
    minCategoryScore: number;
}

interface HardeningData {
    runbookDays: DayMeta[];
    dayResults: Record<string, DayResult>;
    availableDates: string[];
    gateThresholds: Record<string, GateThreshold>;
}

/* ── Helpers ── */

const PHASE_LABELS: Record<number, string> = {
    1: 'Observability & Determinism',
    2: 'Execution & Reconciliation',
    3: 'XRPL Edge Cases',
    4: 'Micro-Capital Live Trial',
};

const PHASE_COLORS: Record<number, { bg: string; text: string; border: string }> = {
    1: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20' },
    2: { bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/20' },
    3: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20' },
    4: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20' },
};

const DEFAULT_PHASE_COLOR = { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20' };

function getPhaseColor(phase: number) {
    return PHASE_COLORS[phase] ?? DEFAULT_PHASE_COLOR;
}

const CATEGORY_LABELS: Record<string, string> = {
    dataIntegrity: 'Data Integrity',
    executionDeterminism: 'Execution Determinism',
    reconciliationReliability: 'Reconciliation',
    riskEnforcementTiming: 'Risk Enforcement',
    operationalStability: 'Operational Stability',
};

function scoreColor(score: number, max: number): string {
    const pct = score / max;
    if (pct >= 0.85) return 'text-emerald-400';
    if (pct >= 0.7) return 'text-amber-400';
    return 'text-red-400';
}

function scoreBgColor(score: number, max: number): string {
    const pct = score / max;
    if (pct >= 0.85) return 'bg-emerald-500/20';
    if (pct >= 0.7) return 'bg-amber-500/20';
    return 'bg-red-500/20';
}

/* ── Score Bar ── */

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
    const pct = Math.min(100, (value / max) * 100);
    return (
        <div className="flex items-center gap-2 text-[10px]">
            <span className="w-28 truncate text-slate-400">{label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                    className={clsx('h-full rounded-full transition-all', scoreBgColor(value, max))}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <span className={clsx('w-8 text-right font-mono', scoreColor(value, max))}>
                {value}/{max}
            </span>
        </div>
    );
}

/* ── Phase Gate Badge ── */

function GateBadge({ gate, threshold }: { gate: GateResult | null; threshold: GateThreshold | undefined }) {
    if (!gate) {
        return (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] bg-white/5 text-slate-500">
                <Clock size={9} /> Not run
            </span>
        );
    }
    if (gate.pass) {
        return (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] bg-emerald-500/20 text-emerald-400 font-medium">
                <CheckCircle2 size={9} /> PASS
                {threshold && <span className="text-slate-500 ml-1">≥{threshold.minTotal}</span>}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] bg-red-500/20 text-red-400 font-medium">
            <XCircle size={9} /> FAIL
            {gate.reasons.length > 0 && (
                <span className="text-red-400/60 ml-1 truncate max-w-[180px]" title={gate.reasons.join('; ')}>
                    {gate.reasons[0]}
                </span>
            )}
        </span>
    );
}

/* ── Day Row ── */

function DayRow({ meta, result, dateMapping }: { meta: DayMeta; result: DayResult | null; dateMapping: string | null }) {
    const [expanded, setExpanded] = useState(false);
    const phaseColor = getPhaseColor(meta.phase);
    const hasResult = result !== null && (result.score !== null || result.scenarioRuns.length > 0);

    const statusIcon = result === null
        ? <Clock size={10} className="text-slate-600" />
        : result.overallPass === true
            ? <CheckCircle2 size={10} className="text-emerald-400" />
            : result.overallPass === false
                ? <XCircle size={10} className="text-red-400" />
                : <AlertTriangle size={10} className="text-amber-400" />;

    return (
        <div className={clsx(
            'border-l-2 pl-2 py-1 transition-colors',
            hasResult ? phaseColor.border : 'border-white/5',
        )}>
            <button
                onClick={() => hasResult && setExpanded(!expanded)}
                className={clsx(
                    'flex w-full items-center gap-2 text-left text-[11px]',
                    hasResult ? 'cursor-pointer hover:bg-white/5 rounded px-1 -mx-1' : 'cursor-default',
                )}
                disabled={!hasResult}
            >
                {hasResult
                    ? (expanded ? <ChevronDown size={10} className="text-slate-500 shrink-0" /> : <ChevronRight size={10} className="text-slate-500 shrink-0" />)
                    : <span className="w-[10px] shrink-0" />
                }
                {statusIcon}
                <span className={clsx(
                    'font-mono w-6 shrink-0',
                    phaseColor.text,
                )}>
                    D{meta.day}
                </span>
                <span className={clsx(
                    'flex-1 truncate',
                    hasResult ? 'text-slate-200' : 'text-slate-500',
                )}>
                    {meta.label}
                </span>
                {meta.isGateDay && (
                    <span className={clsx(
                        'shrink-0 rounded px-1 py-0.5 text-[9px] font-medium',
                        phaseColor.bg, phaseColor.text,
                    )}>
                        GATE
                    </span>
                )}
                {meta.scenarios.length > 0 && (
                    <span className="shrink-0 text-[9px] text-slate-500 font-mono">
                        {meta.scenarios.join(',')}
                    </span>
                )}
                {result?.score && (
                    <span className={clsx(
                        'shrink-0 font-mono text-[10px] font-medium',
                        scoreColor(result.score.total, 100),
                    )}>
                        {result.score.total}/100
                    </span>
                )}
                {dateMapping && (
                    <span className="shrink-0 text-[9px] text-slate-600 font-mono">
                        {dateMapping}
                    </span>
                )}
            </button>

            {expanded && result && (
                <div className="ml-6 mt-1 space-y-2 pb-1">
                    {/* Score breakdown */}
                    {result.score && (
                        <div className="space-y-1">
                            <div className="text-[9px] text-slate-500 uppercase tracking-wider">Score Breakdown</div>
                            {Object.entries(result.score.categories).map(([key, value]) => (
                                <ScoreBar key={key} label={CATEGORY_LABELS[key] || key} value={value as number} max={20} />
                            ))}
                        </div>
                    )}

                    {/* Scenario runs */}
                    {result.scenarioRuns.length > 0 && (
                        <div className="space-y-0.5">
                            <div className="text-[9px] text-slate-500 uppercase tracking-wider">Scenarios</div>
                            {result.scenarioRuns.map((run) => (
                                <div key={run.id} className="flex items-center gap-2 text-[10px]">
                                    {run.pass
                                        ? <CheckCircle2 size={9} className="text-emerald-400 shrink-0" />
                                        : <XCircle size={9} className="text-red-400 shrink-0" />
                                    }
                                    <span className="font-mono text-slate-400">{run.id}</span>
                                    <span className="text-slate-300 truncate">{run.title}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Gate result */}
                    {result.gate && (
                        <div className="space-y-0.5">
                            <div className="text-[9px] text-slate-500 uppercase tracking-wider">Gate</div>
                            <div className="flex items-center gap-2 text-[10px]">
                                <span className="text-slate-400">Target: {result.gate.target}</span>
                                {result.gate.pass
                                    ? <span className="text-emerald-400 font-medium">PASS</span>
                                    : <span className="text-red-400 font-medium">FAIL</span>
                                }
                            </div>
                            {!result.gate.pass && result.gate.reasons.length > 0 && (
                                <ul className="text-[9px] text-red-400/80 space-y-0.5 ml-2">
                                    {result.gate.reasons.map((r, i) => (
                                        <li key={i}>• {r}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/* ── Main Panel ── */

export interface HardeningPanelProps {
    enabled?: boolean;
    pollInterval?: number;
}

export function HardeningPanel({ enabled = true, pollInterval = 60_000 }: HardeningPanelProps) {
    const [data, setData] = useState<HardeningData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch('/api/hardening');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setData(json);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled) return () => undefined;
        fetchData();
        const interval = setInterval(fetchData, pollInterval);
        return () => clearInterval(interval);
    }, [fetchData, enabled, pollInterval]);

    // Map day number -> date string
    const dayToDate = useMemo(() => {
        if (!data) return {};
        const map: Record<number, string> = {};
        data.availableDates.forEach((d, i) => {
            map[i + 1] = d;
        });
        return map;
    }, [data]);

    // Phase progress summary
    const phaseProgress = useMemo(() => {
        if (!data) return [];
        const phases = [1, 2, 3, 4];
        return phases.map((p) => {
            const phaseDays = data.runbookDays.filter((d) => d.phase === p);
            const completedDays = phaseDays.filter((d) => {
                const date = dayToDate[d.day];
                if (!date) return false;
                const result = data.dayResults[date];
                return result && (result.score !== null || result.scenarioRuns.length > 0);
            });
            const gateDay = phaseDays.find((d) => d.isGateDay);
            const gateDate = gateDay ? dayToDate[gateDay.day] : undefined;
            const gateResult = gateDate ? data.dayResults[gateDate]?.gate : null;
            return {
                phase: p,
                label: PHASE_LABELS[p],
                total: phaseDays.length,
                completed: completedDays.length,
                gatePass: gateResult?.pass ?? null,
            };
        });
    }, [data, dayToDate]);

    // Latest score
    const latestScore = useMemo(() => {
        if (!data || data.availableDates.length === 0) return null;
        for (let i = data.availableDates.length - 1; i >= 0; i--) {
            const dateKey = data.availableDates[i];
            if (!dateKey) continue;
            const result = data.dayResults[dateKey];
            if (result?.score) return result.score;
        }
        return null;
    }, [data]);

    // Current active day
    const currentDay = useMemo(() => {
        if (!data) return 0;
        return data.availableDates.length;
    }, [data]);

    // Current phase
    const currentPhase = useMemo(() => {
        if (!data || currentDay === 0) return 1;
        const dayMeta = data.runbookDays[Math.min(currentDay - 1, 29)];
        return dayMeta?.phase ?? 1;
    }, [data, currentDay]);

    if (loading) {
        return (
            <Panel title="Hardening Progress" icon={Shield} compact>
                <div className="flex items-center gap-1.5 text-slate-500 text-[10px] p-4">
                    <RefreshCw className="animate-spin" size={10} />
                    Loading hardening data…
                </div>
            </Panel>
        );
    }

    if (error) {
        return (
            <Panel title="Hardening Progress" icon={Shield} compact>
                <div className="text-[10px] text-red-400 p-4">{error}</div>
            </Panel>
        );
    }

    if (!data) {
        return (
            <Panel title="Hardening Progress" icon={Shield} compact>
                <div className="text-[10px] text-slate-500 p-4">No data</div>
            </Panel>
        );
    }

    return (
        <Panel
            title="Hardening Progress"
            icon={Shield}
            compact
            scrollable
            fillHeight
            subtitle={`Day ${currentDay}/30 · Phase ${currentPhase}`}
            actions={
                <button
                    onClick={fetchData}
                    className="rounded p-1 text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors"
                    title="Refresh"
                >
                    <RefreshCw size={11} />
                </button>
            }
        >
            {/* ── Score summary ── */}
            {latestScore && (
                <div className="mb-3 rounded-md border border-white/[0.06] bg-white/[0.02] p-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider">Latest Score</span>
                        <span className={clsx(
                            'text-sm font-bold font-mono',
                            scoreColor(latestScore.total, 100),
                        )}>
                            {latestScore.total}/100
                        </span>
                    </div>
                    {Object.entries(latestScore.categories).map(([key, value]) => (
                        <ScoreBar key={key} label={CATEGORY_LABELS[key] || key} value={value as number} max={20} />
                    ))}
                </div>
            )}

            {/* ── Phase progress bars ── */}
            <div className="mb-3 grid grid-cols-4 gap-1">
                {phaseProgress.map((p) => {
                    const phaseColor = getPhaseColor(p.phase);
                    const pct = p.total > 0 ? (p.completed / p.total) * 100 : 0;
                    return (
                        <div key={p.phase} className="space-y-0.5">
                            <div className="flex items-center justify-between">
                                <span className={clsx('text-[9px] font-medium', phaseColor.text)}>P{p.phase}</span>
                                <span className="text-[9px] text-slate-500">{p.completed}/{p.total}</span>
                            </div>
                            <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                                <div
                                    className={clsx('h-full rounded-full transition-all', phaseColor.bg)}
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                            {p.gatePass !== null && (
                                <div className="text-center">
                                    {p.gatePass
                                        ? <CheckCircle2 size={8} className="inline text-emerald-400" />
                                        : <XCircle size={8} className="inline text-red-400" />
                                    }
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* ── Gate thresholds ── */}
            <div className="mb-3 flex flex-wrap gap-1">
                {Object.entries(data.gateThresholds).map(([target, th]) => {
                    // Find if this gate has been evaluated
                    const gateResult = Object.values(data.dayResults).find(
                        (r) => r.gate?.target === target
                    )?.gate;
                    return (
                        <div key={target} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-white/[0.03] border border-white/[0.06]">
                            <span className="text-[9px] text-slate-400 font-medium">{target}</span>
                            <span className="text-[9px] text-slate-500">≥{th.minTotal}</span>
                            <GateBadge gate={gateResult ?? null} threshold={th} />
                        </div>
                    );
                })}
            </div>

            {/* ── Day-by-day checklist ── */}
            <div className="space-y-0.5">
                {[1, 2, 3, 4].map((phase) => {
                    const phaseDays = data.runbookDays.filter((d) => d.phase === phase);
                    const phaseColor = getPhaseColor(phase);
                    return (
                        <div key={phase} className="mb-2">
                            <div className={clsx(
                                'text-[9px] font-semibold uppercase tracking-wider mb-1 px-1 py-0.5 rounded',
                                phaseColor.bg, phaseColor.text,
                            )}>
                                Phase {phase}: {PHASE_LABELS[phase]}
                            </div>
                            <div className="space-y-0">
                                {phaseDays.map((dayMeta) => {
                                    const date = dayToDate[dayMeta.day];
                                    const result = date ? data.dayResults[date] ?? null : null;
                                    return (
                                        <DayRow
                                            key={dayMeta.day}
                                            meta={dayMeta}
                                            result={result}
                                            dateMapping={date ?? null}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </Panel>
    );
}
