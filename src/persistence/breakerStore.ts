/**
 * Circuit breaker persistence layer.
 * Supports Redis (primary) and file-based (fallback) storage.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../analytics/logger';

export interface BreakerState {
    trades: Array<{ timestamp: number; pnlBps: number }>;
    trippedAt: number | null;
    lastUpdated: number;
}

const DEFAULT_STATE: BreakerState = {
    trades: [],
    trippedAt: null,
    lastUpdated: Date.now(),
};

export interface BreakerStore {
    load(key: string): Promise<BreakerState>;
    save(key: string, state: BreakerState): Promise<void>;
    close(): Promise<void>;
}

/**
 * Redis-based circuit breaker store.
 * Uses dynamic import to avoid bundling redis when not used.
 */
class RedisBreakerStore implements BreakerStore {
    private client: any = null;
    private connecting: Promise<void> | null = null;

    constructor(private readonly url: string) { }

    private async ensureConnection(): Promise<any> {
        if (this.client?.isReady) return this.client;

        if (this.connecting) {
            await this.connecting;
            if (this.client?.isReady) return this.client;
        }

        this.connecting = (async () => {
            try {
                // Dynamic import for redis - wrapped in try/catch
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const redis = require('redis');
                const { createClient } = redis;
                this.client = createClient({ url: this.url });
                this.client.on('error', (err: Error) => logger.warn({ err }, 'Redis client error'));
                await this.client.connect();
                logger.info({ url: this.url.replace(/:[^:@]+@/, ':***@') }, 'Redis breaker store connected');
            } catch (err) {
                logger.error({ err }, 'Failed to connect to Redis breaker store');
                this.client = null;
                throw err;
            }
        })();

        await this.connecting;
        return this.client!;
    }

    async load(key: string): Promise<BreakerState> {
        try {
            const client = await this.ensureConnection();
            const raw = await client.get(`breaker:${key}`);
            if (!raw) return { ...DEFAULT_STATE };
            return JSON.parse(raw) as BreakerState;
        } catch (err) {
            logger.warn({ err, key }, 'Failed to load breaker state from Redis, using default');
            return { ...DEFAULT_STATE };
        }
    }

    async save(key: string, state: BreakerState): Promise<void> {
        try {
            const client = await this.ensureConnection();
            const stateWithTimestamp = { ...state, lastUpdated: Date.now() };
            // TTL: 24 hours (breaker data is ephemeral, old data can expire)
            await client.set(`breaker:${key}`, JSON.stringify(stateWithTimestamp), { EX: 86400 });
        } catch (err) {
            logger.warn({ err, key }, 'Failed to save breaker state to Redis');
        }
    }

    async close(): Promise<void> {
        if (this.client?.isReady) {
            await this.client.quit();
            this.client = null;
        }
    }
}

/**
 * File-based circuit breaker store (fallback).
 */
class FileBreakerStore implements BreakerStore {
    private readonly dataDir: string;

    constructor(dataDir = './data') {
        this.dataDir = path.resolve(dataDir);
        this.ensureDir();
    }

    private ensureDir(): void {
        try {
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
                logger.info({ dataDir: this.dataDir }, 'Created breaker data directory');
            }
        } catch (err) {
            logger.error({ err, dataDir: this.dataDir }, 'Failed to create breaker data directory');
        }
    }

    private filePath(key: string): string {
        // Sanitize key to prevent path traversal
        const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(this.dataDir, `breaker_${safeKey}.json`);
    }

    async load(key: string): Promise<BreakerState> {
        const file = this.filePath(key);
        try {
            if (!fs.existsSync(file)) {
                return { ...DEFAULT_STATE };
            }
            const raw = fs.readFileSync(file, 'utf8');
            return JSON.parse(raw) as BreakerState;
        } catch (err) {
            logger.warn({ err, key, file }, 'Failed to load breaker state from file, using default');
            return { ...DEFAULT_STATE };
        }
    }

    async save(key: string, state: BreakerState): Promise<void> {
        const file = this.filePath(key);
        try {
            const stateWithTimestamp = { ...state, lastUpdated: Date.now() };
            fs.writeFileSync(file, JSON.stringify(stateWithTimestamp, null, 2), 'utf8');
        } catch (err) {
            logger.warn({ err, key, file }, 'Failed to save breaker state to file');
        }
    }

    async close(): Promise<void> {
        // No-op for file store
    }
}

/**
 * In-memory breaker store (for testing).
 */
export class MemoryBreakerStore implements BreakerStore {
    private data = new Map<string, BreakerState>();

    async load(key: string): Promise<BreakerState> {
        return this.data.get(key) ?? { ...DEFAULT_STATE };
    }

    async save(key: string, state: BreakerState): Promise<void> {
        this.data.set(key, { ...state, lastUpdated: Date.now() });
    }

    async close(): Promise<void> {
        this.data.clear();
    }
}

/**
 * Factory to create the appropriate breaker store based on environment.
 */
export function createBreakerStore(): BreakerStore {
    const storeType = process.env.PATH_ARB_BREAKER_STORE || 'auto';
    const redisUrl = process.env.REDIS_URL;

    if (storeType === 'redis' && redisUrl) {
        logger.info({}, 'Using Redis breaker store');
        return new RedisBreakerStore(redisUrl);
    }

    if (storeType === 'file') {
        logger.info({}, 'Using file-based breaker store');
        return new FileBreakerStore();
    }

    // Auto mode: prefer Redis if available, fallback to file
    if (storeType === 'auto' && redisUrl) {
        logger.info({}, 'Using Redis breaker store (auto-detected)');
        return new RedisBreakerStore(redisUrl);
    }

    logger.info({}, 'Using file-based breaker store (default)');
    return new FileBreakerStore();
}

// Singleton store instance
let storeInstance: BreakerStore | null = null;

export function getBreakerStore(): BreakerStore {
    if (!storeInstance) {
        storeInstance = createBreakerStore();
    }
    return storeInstance;
}

export async function closeBreakerStore(): Promise<void> {
    if (storeInstance) {
        await storeInstance.close();
        storeInstance = null;
    }
}
