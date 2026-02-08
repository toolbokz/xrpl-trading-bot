'use client';

/**
 * Tiny inline SVG sparkline — renders a polyline with an optional
 * gradient fill. Used for balance history, mini price previews, etc.
 */
export interface SparklineProps {
    /** Y-values to plot (evenly spaced along X) */
    data: number[];
    /** Width in px (default 80) */
    width?: number;
    /** Height in px (default 24) */
    height?: number;
    /** Stroke color (CSS value, default #22c55e) */
    color?: string;
    /** Whether to fill below the line (default false) */
    fill?: boolean;
    /** Line width (default 1.5) */
    strokeWidth?: number;
    /** Additional CSS class */
    className?: string;
}

export function Sparkline({
    data,
    width = 80,
    height = 24,
    color = '#22c55e',
    fill = false,
    strokeWidth = 1.5,
    className = '',
}: SparklineProps) {
    if (!data || data.length < 2) {
        return <svg width={width} height={height} className={className} />;
    }

    const pad = strokeWidth;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    const points = data.map((v, i) => {
        const x = pad + (i / (data.length - 1)) * w;
        const y = pad + h - ((v - min) / range) * h;
        return `${x},${y}`;
    });

    const polyline = points.join(' ');

    // Gradient fill path: polyline + bottom-right + bottom-left
    const fillPath = fill
        ? `M ${points[0]} ` +
        points.slice(1).map(p => `L ${p}`).join(' ') +
        ` L ${pad + w},${pad + h} L ${pad},${pad + h} Z`
        : undefined;

    const gradientId = `spark-grad-${Math.random().toString(36).slice(2, 8)}`;

    // Determine color direction: last > first = green, else red
    const trendColor = data[data.length - 1]! >= data[0]! ? color : '#ef4444';

    return (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width={width} height={height} className={className}>
            {fill && (
                <>
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={trendColor} stopOpacity={0.25} />
                            <stop offset="100%" stopColor={trendColor} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <path d={fillPath} fill={`url(#${gradientId})`} />
                </>
            )}
            <polyline
                points={polyline}
                fill="none"
                stroke={trendColor}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
