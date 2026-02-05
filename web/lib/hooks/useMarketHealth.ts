/**
 * useMarketHealth hook - polls /api/market/health for data freshness indicators.
 */

import { useCallback, useEffect, useState } from 'react';

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
}

export interface UseMarketHealthState {
    data: MarketHealthData | null;
    loading: boolean;
    error: string | null;
    lastFetchedAt: number | null;
}

// =============================================================================
// Configuration
// =============================================================================

const POLL_INTERVAL_MS = 5_000; // Poll every 5 seconds
const API_ENDPOINT = '/api/market/health';

// =============================================================================
// Hook
// =============================================================================

export function useMarketHealth(): UseMarketHealthState {
    const [state, setState] = useState<UseMarketHealthState>({
        data: null,
        loading: true,
        error: null,
        lastFetchedAt: null,
    });

    const fetchHealth = useCallback(async () => {
        try {
            const response = await fetch(API_ENDPOINT);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const data: MarketHealthData = await response.json();

            setState({
                data,
                loading: false,
                error: null,
                lastFetchedAt: Date.now(),
            });
        } catch (err) {
            setState(prev => ({
                ...prev,
                loading: false,
                error: err instanceof Error ? err.message : 'Unknown error',
            }));
        }
    }, []);

    useEffect(() => {
        // Initial fetch
        fetchHealth();

        // Set up polling
        const interval = setInterval(fetchHealth, POLL_INTERVAL_MS);

        return () => clearInterval(interval);
    }, [fetchHealth]);

    return state;
}
