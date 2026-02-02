/**
 * PairSelector Component
 * 
 * A dropdown selector for trading pairs that fetches from the API
 * and displays liquidity/network badges.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
    fetchPairs,
    fetchPairSummary,
    PairListItem,
    PairSummary,
    formatPrice,
    formatSpreadBps,
    getLiquidityColor,
    getNetworkColor,
    ApiError,
} from '../lib/apiClient';

interface PairSelectorProps {
    selectedPair: string;
    onPairChange: (pairKey: string) => void;
    onSummaryUpdate?: (summary: PairSummary | null) => void;
    className?: string;
    disabled?: boolean;
}

export function PairSelector({
    selectedPair,
    onPairChange,
    onSummaryUpdate,
    className,
    disabled = false,
}: PairSelectorProps) {
    const [pairs, setPairs] = useState<PairListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Load pairs on mount
    useEffect(() => {
        let cancelled = false;

        const loadPairs = async () => {
            try {
                setLoading(true);
                setError(null);
                const response = await fetchPairs();
                if (!cancelled) {
                    // Handle both array and object responses
                    const pairsList = Array.isArray(response) ? response : (response as any).pairs;
                    setPairs(pairsList || []);
                }
            } catch (err) {
                if (!cancelled) {
                    const message = err instanceof ApiError ? err.message : 'Failed to load pairs';
                    setError(message);
                    console.error('Failed to load pairs:', err);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadPairs();

        return () => {
            cancelled = true;
        };
    }, []);

    const handleChange = useCallback(
        (event: React.ChangeEvent<HTMLSelectElement>) => {
            const key = event.target.value;
            onPairChange(key);
        },
        [onPairChange]
    );

    const currentPair = pairs.find((p) => p.key === selectedPair);

    if (error) {
        return (
            <div className={clsx('text-danger text-sm', className)}>
                Error: {error}
            </div>
        );
    }

    return (
        <div className={clsx('flex items-center gap-2', className)}>
            <select
                value={selectedPair}
                onChange={handleChange}
                disabled={disabled || loading}
                className={clsx(
                    'bg-card border border-slate-700 rounded-lg px-3 py-2',
                    'text-white text-sm font-medium',
                    'focus:outline-none focus:ring-2 focus:ring-accent/50',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'min-w-[160px]'
                )}
            >
                {loading ? (
                    <option value="">Loading...</option>
                ) : (
                    <>
                        <option value="">Select pair</option>
                        {pairs.map((pair) => (
                            <option key={pair.key} value={pair.key}>
                                {pair.key}
                            </option>
                        ))}
                    </>
                )}
            </select>

            {currentPair && (
                <div className="flex items-center gap-2">
                    <span
                        className={clsx(
                            'px-2 py-0.5 rounded text-xs font-medium',
                            getLiquidityColor(currentPair.liquidity)
                        )}
                    >
                        {currentPair.liquidity}
                    </span>
                    <span
                        className={clsx(
                            'px-2 py-0.5 rounded text-xs font-medium',
                            getNetworkColor(currentPair.network)
                        )}
                    >
                        {currentPair.network}
                    </span>
                </div>
            )}
        </div>
    );
}

// =============================================================================
// PriceSummary Component
// =============================================================================

interface PriceSummaryProps {
    pairKey: string;
    onUpdate?: ((summary: PairSummary | null) => void) | undefined;
    refreshInterval?: number | undefined;
    className?: string | undefined;
}

export function PriceSummary({
    pairKey,
    onUpdate,
    refreshInterval = 5000,
    className,
}: PriceSummaryProps) {
    const [summary, setSummary] = useState<PairSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!pairKey) {
            setSummary(null);
            onUpdate?.(null);
            return;
        }

        let cancelled = false;

        const fetchSummary = async () => {
            try {
                setLoading(true);
                setError(null);
                const data = await fetchPairSummary(pairKey);
                if (!cancelled) {
                    setSummary(data);
                    onUpdate?.(data);
                }
            } catch (err) {
                if (!cancelled) {
                    const message = err instanceof ApiError ? err.message : 'Failed to load price';
                    setError(message);
                    setSummary(null);
                    onUpdate?.(null);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        // Initial fetch
        fetchSummary();

        // Set up polling
        const intervalId = setInterval(fetchSummary, refreshInterval);

        return () => {
            cancelled = true;
            clearInterval(intervalId);
        };
    }, [pairKey, refreshInterval, onUpdate]);

    if (!pairKey) {
        return null;
    }

    if (error) {
        return (
            <div className={clsx('text-danger text-sm', className)}>
                {error}
            </div>
        );
    }

    if (loading && !summary) {
        return (
            <div className={clsx('animate-pulse', className)}>
                <div className="h-6 bg-slate-700 rounded w-32"></div>
            </div>
        );
    }

    if (!summary) {
        return null;
    }

    const quoteCurrency = pairKey.split('/')[1];

    return (
        <div className={clsx('flex flex-col gap-1', className)}>
            {/* Unavailable warning */}
            {!summary.availableOnNetwork && (
                <div className="bg-danger/20 text-danger text-xs px-2 py-1 rounded">
                    ⚠️ Not available on {summary.network}
                </div>
            )}

            {/* Price display */}
            <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                    <span className="text-slate-400 text-xs">Bid</span>
                    <div className="text-success font-mono">
                        {summary.bid > 0 ? formatPrice(summary.bid, quoteCurrency) : '—'}
                    </div>
                </div>
                <div>
                    <span className="text-slate-400 text-xs">Mid</span>
                    <div className="text-white font-mono font-medium">
                        {summary.midPrice > 0 ? formatPrice(summary.midPrice, quoteCurrency) : '—'}
                    </div>
                </div>
                <div>
                    <span className="text-slate-400 text-xs">Ask</span>
                    <div className="text-danger font-mono">
                        {summary.ask > 0 ? formatPrice(summary.ask, quoteCurrency) : '—'}
                    </div>
                </div>
            </div>

            {/* Spread */}
            <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">Spread:</span>
                <span
                    className={clsx(
                        'font-mono',
                        summary.spreadBps < 10
                            ? 'text-success'
                            : summary.spreadBps < 50
                                ? 'text-yellow-400'
                                : 'text-danger'
                    )}
                >
                    {formatSpreadBps(summary.spreadBps)} bps
                </span>
                {summary.cached && (
                    <span className="text-slate-500">(cached)</span>
                )}
            </div>

            {/* Warnings */}
            {summary.warnings.length > 0 && (
                <div className="text-yellow-400 text-xs">
                    {summary.warnings.map((w, i) => (
                        <div key={i}>⚠️ {w}</div>
                    ))}
                </div>
            )}
        </div>
    );
}

// =============================================================================
// Combined PairControl Component
// =============================================================================

interface PairControlProps {
    selectedPair: string;
    onPairChange: (pairKey: string) => void;
    onSummaryUpdate?: (summary: PairSummary | null) => void;
    refreshInterval?: number;
    className?: string;
    disabled?: boolean;
}

export function PairControl({
    selectedPair,
    onPairChange,
    onSummaryUpdate,
    refreshInterval = 5000,
    className,
    disabled = false,
}: PairControlProps) {
    return (
        <div className={clsx('flex flex-col gap-3', className)}>
            <PairSelector
                selectedPair={selectedPair}
                onPairChange={onPairChange}
                disabled={disabled}
            />
            {selectedPair && (
                <PriceSummary
                    pairKey={selectedPair}
                    onUpdate={onSummaryUpdate}
                    refreshInterval={refreshInterval}
                />
            )}
        </div>
    );
}
