/**
 * MockDataBanner Component
 * 
 * Displays a warning banner when mock data is enabled in development.
 * This component should be rendered at the top of the dashboard.
 */

'use client';

import { UI_MOCK_DATA_ENABLED } from '../lib/mockDataConfig';

export function MockDataBanner(): JSX.Element | null {
    // Never render in production or when mock data is disabled
    if (!UI_MOCK_DATA_ENABLED) {
        return null;
    }

    return (
        <div className="bg-amber-500/90 text-black px-4 py-2 text-center text-sm font-semibold flex items-center justify-center gap-2">
            <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
            </svg>
            <span>MOCK DATA MODE</span>
            <span className="font-normal">— Chart and order book data is simulated for development</span>
        </div>
    );
}

/**
 * Small badge version for inline display
 */
export function MockDataBadge(): JSX.Element | null {
    if (!UI_MOCK_DATA_ENABLED) {
        return null;
    }

    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
            <svg
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01"
                />
            </svg>
            MOCK
        </span>
    );
}
