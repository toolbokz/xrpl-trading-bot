'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { PairListItem, AvailabilityVerdict } from '../lib/apiClient';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface InstrumentSelectorProps {
    /** Currently selected pair key (e.g., "XRP/RLUSD"). */
    selectedPairKey: string;
    /** Called when the user selects a different pair. */
    onPairChange: (pairKey: string) => void;
    /** Polling interval for refreshing pair data (ms). Default: 10000. */
    pollInterval?: number;
    /** Whether selector interactions are disabled. */
    disabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability Badge
// ─────────────────────────────────────────────────────────────────────────────

function availabilityBadge(verdict: AvailabilityVerdict | null): {
    label: string;
    className: string;
    dot: string;
} {
    switch (verdict) {
        case 'AVAILABLE':
            return {
                label: 'OK',
                className: 'text-emerald-400',
                dot: 'bg-emerald-400',
            };
        case 'DEGRADED':
            return {
                label: 'Degraded',
                className: 'text-amber-400',
                dot: 'bg-amber-400',
            };
        case 'UNAVAILABLE':
            return {
                label: 'Unavail',
                className: 'text-red-400',
                dot: 'bg-red-400',
            };
        case 'BLOCKED':
            return {
                label: 'Blocked',
                className: 'text-red-500',
                dot: 'bg-red-500',
            };
        case 'UNKNOWN':
        case null:
        default:
            return {
                label: '—',
                className: 'text-slate-500',
                dot: 'bg-slate-600',
            };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function InstrumentSelector({
    selectedPairKey,
    onPairChange,
    pollInterval = 10_000,
    disabled = false,
}: InstrumentSelectorProps) {
    const [pairs, setPairs] = useState<PairListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Fetch pairs from /api/pairs
    const fetchPairs = useCallback(async () => {
        try {
            const res = await fetch('/api/pairs');
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            setPairs(data.pairs ?? []);
            setError(null);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to fetch pairs';
            setError(msg);
        } finally {
            setLoading(false);
        }
    }, []);

    // Initial fetch + polling
    useEffect(() => {
        fetchPairs();
        const interval = setInterval(fetchPairs, pollInterval);
        return () => clearInterval(interval);
    }, [fetchPairs, pollInterval]);

    // Currently selected pair's availability
    const selectedPair = useMemo(
        () => pairs.find((p) => p.key === selectedPairKey),
        [pairs, selectedPairKey],
    );
    const selectedBadge = useMemo(
        () => availabilityBadge(selectedPair?.availability ?? null),
        [selectedPair],
    );

    // Sort: active first, then available, then degraded, then rest
    const sortedPairs = useMemo(() => {
        const verdictOrder: Record<string, number> = {
            AVAILABLE: 0,
            DEGRADED: 1,
            UNKNOWN: 2,
            UNAVAILABLE: 3,
            BLOCKED: 4,
        };
        return [...pairs].sort((a, b) => {
            // Active pair always first
            if (a.active && !b.active) return -1;
            if (!a.active && b.active) return 1;
            // Then by availability
            const aOrder = verdictOrder[a.availability ?? 'UNKNOWN'] ?? 2;
            const bOrder = verdictOrder[b.availability ?? 'UNKNOWN'] ?? 2;
            if (aOrder !== bOrder) return aOrder - bOrder;
            // Then alphabetical
            return a.key.localeCompare(b.key);
        });
    }, [pairs]);

    if (loading && pairs.length === 0) {
        return (
            <div className="w-full rounded-lg bg-slate-900 border border-white/10 px-3 py-2 text-sm text-slate-500">
                Loading pairs...
            </div>
        );
    }

    return (
        <div className="w-full">
            {/* Select dropdown with availability indicator */}
            <div className="relative">
                <select
                    value={selectedPairKey}
                    onChange={(e) => onPairChange(e.target.value)}
                    disabled={disabled}
                    className={clsx(
                        'w-full rounded-lg bg-slate-900 border px-3 py-2 pr-8 text-sm text-slate-100',
                        'focus:outline-none focus:ring-1 focus:ring-sky-500 appearance-none',
                        disabled
                            ? 'border-white/5 opacity-50 cursor-not-allowed'
                            : 'border-white/10 cursor-pointer hover:border-white/20',
                    )}
                >
                    <option value="" disabled>
                        Select pair...
                    </option>
                    {sortedPairs.map((pair) => {
                        const badge = availabilityBadge(pair.availability);
                        const isBlocked = pair.availability === 'BLOCKED';
                        return (
                            <option
                                key={pair.key}
                                value={pair.key}
                                disabled={isBlocked}
                            >
                                {pair.key}
                                {pair.availability ? ` [${badge.label}]` : ''}
                                {pair.active ? ' ●' : ''}
                            </option>
                        );
                    })}
                </select>
                {/* Dropdown arrow */}
                <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                    <svg
                        className="h-4 w-4 text-slate-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth="2"
                        stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
            </div>

            {/* Availability status bar below selector */}
            {selectedPairKey && (
                <div className="flex items-center gap-1.5 mt-1.5 px-1">
                    <span
                        className={clsx(
                            'inline-block h-1.5 w-1.5 rounded-full',
                            selectedBadge.dot,
                        )}
                    />
                    <span className={clsx('text-[10px] font-medium', selectedBadge.className)}>
                        {selectedBadge.label}
                    </span>
                    {selectedPair?.liquidity && (
                        <span className="text-[10px] text-slate-600 ml-auto">
                            {selectedPair.liquidity}
                        </span>
                    )}
                </div>
            )}

            {/* Error indicator */}
            {error && (
                <div className="text-[10px] text-red-400/70 mt-1 px-1 truncate">
                    ⚠ {error}
                </div>
            )}
        </div>
    );
}
