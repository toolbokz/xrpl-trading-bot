'use client';

import clsx from 'clsx';

/**
 * SVG radial gauge — draws a 240° arc from value 0→max.
 * Reused across risk dashboard, exposure, and health panels.
 */
export interface RadialGaugeProps {
    /** Current value */
    value: number;
    /** Maximum value (full arc) */
    max: number;
    /** Display label below the value */
    label: string;
    /** Gauge radius in px (default 48) */
    size?: number;
    /** Optional suffix for the value text (e.g., '%', ' XRP') */
    suffix?: string;
    /** Color thresholds — maps to tailwind-compatible stroke colors */
    thresholds?: { warn: number; danger: number };
    /** Format function for the center value */
    format?: (v: number) => string;
}

const DEFAULT_THRESHOLDS = { warn: 50, danger: 80 };

export function RadialGauge({
    value,
    max,
    label,
    size = 48,
    suffix = '',
    thresholds = DEFAULT_THRESHOLDS,
    format,
}: RadialGaugeProps) {
    const pct = max > 0 ? Math.min(value / max, 1) : 0;
    const pctDisplay = pct * 100;

    // Arc geometry: 240° sweep starting at 150° (bottom-left)
    const strokeWidth = size * 0.12;
    const r = size - strokeWidth;
    const cx = size;
    const cy = size;
    const startAngle = 150;
    const sweepDeg = 240;
    const endAngle = startAngle + sweepDeg;

    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const arcPoint = (angleDeg: number) => ({
        x: cx + r * Math.cos(toRad(angleDeg)),
        y: cy + r * Math.sin(toRad(angleDeg)),
    });

    const bgStart = arcPoint(startAngle);
    const bgEnd = arcPoint(endAngle);
    const largeArc = sweepDeg > 180 ? 1 : 0;
    const bgPath = `M ${bgStart.x} ${bgStart.y} A ${r} ${r} 0 ${largeArc} 1 ${bgEnd.x} ${bgEnd.y}`;

    const valAngle = startAngle + sweepDeg * pct;
    const valEnd = arcPoint(valAngle);
    const valLargeArc = sweepDeg * pct > 180 ? 1 : 0;
    const valPath = pct > 0
        ? `M ${bgStart.x} ${bgStart.y} A ${r} ${r} 0 ${valLargeArc} 1 ${valEnd.x} ${valEnd.y}`
        : '';

    const strokeColor =
        pctDisplay >= thresholds.danger
            ? '#ef4444'
            : pctDisplay >= thresholds.warn
                ? '#f59e0b'
                : '#22c55e';

    const displayValue = format ? format(value) : value.toFixed(1);

    return (
        <div className="flex flex-col items-center gap-0.5">
            <svg
                width={size * 2}
                height={size * 1.5}
                viewBox={`0 0 ${size * 2} ${size * 1.6}`}
                className="block"
            >
                {/* Background arc */}
                <path
                    d={bgPath}
                    fill="none"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                />
                {/* Value arc */}
                {valPath && (
                    <path
                        d={valPath}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={strokeWidth}
                        strokeLinecap="round"
                        className="transition-all duration-500"
                    />
                )}
                {/* Center text */}
                <text
                    x={cx}
                    y={cy - 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-slate-100 font-mono font-semibold"
                    style={{ fontSize: size * 0.28 }}
                >
                    {displayValue}{suffix}
                </text>
            </svg>
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
        </div>
    );
}
