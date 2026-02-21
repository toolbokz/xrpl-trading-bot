'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Panel, PanelBadge } from './Panel';
import type { VolatilityStopApiResponse } from '../pages/api/bot/volatility-stop';
import {
    deriveEffectiveStopBps,
    deriveVolatilityStopMode,
    deriveWarmupProgressPct,
} from './volatilityStopViewModel';

interface VolatilityStopPanelProps {
    pollInterval?: number;
    enabled?: boolean;
}

export function VolatilityStopPanel({
    pollInterval = 10_000,
    enabled = true,
}: VolatilityStopPanelProps) {
    const [data, setData] = useState<VolatilityStopApiResponse | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    const fetchState = useCallback(async () => {
        try {
            const response = await fetch('/api/bot/volatility-stop', { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload = await response.json() as VolatilityStopApiResponse;
            setData(payload);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch volatility stop state');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled) return () => undefined;
        void fetchState();
        const interval = setInterval(() => {
            void fetchState();
        }, Math.max(2000, pollInterval));
        return () => clearInterval(interval);
    }, [enabled, fetchState, pollInterval]);

    const mode = deriveVolatilityStopMode(data);
    const warmupPct = deriveWarmupProgressPct(data);
    const effectiveStopBps = deriveEffectiveStopBps(data);

    const modeTone = useMemo<'neutral' | 'success' | 'warning'>(() => {
        if (mode === 'ACTIVE') return 'success';
        if (mode === 'WARMING') return 'warning';
        return 'neutral';
    }, [mode]);

    const ModeIcon = mode === 'ACTIVE' ? ShieldCheck : ShieldAlert;

    return (
        <Panel
            title="Volatility Stop-Loss"
            icon={Gauge}
            fillHeight
            compact
            subtitle={data ? `${data.pairKey || '—'} · ${fmtStale(data.stalenessMs)}` : 'loading'}
            actions={<PanelBadge tone={modeTone}>{mode}</PanelBadge>}
            bodyClassName="space-y-2"
        >
            {!enabled ? (
                <div className="text-[11px] text-slate-500">Diagnostics polling paused.</div>
            ) : loading && !data ? (
                <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                    <RefreshCw size={11} className="animate-spin" />
                    Loading volatility state…
                </div>
            ) : error && !data ? (
                <div className="text-[11px] text-red-400">{error}</div>
            ) : data ? (
                <>
                    <div className="grid grid-cols-3 gap-1.5 text-[11px] font-mono">
                        <Metric label="Stop Used" value={`${effectiveStopBps.toFixed(1)} bps`} />
                        <Metric label="Vol EWMA" value={`${(data.runtime?.volBps ?? 0).toFixed(2)} bps`} />
                        <Metric label="Source" value={data.runtime?.source ?? 'fixed-disabled'} />
                    </div>

                    <div className="rounded border border-white/10 bg-white/[0.03] p-2">
                        <div className="mb-1 flex items-center justify-between text-[10px]">
                            <span className="text-slate-500">Warmup Progress</span>
                            <span className="font-mono text-slate-300">
                                {data.runtime?.sampleCount ?? 0}/{data.config.minSamples}
                            </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded bg-white/10">
                            <div
                                className={`h-full rounded ${mode === 'ACTIVE' ? 'bg-emerald-400/80' : 'bg-amber-400/80'}`}
                                style={{ width: `${warmupPct}%` }}
                            />
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                            <span>{(data.config.warmupMs / 1000).toFixed(0)}s target window</span>
                            <span className="inline-flex items-center gap-1">
                                <ModeIcon size={10} className={mode === 'ACTIVE' ? 'text-emerald-300' : 'text-amber-300'} />
                                {data.runtime?.volReady ? 'ready' : 'warming'}
                            </span>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                        <ConfigLine label="Enabled" value={data.config.enabled ? 'true' : 'false'} />
                        <ConfigLine label="Use For Enhanced" value={data.config.useForEnhanced ? 'true' : 'false'} />
                        <ConfigLine label="Fixed Stop" value={`${data.config.fixedStopLossBps.toFixed(1)} bps`} />
                        <ConfigLine label="Multiplier" value={data.config.multiplier.toFixed(2)} />
                        <ConfigLine label="Alpha" value={data.config.alpha.toFixed(3)} />
                        <ConfigLine label="Sample Min" value={String(data.config.minSamples)} />
                        <ConfigLine label="Min Bps" value={data.config.minBps.toFixed(1)} />
                        <ConfigLine label="Max Bps" value={data.config.maxBps.toFixed(1)} />
                    </div>
                </>
            ) : (
                <div className="text-[11px] text-slate-500">No volatility stop data available.</div>
            )}
        </Panel>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded border border-white/10 bg-white/[0.03] px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
            <div className="truncate text-[11px] text-slate-200">{value}</div>
        </div>
    );
}

function ConfigLine({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between border-b border-white/5 pb-0.5">
            <span className="text-slate-500">{label}</span>
            <span className="font-mono text-slate-300">{value}</span>
        </div>
    );
}

function fmtStale(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '0ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60_000)}m`;
}

export default VolatilityStopPanel;
