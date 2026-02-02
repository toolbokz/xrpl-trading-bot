/**
 * Rate limiting for bot API.
 * Uses sliding window counter with in-memory storage (Redis optional).
 * 
 * Supports differentiated limits for read vs write operations:
 * - READ: GET, HEAD, OPTIONS (default: 60/min)
 * - WRITE: POST, PUT, DELETE, PATCH (default: 20/min)
 * 
 * Supports per-route overrides via BOT_API_RATE_LIMIT_ROUTES env var:
 * BOT_API_RATE_LIMIT_ROUTES='{"\/api\/bot\/status":100,"\/api\/bot\/run":5}'
 */

import { loadBotAuthEnv } from './env';

/** Rate limit type based on HTTP method */
export type RateLimitType = 'read' | 'write';

interface RateLimitEntry {
    count: number;
    windowStart: number;
}

/** Per-route rate limit configuration */
export interface RouteRateLimitConfig {
    /** Route pattern (string or regex pattern) */
    pattern: string;
    /** Rate limit per minute */
    limit: number;
    /** Optional custom window in ms (default: 60000) */
    windowMs?: number | undefined;
}

// In-memory store (separate keys for read/write)
const memoryStore = new Map<string, RateLimitEntry>();

// Parsed route limits cache
let routeLimitsCache: RouteRateLimitConfig[] | null = null;

// Cleanup interval
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanup(): void {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        const windowMs = 60_000; // 1 minute
        for (const [key, entry] of memoryStore) {
            if (now - entry.windowStart > windowMs * 2) {
                memoryStore.delete(key);
            }
        }
    }, 60_000);

    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }
}

/**
 * Parse per-route rate limits from environment.
 * Format: JSON object with route patterns as keys and limits as values.
 * Example: {"\/api\/bot\/status":100,"\/api\/bot\/run":5}
 */
function parseRouteLimits(): RouteRateLimitConfig[] {
    if (routeLimitsCache !== null) {
        return routeLimitsCache;
    }

    const routesJson = process.env.BOT_API_RATE_LIMIT_ROUTES;
    if (!routesJson) {
        routeLimitsCache = [];
        return routeLimitsCache;
    }

    try {
        const parsed = JSON.parse(routesJson);
        routeLimitsCache = [];

        if (typeof parsed === 'object' && parsed !== null) {
            for (const [pattern, config] of Object.entries(parsed)) {
                if (typeof config === 'number') {
                    routeLimitsCache.push({ pattern, limit: config });
                } else if (typeof config === 'object' && config !== null) {
                    const cfg = config as Record<string, unknown>;
                    const limit = typeof cfg.limit === 'number' ? cfg.limit : 30;
                    const windowMs = typeof cfg.windowMs === 'number' ? cfg.windowMs : undefined;
                    routeLimitsCache.push({ pattern, limit, windowMs });
                }
            }
        }

        console.log(`[RateLimit] Loaded ${routeLimitsCache.length} per-route rate limit overrides`);
        return routeLimitsCache;
    } catch (err) {
        console.warn('[RateLimit] Failed to parse BOT_API_RATE_LIMIT_ROUTES:', err);
        routeLimitsCache = [];
        return routeLimitsCache;
    }
}

/**
 * Find route-specific rate limit configuration.
 * Returns the first matching route config or null.
 */
export function findRouteLimit(path: string): RouteRateLimitConfig | null {
    const routeLimits = parseRouteLimits();

    for (const config of routeLimits) {
        try {
            // Try as exact match first
            if (path === config.pattern) {
                return config;
            }

            // Try as regex pattern
            const regex = new RegExp(config.pattern);
            if (regex.test(path)) {
                return config;
            }
        } catch {
            // Invalid regex, try as prefix match
            if (path.startsWith(config.pattern)) {
                return config;
            }
        }
    }

    return null;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    limit: number;
    type: RateLimitType;
    route?: string | undefined;
}

/**
 * Determine rate limit type from HTTP method.
 */
export function getRateLimitType(method: string | undefined): RateLimitType {
    const readMethods = ['GET', 'HEAD', 'OPTIONS'];
    return readMethods.includes((method || '').toUpperCase()) ? 'read' : 'write';
}

/**
 * Get the rate limit value for a given type.
 */
function getDefaultRateLimit(type: RateLimitType): number {
    if (type === 'read') {
        return Number(process.env.BOT_API_RATE_LIMIT_READ_PER_MIN) || 60;
    } else {
        return Number(process.env.BOT_API_RATE_LIMIT_WRITE_PER_MIN) || 20;
    }
}

/**
 * Check rate limit for a given key (apiKeyId + ip) and operation type.
 * Returns whether the request is allowed.
 * 
 * @param apiKeyId - The API key ID
 * @param ip - Client IP address
 * @param type - Rate limit type ('read' or 'write')
 * @param path - Optional request path for per-route limiting
 */
export async function checkRateLimit(
    apiKeyId: string,
    ip: string,
    type: RateLimitType = 'read',
    path?: string
): Promise<RateLimitResult> {
    const env = loadBotAuthEnv();

    // Check for route-specific limits first
    const routeConfig = path ? findRouteLimit(path) : null;
    const limit = routeConfig ? routeConfig.limit : getDefaultRateLimit(type);
    const windowMs = routeConfig?.windowMs ?? 60_000; // 1 minute window default

    // Include type (or route) in key to have separate buckets
    const bucketKey = routeConfig ? `route:${routeConfig.pattern}` : `type:${type}`;
    const key = `rate:${bucketKey}:${apiKeyId}:${ip}`;
    const now = Date.now();

    // Try Redis first if available
    if (env.REDIS_URL) {
        try {
            const result = await checkRateLimitRedis(key, limit, windowMs, env.REDIS_URL, type);
            if (routeConfig) {
                result.route = routeConfig.pattern;
            }
            return result;
        } catch (err) {
            console.warn('[RateLimit] Redis error, falling back to memory:', err);
        }
    }

    // In-memory fallback
    startCleanup();

    let entry = memoryStore.get(key);

    // Reset window if expired
    if (!entry || now - entry.windowStart > windowMs) {
        entry = { count: 0, windowStart: now };
    }

    entry.count++;
    memoryStore.set(key, entry);

    const resetAt = entry.windowStart + windowMs;
    const remaining = Math.max(0, limit - entry.count);

    const result: RateLimitResult = {
        allowed: entry.count <= limit,
        remaining,
        resetAt,
        limit,
        type,
    };

    if (routeConfig) {
        result.route = routeConfig.pattern;
    }

    return result;
}

/**
 * Redis-based rate limiting using sorted sets.
 */
async function checkRateLimitRedis(
    key: string,
    limit: number,
    windowMs: number,
    redisUrl: string,
    type: RateLimitType
): Promise<RateLimitResult> {
    // @ts-ignore - redis is optional, install with: npm i redis
    const { createClient } = await import('redis');
    const client = createClient({ url: redisUrl });

    try {
        await client.connect();

        const now = Date.now();
        const windowStart = now - windowMs;

        // Remove old entries
        await client.zRemRangeByScore(key, '-inf', windowStart);

        // Add current request
        await client.zAdd(key, { score: now, value: `${now}:${Math.random()}` });

        // Set expiry on the key
        await client.expire(key, Math.ceil(windowMs / 1000) * 2);

        // Count requests in window
        const count = await client.zCard(key);

        const resetAt = now + windowMs;
        const remaining = Math.max(0, limit - count);

        return {
            allowed: count <= limit,
            remaining,
            resetAt,
            limit,
            type,
        };
    } finally {
        await client.quit().catch(() => { });
    }
}

/**
 * Clear rate limit store (for testing).
 */
export function clearRateLimitStore(): void {
    memoryStore.clear();
}

/**
 * Clear route limits cache (for testing).
 */
export function clearRouteLimitsCache(): void {
    routeLimitsCache = null;
}

/**
 * Get all configured route limits (for debugging/metrics).
 */
export function getRouteLimits(): RouteRateLimitConfig[] {
    return [...parseRouteLimits()];
}
