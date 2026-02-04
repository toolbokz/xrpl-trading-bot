'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';

interface AppShellProps {
    /** Header content (typically TerminalHeader) */
    header: ReactNode;
    /** Main content area */
    children: ReactNode;
    /** Additional className for the shell */
    className?: string;
}

/**
 * AppShell - Full viewport container for the trading dashboard.
 * 
 * Creates a fixed viewport layout with:
 * - Sticky header (64px)
 * - Main content area fills remaining viewport height
 * - No body scrolling on desktop
 * - Smooth scrolling on mobile when needed
 */
export function AppShell({ header, children, className }: AppShellProps) {
    return (
        <div
            className={clsx(
                // Full viewport sizing - prevents any body scroll
                'h-screen w-screen overflow-hidden',
                // Dark background
                'bg-surface',
                // Flex column layout
                'flex flex-col',
                className
            )}
        >
            {/* Fixed header area - 64px tall */}
            <header className="h-16 shrink-0 px-3 py-2">
                {header}
            </header>

            {/* Main content area - fills remaining height */}
            <main className="flex-1 min-h-0 overflow-hidden px-3 pb-3">
                {children}
            </main>
        </div>
    );
}

export default AppShell;
