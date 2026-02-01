import { Client } from 'xrpl';

/**
 * Shared XRPL client singleton to avoid rate limiting (429 errors)
 * Maintains a single persistent connection that's reused across API calls
 */

// Fallback XRPL endpoints (mainnet)
const XRPL_ENDPOINTS = [
    'wss://xrplcluster.com',
    'wss://s1.ripple.com',
    'wss://s2.ripple.com',
];

let sharedClient: Client | null = null;
let connectPromise: Promise<void> | null = null;
let lastConnectAttempt = 0;
let currentEndpointIndex = 0;
const MIN_RECONNECT_INTERVAL = 10000; // 10 seconds between reconnect attempts

// Price cache to reduce API calls
interface PriceCache {
    [pair: string]: {
        data: {
            midPrice: number;
            bidPrice: number;
            askPrice: number;
            spreadBps: number;
        };
        timestamp: number;
    };
}

const priceCache: PriceCache = {};
const PRICE_CACHE_TTL = 3000; // 3 seconds cache

export function getCachedPrice(pair: string) {
    const cached = priceCache[pair];
    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
        return cached.data;
    }
    return null;
}

export function setCachedPrice(pair: string, data: PriceCache[string]['data']) {
    priceCache[pair] = { data, timestamp: Date.now() };
}

export async function getSharedClient(endpoint: string): Promise<Client> {
    // If we have a connected client, return it
    if (sharedClient?.isConnected()) {
        return sharedClient;
    }

    // Rate limit reconnection attempts
    const now = Date.now();
    if (now - lastConnectAttempt < MIN_RECONNECT_INTERVAL) {
        throw new Error('Rate limited - please wait before retrying');
    }

    // If already connecting, wait for that
    if (connectPromise) {
        await connectPromise;
        if (sharedClient?.isConnected()) {
            return sharedClient;
        }
    }

    lastConnectAttempt = now;

    // Try endpoints in order, starting with the provided one or cycling through fallbacks
    const endpointsToTry = endpoint.includes('xrplcluster')
        ? XRPL_ENDPOINTS.slice(currentEndpointIndex).concat(XRPL_ENDPOINTS.slice(0, currentEndpointIndex))
        : [endpoint, ...XRPL_ENDPOINTS];

    // Connect with promise deduplication
    connectPromise = (async () => {
        for (let i = 0; i < endpointsToTry.length; i++) {
            const ep = endpointsToTry[i];
            try {
                console.log(`[XRPL] Trying endpoint: ${ep}`);
                sharedClient = new Client(ep, { connectionTimeout: 15000 });
                await sharedClient.connect();
                console.log(`[XRPL] Shared client connected to ${ep}`);
                // Update index for next time
                currentEndpointIndex = XRPL_ENDPOINTS.indexOf(ep);
                if (currentEndpointIndex === -1) currentEndpointIndex = 0;
                return;
            } catch (err: any) {
                console.error(`[XRPL] Failed to connect to ${ep}:`, err?.message || err);
                sharedClient = null;
                // Try next endpoint
            }
        }
        // All endpoints failed
        throw new Error('All XRPL endpoints failed');
    })();

    try {
        await connectPromise;
        return sharedClient!;
    } finally {
        connectPromise = null;
    }
}

export async function disconnectSharedClient() {
    if (sharedClient?.isConnected()) {
        await sharedClient.disconnect();
    }
    sharedClient = null;
    connectPromise = null;
}
