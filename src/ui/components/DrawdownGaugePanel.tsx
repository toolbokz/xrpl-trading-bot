/**
 * Drawdown Gauge Panel
 *
 * Displays current drawdown as a visual gauge plus drawdown velocity.
 * Data source: GET /api/analytics/summary → drawdown[] + drawdownVelocity
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { TrendingDown } from 'lucide-react';
import clsx from 'clsx';
import { Panel } from './Panel';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DrawdownPoint {
    ts: number;
    equity: number;
    drawdown: number;
}

interface DrawdownGaugePanelProps {
    pollInterval?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Arc Gauge (SVG)
// ─────────────────────────────────────────────────────────────────────────────

function ArcGauge({ value, max = 100 }: { value: number; max?: number }) {
    const pct = Math.min(Math.max(value / max, 0), 1);
    const radius = 38;
    const stroke = 6;
    // Arc from -135° to +135° (270° sweep)
    const startAngle = -135;
    const sweep = 270;
    const endAngle = startAngle + sweep * pct;

    const toXY = (angleDeg: number) => {
        const rad = (angleDeg * Math.PI) / 180;
        return {
            x: 50 + radius * Math.cos(rad),
            y: 50 + radius * Math.sin(rad),
        };
    };

    const bgStart = toXY(startAngle);
    const bgEnd = toXY(startAngle + sweep);
    const valEnd = toXY(endAngle);

    const largeArcBg = sweep > 180 ? 1 : 0;
    const largeArcVal = (sweep * pct) > 180 ? 1 : 0;

    const bgPath = `M ${bgStart.x} ${bgStart.y} A ${radius} ${radius} 0 ${largeArcBg} 1 ${bgEnd.x} ${bgEnd.y}`;
    const valPath = pct > 0.001
        ? `M ${bgStart.x} ${bgStart.y} A ${radius} ${radius} 0 ${largeArcVal} 1 ${valEnd.x} ${valEnd.y}`
        : '';

    const color = pct > 0.5 ? '#ef4444' : pct > 0.25 ? '#f59e0b' : '#22c55e';

    return (
        <svg viewBox="0 0 100 100" className="w-full h-full max-w-[100px] mx-auto">
            <path d={bgPath} fill="none" stroke="#334155" strokeWidth={stroke} strokeLinecap="round" />
            {valPath && (
                <path d={valPath} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
            )}
            <text x="50" y="54" textAnchor="middle" className="fill-slate-200 text-[13px] font-mono font-bold">
                {(value ?? 0).toFixed(1)}%
            </text>
        </svg>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────────────────

export function DrawdownGaugePanel({ pollInterval = 10000 }: DrawdownGaugePanelProps) {
    const [currentDrawdown, setCurrentDrawdown] = useState(0);
    const [maxDrawdown, setMaxDrawdown] = useState(0);
    const [velocity, setVelocity] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval>>();

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch('/api/analytics/summary');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            const ddPoints: DrawdownPoint[] = data.drawdown ?? [];
            const latest = ddPoints.length > 0 ? ddPoints[ddPoints.length - 1] : null;

            setCurrentDrawdown(latest ? Math.abs(latest.drawdown) * 100 : 0);
            setMaxDrawdown((data.summary?.maxDrawdown ?? 0) * 100);
            setVelocity(data.drawdownVelocity ?? 0);
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

    const velColor = Math.abs(velocity) > 5 ? 'text-red-400' : Math.abs(velocity) > 2 ? 'text-amber-400' : 'text-slate-400';

    return (
        <Panel title="Drawdown" icon={TrendingDown} compact fillHeight>
            <div className="flex flex-col gap-1 h-full items-center justify-center">
                {error ? (
                    <span className="text-xs text-red-400">{error}</span>
                ) : (
                    <>
                        <ArcGauge value={currentDrawdown} max={Math.max(maxDrawdown * 1.5, 10)} />
                        <div className="flex gap-3 text-[10px] font-mono text-slate-500 mt-1">
                            <span>max {(maxDrawdown ?? 0).toFixed(1)}%</span>
                            <span className={clsx(velColor)}>
                                vel {(velocity ?? 0) > 0 ? '+' : ''}{(velocity ?? 0).toFixed(2)}/h
                            </span>
                        </div>
                    </>
                )}
            </div>
        </Panel>
    );
}
