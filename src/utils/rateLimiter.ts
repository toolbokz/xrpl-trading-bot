/**
 * Token-bucket rate limiter for CPU safety.
 * Prevents hot paths from overwhelming the system.
 */

import { sleep } from './sleep';

/** Max ticks/sec for strategy execution (configurable via STRATEGY_MAX_TPS) */
export const STRATEGY_MAX_TPS = Math.max(
    1,
    parseInt(process.env.STRATEGY_MAX_TPS ?? '10', 10) || 10
);

export interface RateLimiterConfig {
    /** Max tokens per second */
    maxTps: number;
    /** Bucket size (burst capacity) */
    bucketSize?: number;
}

export class TokenBucketRateLimiter {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTps: number;
    private readonly bucketSize: number;
    private readonly refillIntervalMs: number;

    constructor(config: RateLimiterConfig) {
        this.maxTps = Math.max(1, config.maxTps);
        this.bucketSize = config.bucketSize ?? this.maxTps;
        this.tokens = this.bucketSize;
        this.lastRefill = Date.now();
        this.refillIntervalMs = 1000 / this.maxTps;
    }

    /**
     * Refill tokens based on elapsed time.
     */
    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const tokensToAdd = (elapsed / 1000) * this.maxTps;
        this.tokens = Math.min(this.bucketSize, this.tokens + tokensToAdd);
        this.lastRefill = now;
    }

    /**
     * Try to consume a token without blocking.
     * @returns true if token consumed, false if rate limited
     */
    tryConsume(): boolean {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }

    /**
     * Consume a token, blocking if necessary.
     * Use this to throttle hot paths.
     */
    async consume(): Promise<void> {
        while (!this.tryConsume()) {
            await sleep(this.refillIntervalMs);
        }
    }

    /**
     * Get current token count (for monitoring).
     */
    getTokenCount(): number {
        this.refill();
        return this.tokens;
    }

    /**
     * Get configured max TPS.
     */
    getMaxTps(): number {
        return this.maxTps;
    }
}

/**
 * Global strategy rate limiter singleton.
 */
let globalStrategyLimiter: TokenBucketRateLimiter | null = null;

export const getStrategyRateLimiter = (): TokenBucketRateLimiter => {
    if (!globalStrategyLimiter) {
        globalStrategyLimiter = new TokenBucketRateLimiter({
            maxTps: STRATEGY_MAX_TPS,
            bucketSize: STRATEGY_MAX_TPS * 2, // Allow small bursts
        });
    }
    return globalStrategyLimiter;
};

/**
 * Throttle a function call using the global strategy limiter.
 */
export const throttleStrategy = async (): Promise<void> => {
    await getStrategyRateLimiter().consume();
};
