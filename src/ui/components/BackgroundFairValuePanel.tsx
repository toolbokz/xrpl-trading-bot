'use client';

import { Target } from 'lucide-react';
import { Panel, PanelBadge } from './Panel';
import { useRuntimeCache } from '../lib/hooks/useRuntimeCache';
import { toBackgroundView } from './backgroundScannerViewModel';

interface BackgroundFairValuePanelProps {
    pollInterval?: number;
    compact?: boolean;
}

const formatTime = (ts: number | null): string => {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString([], { hour12: false });
};

const formatNum = (v: number | null, digits = 6): string => {
    if (v === null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
};

const formatBps = (v: number | null): string => {
    if (v === null || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`;
};

export function BackgroundFairValuePanel({
    pollInterval = 4000,
    compact = false,
}: BackgroundFairValuePanelProps) {
    const { data, loading } = useRuntimeCache({ pollInterval, enabled: true });
    const snapshot = data?.snapshot ?? null;
    const bg = toBackgroundView(snapshot);

    const confidence = bg?.fairValue.confidence ?? null;
    const divergence = bg?.fairValue.divergenceBps ?? null;
    const pairLabel = snapshot?.pairKey ?? 'XRP/RLUSD';

    return (
        <Panel
            title="Fair Value"
            icon={Target}
            compact={compact}
            subtitle={`as of ${formatTime(bg?.asOfMs ?? snapshot?.asOfMs ?? null)}`}
            actions={
                <PanelBadge tone={loading ? 'warning' : 'neutral'}>
                    {loading ? 'updating' : (snapshot?.pairKey || 'cache')}
                </PanelBadge>
            }
            className="h-full"
            bodyClassName="space-y-2"
        >
            {!bg ? (
                <div className="text-[11px] text-slate-500 py-2">Scanner disabled or warming up.</div>
            ) : (
                <>
                    <div className="grid grid-cols-3 gap-2">
                        <Metric label={`Fair (${pairLabel})`} value={formatNum(bg.fairValue.fairValue, 6)} />
                        <Metric
                            label="Divergence"
                            value={formatBps(divergence)}
                            valueClassName={
                                divergence !== null && Math.abs(divergence) > 30
                                    ? 'text-amber-300'
                                    : 'text-slate-200'
                            }
                        />
                        <Metric label="Confidence" value={confidence === null ? '—' : `${Math.round(confidence)}%`} />
                    </div>

                    <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] text-slate-500">
                            <span className="uppercase tracking-wider">Confidence</span>
                            <span>{confidence === null ? '—' : `${Math.round(confidence)}/100`}</span>
                        </div>
                        <SegmentedConfidence confidence={confidence} />
                    </div>

                    <div className="space-y-1.5">
                        <details>
                            <summary className="cursor-pointer text-[10px] text-slate-500 uppercase tracking-wider">Sources</summary>
                            <div className="mt-1.5">
                                {bg.fairValue.sources.length === 0 ? (
                                    <div className="text-[11px] text-slate-500">No anchor sources.</div>
                                ) : (
                                    <div className="space-y-1">
                                        {bg.fairValue.sources.slice(0, 4).map((src, idx) => (
                                            <div key={`${src.pairKey}-${idx}`} className="grid grid-cols-[1fr_auto_auto] gap-2 text-[11px] font-mono">
                                                <div className="truncate text-slate-300">{src.pairKey}</div>
                                                <div className="text-slate-400">w {Math.round(src.weight * 100)}%</div>
                                                <div className="text-slate-500">{humanMs(src.stalenessMs)}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </details>
                    </div>
                </>
            )}
        </Panel>
    );
}

function Metric({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
    return (
        <div className="rounded-md bg-white/[0.03] border border-white/10 px-2 py-1.5">
            <div className="text-[9px] text-slate-500 uppercase tracking-wider truncate">{label}</div>
            <div className={`text-[12px] font-mono font-semibold ${valueClassName || 'text-slate-100'}`}>{value}</div>
        </div>
    );
}

function SegmentedConfidence({ confidence }: { confidence: number | null }) {
    const blocks = 10;
    const active = confidence === null ? 0 : Math.max(0, Math.min(blocks, Math.round(confidence / 10)));

    return (
        <div className="flex gap-1">
            {Array.from({ length: blocks }).map((_, idx) => (
                <div
                    key={idx}
                    className={`h-2 flex-1 rounded-sm ${idx < active ? 'bg-emerald-400/80' : 'bg-white/10'}`}
                    title={`${(idx + 1) * 10}%`}
                />
            ))}
        </div>
    );
}

function humanMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60_000)}m`;
}

export default BackgroundFairValuePanel;
