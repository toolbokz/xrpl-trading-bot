/**
 * Shared XRPL Client Singleton
 * 
 * Provides a single, reusable XRPL client per Node.js process with:
 * - Endpoint pool & failover (429 cooldown)
 * - Exponential backoff with jitter
 * - Connection de-duplication (single in-flight connect promise)
 * - Automatic reconnection on disconnect
 * 
 * Usage:
 *   import { getXrplClient, disconnectXrplClient, getConnectionState } from './sharedClient';
 *   const client = await getXrplClient();
 *   // use client...
 * 
 * SINGLE_PROCESS_MODE Guard:
 *   When SINGLE_PROCESS_MODE=true AND called from an API route context,
 *   getXrplClient() will throw to prevent accidental dual connections.
 *   API routes should use runtimeBridge instead.
 */

import { Client } from 'xrpl';
import { logger } from '../analytics/logger';
import { isAuditGuardsEnabled } from '../config/featureFlags';
import { assertNoDirectXrplCallsInSingleProcess, getRequestContext, isApiRouteContext, isRequestContext } from './guard';

// =============================================================================
// Configuration
// =============================================================================

/** Default XRPL endpoints (mainnet) */
const DEFAULT_ENDPOINTS = [
    'wss://xrplcluster.com',
    'wss://s1.ripple.com',
    'wss://s2.ripple.com',
];

/** Parse endpoint list from environment or config */
function parseEndpoints(): string[] {
    // Support XRPL_WSS_URLS (comma-separated list) or fallback to XRPL_WSS_URL / XRPL_ENDPOINT
    const urlList = process.env.XRPL_WSS_URLS;
    if (urlList) {
        const parsed = urlList.split(',').map(s => s.trim()).filter(Boolean);
        if (parsed.length > 0) return parsed;
    }

    const singleUrl = process.env.XRPL_WSS_URL || process.env.XRPL_ENDPOINT;
    if (singleUrl) {
        // If it's a comma-separated list, parse it
        if (singleUrl.includes(',')) {
            const parsed = singleUrl.split(',').map(s => s.trim()).filter(Boolean);
            if (parsed.length > 0) return parsed;
        }
        return [singleUrl];
    }

    return DEFAULT_ENDPOINTS;
}

/** Configuration constants from environment */
const CONFIG = {
    /** Cooldown period for 429'd endpoints (default: 10 minutes) */
    cooldown429Ms: parseInt(process.env.XRPL_429_COOLDOWN_MS || '600000', 10),
    /** Connection timeout (default: 10 seconds) */
    connectTimeoutMs: parseInt(process.env.XRPL_CONNECT_TIMEOUT_MS || '10000', 10),
    /** Maximum reconnect delay (default: 30 seconds) */
    maxReconnectDelayMs: parseInt(process.env.XRPL_MAX_RECONNECT_DELAY_MS || '30000', 10),
    /** Initial reconnect delay (default: 500ms) */
    initialReconnectDelayMs: parseInt(process.env.XRPL_INITIAL_RECONNECT_DELAY_MS || '500', 10),
    /** Multiplier for 429 errors (aggressive backoff) */
    backoff429Multiplier: parseFloat(process.env.XRPL_BACKOFF_429_MULTIPLIER || '3'),
    /** Minimum delay between connection attempts */
    minConnectIntervalMs: parseInt(process.env.XRPL_MIN_CONNECT_INTERVAL_MS || '1000', 10),
};

// =============================================================================
// Types
// =============================================================================

export interface ConnectionState {
    connected: boolean;
    endpoint: string | null;
    lastError: string | null;
    reconnects: number;
    cooldowns: Record<string, number>; // endpoint -> cooldown until timestamp
    endpointPool: string[];
}

interface EndpointState {
    url: string;
    cooldownUntil: number; // timestamp when cooldown expires (0 = no cooldown)
    failures: number;
    lastAttempt: number;
}

export class MissingApiRouteContextError extends Error {
    constructor(context: string, requestId?: string) {
        super(
            `[XRPL Guard] Missing API route context for shared XRPL client access. ` +
            `Context: ${context}.${requestId ? ` RequestId: ${requestId}.` : ''}`
        );
        this.name = 'MissingApiRouteContextError';
    }
}

// =============================================================================
// State
// =============================================================================

let sharedClient: Client | null = null;
let connectPromise: Promise<Client> | null = null;
let currentEndpoint: string | null = null;
let lastError: string | null = null;
let reconnectCount = 0;
let lastConnectAttempt = 0;
let backoffDelay = CONFIG.initialReconnectDelayMs;
let isReconnecting = false;

/** Per-endpoint state tracking */
const endpointStates: Map<string, EndpointState> = new Map();

/** Get or create endpoint state */
function getEndpointState(url: string): EndpointState {
    let state = endpointStates.get(url);
    if (!state) {
        state = { url, cooldownUntil: 0, failures: 0, lastAttempt: 0 };
        endpointStates.set(url, state);
    }
    return state;
}

// =============================================================================
// Backoff & Jitter
// =============================================================================

/** Calculate next backoff delay with jitter */
function nextBackoff(current: number, is429: boolean): number {
    const multiplier = is429 ? CONFIG.backoff429Multiplier : 2;
    const next = Math.min(current * multiplier, CONFIG.maxReconnectDelayMs);
    // Add ±20% jitter
    const jitter = next * 0.2 * (Math.random() * 2 - 1);
    return Math.max(CONFIG.initialReconnectDelayMs, Math.round(next + jitter));
}

/** Reset backoff on successful connection */
function resetBackoff(): void {
    backoffDelay = CONFIG.initialReconnectDelayMs;
}

/** Sleep utility */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// =============================================================================
// Endpoint Selection
// =============================================================================

/** Get available endpoints (not in cooldown) sorted by preference */
function getAvailableEndpoints(): string[] {
    const now = Date.now();
    const endpoints = parseEndpoints();

    // Filter out endpoints in cooldown
    const available = endpoints.filter(url => {
        const state = getEndpointState(url);
        return state.cooldownUntil <= now;
    });

    // If all endpoints are in cooldown, return the one with earliest cooldown expiry
    if (available.length === 0) {
        const earliest = endpoints
            .map(url => ({ url, until: getEndpointState(url).cooldownUntil }))
            .sort((a, b) => a.until - b.until)[0];

        if (earliest) {
            logger.warn(
                { endpoint: earliest.url, cooldownUntil: new Date(earliest.until).toISOString() },
                '[XRPL] All endpoints in cooldown, using earliest to expire'
            );
            return [earliest.url];
        }
        return endpoints.slice(0, 1);
    }

    // Sort by fewest failures, then by least recent attempt
    return available.sort((a, b) => {
        const stateA = getEndpointState(a);
        const stateB = getEndpointState(b);
        if (stateA.failures !== stateB.failures) {
            return stateA.failures - stateB.failures;
        }
        return stateA.lastAttempt - stateB.lastAttempt;
    });
}

/** Mark endpoint as 429'd (rate limited) */
function mark429(url: string): void {
    const state = getEndpointState(url);
    state.cooldownUntil = Date.now() + CONFIG.cooldown429Ms;
    state.failures++;
    logger.warn(
        { endpoint: url, cooldownMs: CONFIG.cooldown429Ms, cooldownUntil: new Date(state.cooldownUntil).toISOString() },
        '[XRPL] Endpoint rate-limited (429), entering cooldown'
    );
}

/** Mark endpoint as failed (non-429 error) */
function markFailed(url: string, error: string): void {
    const state = getEndpointState(url);
    state.failures++;
    state.lastAttempt = Date.now();
    logger.debug({ endpoint: url, failures: state.failures, error }, '[XRPL] Endpoint failed');
}

/** Reset endpoint state on successful connection */
function markSuccess(url: string): void {
    const state = getEndpointState(url);
    state.failures = 0;
    state.lastAttempt = Date.now();
    // Don't clear cooldownUntil - let it expire naturally
}

// =============================================================================
// Connection Management
// =============================================================================

/** Check if an error indicates rate limiting (429) */
function is429Error(error: unknown): boolean {
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many');
    }
    return false;
}

/** Attempt to connect to a single endpoint */
async function tryConnect(url: string): Promise<Client> {
    const state = getEndpointState(url);
    state.lastAttempt = Date.now();

    logger.debug({ endpoint: url, timeout: CONFIG.connectTimeoutMs }, '[XRPL] Attempting connection');

    const client = new Client(url, { connectionTimeout: CONFIG.connectTimeoutMs });

    try {
        await client.connect();
        return client;
    } catch (err) {
        // Ensure client is cleaned up on failure
        try {
            if (client.isConnected()) await client.disconnect();
        } catch { /* ignore */ }
        throw err;
    }
}

/** Setup disconnect handler for automatic reconnection */
function setupAutoReconnect(client: Client): void {
    client.on('disconnected', async (code) => {
        logger.warn({ code, endpoint: currentEndpoint }, '[XRPL] Client disconnected');

        // Don't reconnect if we're already reconnecting or client was intentionally disconnected
        if (isReconnecting) return;
        if (!sharedClient) return;

        // Clear state
        sharedClient = null;

        // Trigger reconnect
        try {
            await getXrplClient();
        } catch (err) {
            logger.error({ err }, '[XRPL] Auto-reconnect failed');
        }
    });

    client.on('error', (err) => {
        logger.error({ err, endpoint: currentEndpoint }, '[XRPL] Client error');
        lastError = err instanceof Error ? err.message : String(err);
    });
}

/** Internal connect implementation with endpoint rotation */
async function connectInternal(): Promise<Client> {
    const endpoints = getAvailableEndpoints();

    if (endpoints.length === 0) {
        throw new Error('No XRPL endpoints configured');
    }

    let lastConnectError: Error | null = null;

    for (const endpoint of endpoints) {
        try {
            // Respect minimum interval between attempts
            const now = Date.now();
            const elapsed = now - lastConnectAttempt;
            if (elapsed < CONFIG.minConnectIntervalMs) {
                const waitMs = CONFIG.minConnectIntervalMs - elapsed;
                logger.debug({ waitMs }, '[XRPL] Throttling connection attempt');
                await sleep(waitMs);
            }
            lastConnectAttempt = Date.now();

            const client = await tryConnect(endpoint);

            // Success!
            currentEndpoint = endpoint;
            markSuccess(endpoint);
            resetBackoff();
            setupAutoReconnect(client);

            logger.info({ endpoint }, '[XRPL] Shared client connected');
            return client;

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            lastConnectError = err instanceof Error ? err : new Error(errorMsg);
            lastError = errorMsg;

            if (is429Error(err)) {
                mark429(endpoint);
                // Aggressive backoff for 429
                backoffDelay = nextBackoff(backoffDelay, true);
            } else {
                markFailed(endpoint, errorMsg);
                backoffDelay = nextBackoff(backoffDelay, false);
            }

            logger.warn(
                { endpoint, error: errorMsg, nextBackoff: backoffDelay },
                '[XRPL] Connection failed, trying next endpoint'
            );

            // Wait before trying next endpoint
            await sleep(backoffDelay);
        }
    }

    // All endpoints failed
    reconnectCount++;
    throw lastConnectError || new Error('All XRPL endpoints failed');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the shared XRPL client instance.
 * Creates and connects if not already connected.
 * De-duplicates concurrent connection attempts.
 * 
 * @throws SingleProcessXrplGuardError if called from an API route in single-process mode
 */
export async function getXrplClient(): Promise<Client> {
    enforceApiRouteContextInvariant('getXrplClient');

    // Guard: block direct calls from API routes in single-process mode
    assertNoDirectXrplCallsInSingleProcess('getXrplClient');

    // Return existing connected client
    if (sharedClient?.isConnected()) {
        return sharedClient;
    }

    // Wait for in-flight connection attempt
    if (connectPromise) {
        return connectPromise;
    }

    // Start new connection attempt
    isReconnecting = true;
    connectPromise = (async () => {
        try {
            sharedClient = await connectInternal();
            return sharedClient;
        } finally {
            connectPromise = null;
            isReconnecting = false;
        }
    })();

    return connectPromise;
}

/**
 * Disconnect the shared client.
 * Safe to call even if not connected.
 */
export async function disconnectXrplClient(): Promise<void> {
    // Wait for any in-flight connection to complete first
    if (connectPromise) {
        try {
            await connectPromise;
        } catch { /* ignore */ }
    }

    if (sharedClient) {
        try {
            if (sharedClient.isConnected()) {
                await sharedClient.disconnect();
            }
        } catch (err) {
            logger.warn({ err }, '[XRPL] Error during disconnect');
        }
        sharedClient = null;
    }

    currentEndpoint = null;
    connectPromise = null;
    isReconnecting = false;
}

/**
 * Get current connection state for health monitoring.
 */
export function getConnectionState(): ConnectionState {
    const cooldowns: Record<string, number> = {};
    const now = Date.now();

    for (const [url, state] of endpointStates) {
        if (state.cooldownUntil > now) {
            cooldowns[url] = state.cooldownUntil;
        }
    }

    return {
        connected: sharedClient?.isConnected() ?? false,
        endpoint: currentEndpoint,
        lastError,
        reconnects: reconnectCount,
        cooldowns,
        endpointPool: parseEndpoints(),
    };
}

/**
 * Check if connected without triggering reconnection.
 */
export function isConnected(): boolean {
    return sharedClient?.isConnected() ?? false;
}

/**
 * Get the current endpoint URL (may be null if not connected).
 */
export function getCurrentEndpoint(): string | null {
    return currentEndpoint;
}

/**
 * Force rotation to next endpoint (useful for testing or manual failover).
 */
export async function rotateEndpoint(): Promise<void> {
    if (currentEndpoint) {
        markFailed(currentEndpoint, 'Manual rotation');
    }
    await disconnectXrplClient();
    await getXrplClient();
}

// =============================================================================
// Testing Utilities
// =============================================================================

/** Reset all state (for testing) */
export function __resetForTesting(): void {
    sharedClient = null;
    connectPromise = null;
    currentEndpoint = null;
    lastError = null;
    reconnectCount = 0;
    lastConnectAttempt = 0;
    backoffDelay = CONFIG.initialReconnectDelayMs;
    isReconnecting = false;
    endpointStates.clear();
}

/** Get CONFIG for testing */
export function __getConfig(): typeof CONFIG {
    return { ...CONFIG };
}

/** Override CONFIG for testing */
export function __setConfigForTesting(overrides: Partial<typeof CONFIG>): void {
    Object.assign(CONFIG, overrides);
}

function enforceApiRouteContextInvariant(context: string): void {
    if (!isAuditGuardsEnabled()) {
        return;
    }

    if (!isRequestContext()) {
        return;
    }

    if (isApiRouteContext()) {
        return;
    }

    const requestContext = getRequestContext();
    const requestId = requestContext?.requestId;

    logger.warn(
        {
            context,
            requestId: requestId ?? null,
            nodeEnv: process.env.NODE_ENV ?? 'development',
        },
        '[XRPL Guard] Request-scoped shared client access without API route context'
    );

    if (process.env.NODE_ENV !== 'production') {
        throw new MissingApiRouteContextError(context, requestId);
    }
}
