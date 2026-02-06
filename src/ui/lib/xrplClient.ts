/**
 * Web API XRPL Client
 * 
 * Re-exports the shared client singleton from src/xrpl/sharedClient.ts
 * This ensures the Next.js API routes use the same client management
 * with endpoint failover and 429 cooldown.
 * 
 * Also provides price caching to reduce XRPL requests.
 */

import { Client } from 'xrpl';
import {
    getXrplClient,
    disconnectXrplClient,
    getConnectionState,
    isConnected,
    getCurrentEndpoint,
    ConnectionState,
} from '../../xrpl/sharedClient';

// Re-export shared client functions
export {
    getXrplClient,
    disconnectXrplClient,
    getConnectionState,
    isConnected,
    getCurrentEndpoint,
};
export type { ConnectionState };

// =============================================================================
// Legacy API - Backwards Compatibility
// =============================================================================

/**
 * Get shared XRPL client.
 * @param _endpoint Ignored - endpoint is managed by sharedClient singleton
 * @deprecated Use getXrplClient() directly
 */
export async function getSharedClient(_endpoint?: string): Promise<Client> {
    return getXrplClient();
}

/**
 * Disconnect shared client.
 * @deprecated Use disconnectXrplClient() directly
 */
export async function disconnectSharedClient(): Promise<void> {
    return disconnectXrplClient();
}

// =============================================================================
// Price Cache
// =============================================================================

interface PriceCacheEntry {
    data: {
        midPrice: number;
        bidPrice: number;
        askPrice: number;
        spreadBps: number;
    };
    timestamp: number;
}

const priceCache: Map<string, PriceCacheEntry> = new Map();
const PRICE_CACHE_TTL = 3000; // 3 seconds cache

/**
 * Get cached price data if still valid.
 */
export function getCachedPrice(pair: string): PriceCacheEntry['data'] | null {
    const cached = priceCache.get(pair);
    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
        return cached.data;
    }
    return null;
}

/**
 * Store price data in cache.
 */
export function setCachedPrice(pair: string, data: PriceCacheEntry['data']): void {
    priceCache.set(pair, { data, timestamp: Date.now() });
}

/**
 * Clear price cache.
 */
export function clearPriceCache(): void {
    priceCache.clear();
}

// =============================================================================
// Health Check Helpers
// =============================================================================

/**
 * Get connection health for API health endpoints.
 */
export function getClientHealth(): {
    connected: boolean;
    endpoint: string | null;
    lastError: string | null;
    reconnects: number;
    cooldowns: Record<string, number>;
    endpointPool: string[];
} {
    const state = getConnectionState();
    return {
        connected: state.connected,
        endpoint: state.endpoint,
        lastError: state.lastError,
        reconnects: state.reconnects,
        cooldowns: state.cooldowns,
        endpointPool: state.endpointPool,
    };
}
