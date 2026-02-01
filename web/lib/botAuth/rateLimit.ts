/**
 * Rate limiting for bot API.
 * Uses sliding window counter with in-memory storage (Redis optional).
 */

import { loadBotAuthEnv } from './env';

interface RateLimitEntry {
    count: number;
    windowStart: number;
}

// In-memory store
const memoryStore = new Map<string, RateLimitEntry>();

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

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
}

/**
 * Check rate limit for a given key (apiKeyId + ip).
 * Returns whether the request is allowed.
 */
export async function checkRateLimit(
    apiKeyId: string,
    ip: string
): Promise<RateLimitResult> {
    const env = loadBotAuthEnv();
    const limit = env.BOT_API_RATE_LIMIT_PER_MIN;
    const key = `rate:${apiKeyId}:${ip}`;
    const windowMs = 60_000; // 1 minute window
    const now = Date.now();

    // Try Redis first if available
    if (env.REDIS_URL) {
        try {
            return await checkRateLimitRedis(key, limit, windowMs, env.REDIS_URL);
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

    return {
        allowed: entry.count <= limit,
        remaining,
        resetAt,
    };
}

/**
 * Redis-based rate limiting using sorted sets.
 */
async function checkRateLimitRedis(
    key: string,
    limit: number,
    windowMs: number,
    redisUrl: string
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
