import { createHash } from 'crypto';

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
    lastAccessAt: number;
}

class TtlCache {
    private readonly entries = new Map<string, CacheEntry<unknown>>();

    constructor(private readonly maxEntries: number) {}

    get<T>(key: string): T | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return null;
        }
        entry.lastAccessAt = Date.now();
        return entry.value as T;
    }

    set<T>(key: string, value: T, ttlMs: number): void {
        if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
            this.evictLeastRecentlyUsed();
        }

        this.entries.set(key, {
            value,
            expiresAt: Date.now() + ttlMs,
            lastAccessAt: Date.now(),
        });
    }

    invalidate(matcher?: (key: string) => boolean): number {
        if (!matcher) {
            const count = this.entries.size;
            this.entries.clear();
            return count;
        }

        let removed = 0;
        for (const key of this.entries.keys()) {
            if (matcher(key)) {
                this.entries.delete(key);
                removed += 1;
            }
        }
        return removed;
    }

    private evictLeastRecentlyUsed(): void {
        let oldestKey: string | null = null;
        let oldestAccess = Number.POSITIVE_INFINITY;

        for (const [key, entry] of this.entries.entries()) {
            if (entry.lastAccessAt < oldestAccess) {
                oldestAccess = entry.lastAccessAt;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.entries.delete(oldestKey);
        }
    }
}

const ANALYTICS_CACHE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.ANALYTICS_CACHE_TTL_MS ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 5_000;
})();

const analyticsCache = new TtlCache(500);

export function getAnalyticsCacheTtlMs(): number {
    return ANALYTICS_CACHE_TTL_MS;
}

export function buildAnalyticsCacheKey(routeName: string, filters: Record<string, unknown>): string {
    const normalized = stableStringify(filters);
    const hash = createHash('sha1').update(normalized).digest('hex');
    return `analytics:${routeName}:${hash}`;
}

export function getCachedAnalytics<T>(key: string): T | null {
    return analyticsCache.get<T>(key);
}

export function setCachedAnalytics<T>(key: string, value: T, ttlMs: number = ANALYTICS_CACHE_TTL_MS): void {
    analyticsCache.set(key, value, ttlMs);
}

export function invalidateAnalyticsCache(prefix?: string): number {
    if (!prefix) {
        return analyticsCache.invalidate();
    }
    return analyticsCache.invalidate((key) => key.startsWith(prefix));
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    const serialized = keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
        .join(',');
    return `{${serialized}}`;
}
