'use client';

import { AlertTriangle, CheckCircle2, PauseCircle } from 'lucide-react';
import { Panel, PanelBadge } from './Panel';
import { useRuntimeCache } from '../lib/hooks/useRuntimeCache';
import { toBackgroundView } from './backgroundScannerViewModel';

interface BackgroundScannerHealthPanelProps {
    pollInterval?: number;
    compact?: boolean;
}

type Status = 'HEALTHY' | 'DEGRADED' | 'DISABLED' | 'NO DATA';

function getStatus(hasSnapshot: boolean, hasBg: boolean, degraded: boolean): Status {
    if (!hasSnapshot) return 'NO DATA';
    if (!hasBg) return 'DISABLED';
    return degraded ? 'DEGRADED' : 'HEALTHY';
}

function statusTone(status: Status): 'success' | 'warning' | 'neutral' {
    if (status === 'HEALTHY') return 'success';
    if (status === 'DEGRADED') return 'warning';
    return 'neutral';
}

function statusIcon(status: Status) {
    if (status === 'HEALTHY') return CheckCircle2;
    if (status === 'DEGRADED') return AlertTriangle;
    return PauseCircle;
}

const fmtAgo = (ts: number | null): string => {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 1000) return '<1s ago';
    if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
    if (d < 3600_000) return `${Math.round(d / 60_000)}m ago`;
    return `${Math.round(d / 3600_000)}h ago`;
};

export function BackgroundScannerHealthPanel({
    pollInterval = 4000,
    compact = false,
}: BackgroundScannerHealthPanelProps) {
    const { data, loading } = useRuntimeCache({ pollInterval, enabled: true });
    const snapshot = data?.snapshot ?? null;
    const bg = toBackgroundView(snapshot);

    const status = getStatus(!!snapshot, !!bg, bg?.health.degraded ?? false);
    const score = bg?.health.score ?? null;
    const Icon = statusIcon(status);

    return (
        <Panel
            title="Scanner Health"
            icon={Icon}
            compact={compact}
            subtitle={snapshot?.pairKey ?? 'runtime cache'}
            actions={<PanelBadge tone={statusTone(status)}>{status}</PanelBadge>}
            className="h-full"
            bodyClassName="space-y-2"
        >
            <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                <Cell label="Score" value={score === null ? '—' : String(Math.round(score))} />
                <Cell
                    label="Last OK"
                    value={fmtAgo(bg?.health.lastOkAtMs ?? null)}
                    {...optionalTitle(toIso(bg?.health.lastOkAtMs ?? null))}
                />
                <Cell
                    label="Last Err"
                    value={fmtAgo(bg?.health.lastErrorAtMs ?? null)}
                    {...optionalTitle(toIso(bg?.health.lastErrorAtMs ?? null))}
                />
            </div>

            <div>
                <div className="h-2 rounded-sm bg-white/10 overflow-hidden">
                    <div
                        className={`h-full ${status === 'DEGRADED' ? 'bg-amber-400/80' : 'bg-emerald-400/80'}`}
                        style={{ width: `${Math.max(0, Math.min(100, score ?? 0))}%` }}
                    />
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                <Cell label="Failures" value={String(bg?.health.consecutiveFailures ?? 0)} />
                <Cell label="State" value={snapshot?.runtimeState ?? '—'} />
            </div>

            {bg?.health.lastError ? (
                <div
                    className="text-[10px] text-amber-300/90 font-mono bg-amber-500/10 border border-amber-500/20 rounded p-1.5 truncate"
                    title={bg.health.lastError}
                >
                    {bg.health.lastError.slice(0, 80)}
                </div>
            ) : (
                <div className="text-[10px] text-slate-500">{loading ? 'Updating scanner health…' : 'No scanner errors.'}</div>
            )}
        </Panel>
    );
}

function Cell({ label, value, title }: { label: string; value: string; title?: string }) {
    return (
        <div className="rounded-md bg-white/[0.03] border border-white/10 px-2 py-1" title={title}>
            <div className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</div>
            <div className="text-[11px] text-slate-200 truncate">{value}</div>
        </div>
    );
}

function toIso(ts: number | null): string | undefined {
    if (!ts) return undefined;
    return new Date(ts).toISOString();
}

function optionalTitle(title: string | undefined): { title?: string } {
    if (!title) return {};
    return { title };
}

export default BackgroundScannerHealthPanel;
