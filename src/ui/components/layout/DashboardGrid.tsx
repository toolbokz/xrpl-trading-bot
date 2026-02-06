'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Grid area names for placing panels.
 * The grid is organized into logical areas that can be populated
 * with trading dashboard components.
 */
export type GridArea =
    | 'flow'        // Left sidebar: Flow metrics (narrow)
    | 'chart'       // Center top: Price chart (wide)
    | 'book'        // Left: Order book
    | 'tape'        // Center bottom: Trade tape
    | 'controls'    // Right top: Controls & config
    | 'stats'       // Right: Market stats
    | 'logs'        // Right bottom: System logs
    | 'analytics'   // Far right sidebar: Analytics (narrow)
    | 'heatmap'     // Analytics: Regime heatmap
    | 'governance'  // Analytics: Governance
    | 'adaptive';   // Analytics: Adaptive learning

interface DashboardGridProps {
    children: ReactNode;
    className?: string;
}

/**
 * DashboardGrid - Professional trading terminal layout using CSS Grid.
 * 
 * Desktop (≥1280px): 4-column layout
 *   - Left sidebar (flow metrics): 200px
 *   - Main left column (order book): 280px
 *   - Center (chart + tape): 1fr (flexible)
 *   - Right column (controls, stats, logs): 300px
 *   - Right sidebar (analytics): 280px
 * 
 * Medium (1024-1280px): 3-column collapsed layout
 *   - Flow metrics become horizontal bar at top
 *   - Main content in 3 columns
 * 
 * Small (<1024px): Single column (handled by MobileDashboard)
 */
export function DashboardGrid({ children, className }: DashboardGridProps) {
    return (
        <div
            className={clsx(
                'h-full w-full',
                // CSS Grid with explicit areas
                'grid gap-3',
                // Large desktop (≥1440px): Full 5-column layout
                'xl:grid-cols-[200px_280px_1fr_280px_260px]',
                'xl:grid-rows-[1fr_1fr]',
                // Medium desktop (1280-1440px): Narrower sidebars
                'lg:grid-cols-[180px_260px_1fr_260px_240px] lg:grid-rows-[1fr_1fr]',
                // Tablet landscape (1024-1280px): 3-column, no sidebars
                'md:grid-cols-[280px_1fr_280px] md:grid-rows-[auto_1fr_1fr]',
                // Default: vertical stack (will be replaced by MobileDashboard)
                'grid-cols-1 grid-rows-none',
                // Ensure children can shrink
                'min-h-0 min-w-0 overflow-hidden',
                className
            )}
            style={{
                // Named grid areas for large desktop
                gridTemplateAreas: `
                    "flow book chart controls analytics"
                    "flow book tape  stats    analytics"
                `,
            }}
        >
            {children}
        </div>
    );
}

interface GridCellProps {
    area: GridArea;
    children: ReactNode;
    className?: string;
    /** Span multiple rows (used for sidebars) */
    rowSpan?: number;
    /** Hide on certain breakpoints */
    hideBelow?: 'md' | 'lg' | 'xl';
}

/**
 * GridCell - Places content in a specific grid area.
 * Handles responsive visibility and grid positioning.
 */
export function GridCell({ area, children, className, rowSpan, hideBelow }: GridCellProps) {
    const hideClasses = hideBelow
        ? {
            md: 'hidden md:block',
            lg: 'hidden lg:block',
            xl: 'hidden xl:block',
        }[hideBelow]
        : '';

    return (
        <div
            className={clsx(
                // Ensure proper sizing for flex children
                'min-h-0 min-w-0 overflow-hidden',
                // Responsive visibility
                hideClasses,
                className
            )}
            style={{
                gridArea: area,
                gridRow: rowSpan ? `span ${rowSpan}` : undefined,
            }}
        >
            {children}
        </div>
    );
}

/**
 * Alternative simpler grid for specific viewport sizes.
 * Used when we need more control over individual layouts.
 */
interface SimpleGridProps {
    children: ReactNode;
    columns?: number;
    gap?: number;
    className?: string;
}

export function SimpleGrid({ children, columns = 3, gap = 3, className }: SimpleGridProps) {
    return (
        <div
            className={clsx(
                'h-full w-full grid min-h-0 min-w-0 overflow-hidden',
                className
            )}
            style={{
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: `${gap * 0.25}rem`,
            }}
        >
            {children}
        </div>
    );
}

export default DashboardGrid;
