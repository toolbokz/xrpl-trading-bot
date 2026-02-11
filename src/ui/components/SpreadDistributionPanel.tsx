'use client';

import { useMemo } from 'react';
import { BarChart3, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { Panel } from './Panel';
import { useSpreadDistribution } from '../lib/hooks/useSpreadDistribution';
import type { RuntimeCacheSnapshot } from '../../runtime/runtimeCacheRegistry';

type SpreadDistributionSnapshot = RuntimeCacheSnapshot['spreadDistribution'];

const formatBps = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '-';
    return value.toFixed(1);
};

const formatSamples = (count: number | null | undefined) => {
    if (!count) return '0';
    return count.toString();
};

function SpreadSection({
    label,
    stats,
    muted = false,
}: {
    label: string;
    stats: { sampleCount: number; medianBps: number | null; p75Bps: number | null; p90Bps: number | null } | null;
    muted?: boolean;
}) {
    const sampleCount = stats?.sampleCount ?? 0;

    return (
        <div className={clsx('space-y-1', muted && 'opacity-75')}>
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-slate-500">
                <span>{label}</span>
                <span>{formatSamples(sampleCount)} smp</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                <div className="flex items-center justify-between text-slate-300">
                    <span className="text-slate-500">p50</span>
                    <span>{formatBps(stats?.medianBps)}</span>
                </div>
                <div className="flex items-center justify-between text-slate-300">
                    <span className="text-slate-500">p75</span>
                    <span>{formatBps(stats?.p75Bps)}</span>
                </div>
                <div className="flex items-center justify-between text-slate-300">
                    <span className="text-slate-500">p90</span>
                    <span>{formatBps(stats?.p90Bps)}</span>
                </div>
            </div>
        </div>
    );
}

export function SpreadDistributionPanelContent({
    data,
    loading,
    error,
}: {
    data: SpreadDistributionSnapshot | null;
    loading: boolean;
    error: string | null;
}) {
    const updatedAt = useMemo(() => {
        if (!data?.updatedAtMs) return '-';
        return new Date(data.updatedAtMs).toLocaleTimeString('en-US', { hour12: false });
    }, [data?.updatedAtMs]);

    const baselineLabel = data?.baselineMultiDay?.days
        ? `Baseline ${data.baselineMultiDay.days}d`
        : 'Baseline';

    return (
        <Panel
            title="Spread Distribution"
            icon={BarChart3}
            compact
            dense
            subtitle={<span className="text-[9px] text-slate-500">Updated {updatedAt}</span>}
        >
            {loading && (
                <div className="text-[11px] text-slate-500">Loading...</div>
            )}

            {!loading && error && (
                <div className="flex items-center gap-1.5 text-[10px] text-red-400">
                    <AlertTriangle size={10} />
                    <span>{error}</span>
                </div>
            )}

            {!loading && !error && (
                <div className="space-y-2">
                    <SpreadSection label="24h" stats={data?.lookback24h ?? null} />
                    <div className="border-t border-white/5" />
                    <SpreadSection label={baselineLabel} stats={data?.baselineMultiDay ?? null} muted />
                </div>
            )}
        </Panel>
    );
}

export function SpreadDistributionPanel() {
    const { data, loading, error } = useSpreadDistribution({ pollInterval: 10_000 });
    return (
        <SpreadDistributionPanelContent data={data} loading={loading} error={error} />
    );
}
