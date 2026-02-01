/**
 * Nonce store for replay protection.
 * Uses in-memory TTL map with optional Redis adapter.
 */

import { loadBotAuthEnv } from './env';

interface NonceEntry {
    expiresAt: number;
}

// In-memory store (works for serverless best-effort)
const memoryStore = new Map<string, NonceEntry>();

// Cleanup interval (every 60 seconds)
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanup(): void {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of memoryStore) {
            if (entry.expiresAt < now) {
                memoryStore.delete(key);
            }
        }
    }, 60_000);

    // Don't prevent process exit
    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }
}

/**
 * Check if nonce has been used. If not, mark it as used.
 * Returns true if nonce is valid (not seen before).
 * Returns false if nonce was already used (replay attack).
 */
export async function checkAndStoreNonce(
    nonce: string,
    apiKeyId: string,
    ttlSeconds: number
): Promise<boolean> {
    const env = loadBotAuthEnv();
    const key = `nonce:${apiKeyId}:${nonce}`;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    // Try Redis first if available
    if (env.REDIS_URL) {
        try {
            return await checkNonceRedis(key, ttlSeconds, env.REDIS_URL);
        } catch (err) {
            console.warn('[NonceStore] Redis error, falling back to memory:', err);
        }
    }

    // In-memory fallback
    startCleanup();

    const existing = memoryStore.get(key);
    if (existing && existing.expiresAt > Date.now()) {
        // Nonce already used and not expired
        return false;
    }

    // Store the nonce
    memoryStore.set(key, { expiresAt });
    return true;
}

/**
 * Redis-based nonce check using SETNX with TTL.
 */
async function checkNonceRedis(
    key: string,
    ttlSeconds: number,
    redisUrl: string
): Promise<boolean> {
    // Dynamic import to avoid requiring redis in environments without it
    // @ts-ignore - redis is optional, install with: npm i redis
    const { createClient } = await import('redis');
    const client = createClient({ url: redisUrl });

    try {
        await client.connect();
        // SET NX with TTL - returns null if key exists, 'OK' if set
        const result = await client.set(key, '1', {
            NX: true,
            EX: ttlSeconds,
        });
        return result === 'OK';
    } finally {
        await client.quit().catch(() => { });
    }
}

/**
 * Clear all nonces (for testing).
 */
export function clearNonceStore(): void {
    memoryStore.clear();
}
