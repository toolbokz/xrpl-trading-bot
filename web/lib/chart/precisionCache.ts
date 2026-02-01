/**
 * Per-Pair Precision Cache
 * LRU cache for storing decimal precision per trading pair
 */

import { PairPrecisionEntry, AdaptiveScalingOptions, DEFAULT_SCALING_OPTIONS } from './types';

/**
 * LRU Cache for per-pair precision storage
 * Prevents unbounded memory growth while maintaining frequently accessed pairs
 */
export class PrecisionCache {
    private cache: Map<string, PairPrecisionEntry>;
    private maxSize: number;

    constructor(maxSize: number = DEFAULT_SCALING_OPTIONS.maxCachedPairs) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    /**
     * Get cached precision for a pair
     * Returns undefined if not cached
     */
    get(pair: string): number | undefined {
        const entry = this.cache.get(pair);
        if (!entry) {
            return undefined;
        }

        // Update access count and move to end (most recently used)
        entry.accessCount++;
        entry.lastUpdated = Date.now();

        // LRU: delete and re-add to move to end
        this.cache.delete(pair);
        this.cache.set(pair, entry);

        return entry.precision;
    }

    /**
     * Set or update precision for a pair
     * Only updates if new precision is higher (never decreases)
     */
    set(pair: string, precision: number): void {
        const existing = this.cache.get(pair);

        if (existing) {
            // Only increase precision, never decrease
            if (precision > existing.precision) {
                existing.precision = precision;
                existing.lastUpdated = Date.now();
            }
            existing.accessCount++;

            // Move to end (most recently used)
            this.cache.delete(pair);
            this.cache.set(pair, existing);
        } else {
            // Evict LRU entries if at capacity
            this.evictIfNeeded();

            // Add new entry
            this.cache.set(pair, {
                pair,
                precision,
                lastUpdated: Date.now(),
                accessCount: 1,
            });
        }
    }

    /**
     * Force set precision (allows decreasing)
     * Use sparingly - mainly for testing or explicit resets
     */
    forceSet(pair: string, precision: number): void {
        const existing = this.cache.get(pair);

        if (existing) {
            existing.precision = precision;
            existing.lastUpdated = Date.now();
            existing.accessCount++;

            this.cache.delete(pair);
            this.cache.set(pair, existing);
        } else {
            this.evictIfNeeded();

            this.cache.set(pair, {
                pair,
                precision,
                lastUpdated: Date.now(),
                accessCount: 1,
            });
        }
    }

    /**
     * Check if a pair is cached
     */
    has(pair: string): boolean {
        return this.cache.has(pair);
    }

    /**
     * Remove a pair from cache
     */
    delete(pair: string): boolean {
        return this.cache.delete(pair);
    }

    /**
     * Clear all cached entries
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * Get current cache size
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Get all cached pairs
     */
    keys(): string[] {
        return Array.from(this.cache.keys());
    }

    /**
     * Get all entries (for debugging/inspection)
     */
    entries(): PairPrecisionEntry[] {
        return Array.from(this.cache.values());
    }

    /**
     * Evict least recently used entries if at capacity
     */
    private evictIfNeeded(): void {
        while (this.cache.size >= this.maxSize) {
            // Map maintains insertion order, first key is LRU
            const lruKey = this.cache.keys().next().value;
            if (lruKey) {
                this.cache.delete(lruKey);
            } else {
                break;
            }
        }
    }

    /**
     * Get or compute precision for a pair
     * If not cached, computes using provided function and caches result
     */
    getOrCompute(pair: string, computeFn: () => number): number {
        const cached = this.get(pair);
        if (cached !== undefined) {
            return cached;
        }

        const computed = computeFn();
        this.set(pair, computed);
        return computed;
    }

    /**
     * Update precision if new data exceeds cached value
     */
    updateIfHigher(pair: string, newPrecision: number): boolean {
        const current = this.get(pair);
        if (current === undefined || newPrecision > current) {
            this.set(pair, newPrecision);
            return true;
        }
        return false;
    }

    /**
     * Export cache state for persistence
     */
    export(): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [pair, entry] of this.cache) {
            result[pair] = entry.precision;
        }
        return result;
    }

    /**
     * Import cache state from persistence
     */
    import(data: Record<string, number>): void {
        for (const [pair, precision] of Object.entries(data)) {
            this.set(pair, precision);
        }
    }
}

/**
 * Global singleton instance
 */
let globalPrecisionCache: PrecisionCache | null = null;

/**
 * Get or create the global precision cache instance
 */
export function getGlobalPrecisionCache(
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): PrecisionCache {
    if (!globalPrecisionCache) {
        globalPrecisionCache = new PrecisionCache(options.maxCachedPairs);
    }
    return globalPrecisionCache;
}

/**
 * Reset the global precision cache (mainly for testing)
 */
export function resetGlobalPrecisionCache(): void {
    if (globalPrecisionCache) {
        globalPrecisionCache.clear();
    }
    globalPrecisionCache = null;
}
