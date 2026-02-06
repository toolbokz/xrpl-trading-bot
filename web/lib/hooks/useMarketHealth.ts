/**
 * useMarketHealth hook - polls /api/market/health for data freshness indicators.
 *
 * Accepts an optional pairKey for pair-truth validation: when the runtime
 * reports a pairKey in the health response, the hook rejects data that belongs
 * to a different pair.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// =============================================================================
// Types (mirror API response)
// =============================================================================

interface XrplHealth {
    connected: boolean;
    endpoint: string | null;
    lastError: string | null;
    reconnects: number;
    cooldowns: Record<string, number>;
    endpointPool: string[];
}

interface OrderBookHealth {
    available: boolean;
    lastUpdated: number | null;
    ageMs: number | null;
    stale: boolean;
}

interface TradeTapeHealth {
    available: boolean;
    lastUpdated: number | null;
    ageMs: number | null;
    stale: boolean;
    tradeCount1m: number;
    tradeCount5m: number;
}

interface CandlesHealth {
    source: 'live' | 'historical' | 'empty' | 'unknown';
    lastUpdated: number | null;
    ageMs: number | null;
    stale: boolean;
}

interface OverallHealth {
    healthy: boolean;
    warnings: string[];
}

export interface MarketHealthData {
    timestamp: number;
    xrpl: XrplHealth;
    orderBook: OrderBookHealth;
    tradeTape: TradeTapeHealth;
    candles: CandlesHealth;
    overall: OverallHealth;
    network: 'mainnet' | 'testnet';
    /** Pair key reported by the runtime (may be absent in dual-process mode). */
    pairKey?: string;
}

export interface UseMarketHealthState {
    data: MarketHealthData | null;
    loading: boolean;
    error: string | null;
    lastFetchedAt: number | null;
    /** True when the last response was rejected because it carried a different pairKey. */
    rejected: boolean;
}

export interface UseMarketHealthOptions {
    /** Polling interval in ms (default 5 000). */
    pollInterval?: number;
    /** Maximum acceptable data age in ms (default 30 000). */
    maxStalenessMs?: number;
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_STALENESS_MS = 30_000;
const API_ENDPOINT = '/api/market/health';

// =============================================================================
// Hook
// =============================================================================

export function useMarketHealth(
    pairKey?: string | null,
    options: UseMarketHealthOptions = {},
): UseMarketHealthState {
    const {
        pollInterval = DEFAULT_POLL_INTERVAL_MS,
        maxStalenessMs = DEFAULT_MAX_STALENESS_MS,
    } = options;

    const [state, setState] = useState<UseMarketHealthState>({
        data: null,
        loading: true,
        error: null,
        lastFetchedAt: null,
        rejected: false,
    });

    // Stable ref to latest pairKey so the fetch callback doesn't trigger re-creation
    const pairKeyRef = useRef(pairKey);
    pairKeyRef.current = pairKey;

    const fetchHealth = useCallback(async () => {
        try {
            const response = await fetch(API_ENDPOINT);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const data: MarketHealthData = await response.json();

            // Pair-truth validation: if both sides specify a pairKey, they must match
            const currentPairKey = pairKeyRef.current;
            if (currentPairKey && data.pairKey && data.pairKey !== currentPairKey) {
                setState(prev => ({
                    ...prev,
                    loading: false,
                    rejected: true,
                }));
                return;
            }

            // Staleness validation: reject if data timestamp is too old
            const age = Date.now() - data.timestamp;
            if (age > maxStalenessMs) {
                setState(prev => ({
                    ...prev,
                    loading: false,
                    rejected: true,
                }));
                return;
            }

            setState({
                data,
                loading: false,
                error: null,
                lastFetchedAt: Date.now(),
                rejected: false,
            });
        } catch (err) {
            setState(prev => ({
                ...prev,
                loading: false,
                error: err instanceof Error ? err.message : 'Unknown error',
            }));
        }
    }, [maxStalenessMs]);

    // Reset on pair change
    useEffect(() => {
        setState({
            data: null,
            loading: true,
            error: null,
            lastFetchedAt: null,
            rejected: false,
        });
    }, [pairKey]);

    useEffect(() => {
        // Initial fetch
        fetchHealth();

        // Set up polling
        const interval = setInterval(fetchHealth, pollInterval);

        return () => clearInterval(interval);
    }, [fetchHealth, pollInterval]);

    return state;
}
