/**
 * Adverse Selection Rate Panel
 *
 * Displays rolling 1-hour adverse selection rate with a sparkline.
 * Data source: GET /api/analytics/adverse-selection-rate
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { Panel } from './Panel';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AdverseSelectionResponse {
    adverseRate: number;
    sampleCount: number;
    adverseCount: number;
}

interface AdverseSelectionPanelProps {
    pollInterval?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline (inline SVG – no external deps)
// ─────────────────────────────────────────────────────────────────────────────

function Sparkline({ data, width = 120, height = 28 }: { data: number[]; width?: number; height?: number }) {
    if (data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const points = data
        .map((v, i) => {
            const x = (i / (data.length - 1)) * width;
            const y = height - ((v - min) / range) * (height - 4) - 2;
            return `${x},${y}`;
        })
        .join(' ');

    const last = data[data.length - 1] ?? 0;
    const color = last > 0.3 ? '#ef4444' : last > 0.15 ? '#f59e0b' : '#22c55e';

    return (
        <svg width={width} height={height} className="inline-block">
            <polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────────────────

export function AdverseSelectionPanel({ pollInterval = 5000 }: AdverseSelectionPanelProps) {
    const [rate, setRate] = useState<number | null>(null);
    const [sampleCount, setSampleCount] = useState(0);
    const [adverseCount, setAdverseCount] = useState(0);
    const [history, setHistory] = useState<number[]>([]);
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval>>();

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch('/api/analytics/adverse-selection-rate');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: AdverseSelectionResponse = await res.json();
            setRate(data.adverseRate);
            setSampleCount(data.sampleCount);
            setAdverseCount(data.adverseCount);
            setHistory((prev) => [...prev, data.adverseRate].slice(-60));
            setError(null);
        } catch (err: any) {
            setError(err?.message || 'Fetch failed');
        }
    }, []);

    useEffect(() => {
        fetchData();
        timerRef.current = setInterval(fetchData, pollInterval);
        return () => clearInterval(timerRef.current);
    }, [fetchData, pollInterval]);

    const pct = rate !== null ? (rate * 100).toFixed(1) : '—';
    const tone = rate === null ? 'text-slate-500' : rate > 0.3 ? 'text-red-400' : rate > 0.15 ? 'text-amber-400' : 'text-emerald-400';

    return (
        <Panel title="Adverse Selection 1h" icon={ShieldAlert} compact fillHeight>
            <div className="flex flex-col gap-3 h-full items-center justify-center">
                {error ? (
                    <span className="text-sm text-red-400">{error}</span>
                ) : (
                    <>
                        <div className="flex items-baseline gap-2">
                            <span className={clsx('text-3xl font-mono font-bold tabular-nums', tone)}>
                                {pct}%
                            </span>
                            <span className="text-xs text-slate-500 uppercase tracking-wide">adverse rate</span>
                        </div>

                        <Sparkline data={history} width={160} height={28} />

                        <div className="flex gap-3 text-xs text-slate-500 font-mono">
                            <span>{adverseCount}/{sampleCount} adverse</span>
                        </div>
                    </>
                )}
            </div>
        </Panel>
    );
}
