'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { MockDataBanner } from '../MockDataBanner';
import { ToastContainer } from '../TradeToasts/ToastContainer';

interface AppShellProps {
    /** Header content (typically TerminalHeader) */
    header: ReactNode;
    /** Main content area */
    children: ReactNode;
    /** Additional className for the shell */
    className?: string;
    /** Feature flag for trade toast notifications */
    tradeToastsEnabled?: boolean;
}

/**
 * AppShell - Scrollable viewport container for the trading dashboard.
 *
 * Tight 40px header, minimal chrome, maximum data density.
 */
export function AppShell({ header, children, className, tradeToastsEnabled = false }: AppShellProps) {
    return (
        <div
            className={clsx(
                'min-h-screen w-full overflow-x-hidden overflow-y-auto',
                'bg-surface',
                'flex flex-col',
                className
            )}
        >
            <MockDataBanner />

            {/* Thin sticky header — 40px */}
            <header className="h-10 shrink-0 px-3 sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-white/[0.04]">
                {header}
            </header>

            {/* Content — balanced padding */}
            <main className="flex-1 px-5 py-2">
                {children}
            </main>

            {tradeToastsEnabled && <ToastContainer enabled={tradeToastsEnabled} />}
        </div>
    );
}

export default AppShell;
