/**
 * Volatility Estimator
 *
 * Lightweight EWMA estimator over absolute mid-price returns in basis points.
 * Used by optional volatility-adaptive stop-loss sizing.
 */

export interface VolatilityEstimatorConfig {
    alpha: number;
    warmupMs: number;
    minSamples: number;
}

export interface VolatilityEstimatorState {
    lastMid: number | null;
    ewmaVolBps: number;
    sampleCount: number;
    lastUpdateTs: number;
    startedAtTs: number;
}

export interface VolatilityStopConfigLike {
    enabled?: boolean | undefined;
    multiplier?: number | undefined;
    minBps?: number | undefined;
    maxBps?: number | undefined;
    useForEnhanced?: boolean | undefined;
}

export type VolatilityStopSource = 'fixed-disabled' | 'fixed-warmup' | 'adaptive';

export interface VolatilityStopResolution {
    stopLossBpsUsed: number;
    enhancedStopBpsUsed: number;
    source: VolatilityStopSource;
}

const DEFAULT_ESTIMATOR_CONFIG: VolatilityEstimatorConfig = {
    alpha: 0.2,
    warmupMs: 60_000,
    minSamples: 50,
};

const sanitizePositive = (value: number | undefined, fallback: number): number => (
    Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback
);

const sanitizeNonNegative = (value: number | undefined, fallback: number): number => (
    Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback
);

const sanitizeAlpha = (value: number | undefined, fallback: number): number => {
    if (!Number.isFinite(value)) return fallback;
    const parsed = value as number;
    if (parsed <= 0) return fallback;
    if (parsed > 1) return 1;
    return parsed;
};

export function clampBps(value: number, minBps: number, maxBps: number): number {
    const min = sanitizePositive(minBps, 1);
    const max = Math.max(min, sanitizePositive(maxBps, min));
    const raw = sanitizeNonNegative(value, min);
    return Math.min(max, Math.max(min, raw));
}

export function resolveAdaptiveStopLossBps(input: {
    fixedStopLossBps: number;
    volBps: number;
    volReady: boolean;
    config?: VolatilityStopConfigLike | null | undefined;
}): VolatilityStopResolution {
    const fixedStopLossBps = sanitizePositive(input.fixedStopLossBps, 1);
    const fixedEnhancedBps = fixedStopLossBps / 2;
    const cfg = input.config;

    if (!cfg?.enabled) {
        return {
            stopLossBpsUsed: fixedStopLossBps,
            enhancedStopBpsUsed: fixedEnhancedBps,
            source: 'fixed-disabled',
        };
    }

    if (!input.volReady) {
        return {
            stopLossBpsUsed: fixedStopLossBps,
            enhancedStopBpsUsed: fixedEnhancedBps,
            source: 'fixed-warmup',
        };
    }

    const multiplier = sanitizePositive(cfg.multiplier, 1);
    const minBps = sanitizePositive(cfg.minBps, fixedStopLossBps);
    const maxBps = Math.max(minBps, sanitizePositive(cfg.maxBps, minBps));
    const rawAdaptiveBps = sanitizeNonNegative(input.volBps, 0) * multiplier;
    const adaptiveStopBps = clampBps(rawAdaptiveBps, minBps, maxBps);
    const useAdaptiveForEnhanced = cfg.useForEnhanced !== false;

    return {
        stopLossBpsUsed: adaptiveStopBps,
        enhancedStopBpsUsed: useAdaptiveForEnhanced ? adaptiveStopBps / 2 : fixedEnhancedBps,
        source: 'adaptive',
    };
}

export class VolatilityEstimator {
    private readonly config: VolatilityEstimatorConfig;
    private lastMid: number | null = null;
    private ewmaVolBps = 0;
    private sampleCount = 0;
    private lastUpdateTs = 0;
    private startedAtTs: number;

    constructor(config: Partial<VolatilityEstimatorConfig> = {}, startTs: number = Date.now()) {
        this.config = {
            alpha: sanitizeAlpha(config.alpha, DEFAULT_ESTIMATOR_CONFIG.alpha),
            warmupMs: sanitizeNonNegative(config.warmupMs, DEFAULT_ESTIMATOR_CONFIG.warmupMs),
            minSamples: Math.max(1, Math.floor(sanitizePositive(config.minSamples, DEFAULT_ESTIMATOR_CONFIG.minSamples))),
        };
        this.startedAtTs = Number.isFinite(startTs) ? startTs : Date.now();
    }

    update(mid: number, ts: number = Date.now()): void {
        if (!Number.isFinite(mid) || mid <= 0) {
            return;
        }

        const nowTs = Number.isFinite(ts) ? ts : Date.now();

        if (!Number.isFinite(this.lastMid) || this.lastMid == null || this.lastMid <= 0) {
            this.lastMid = mid;
            this.lastUpdateTs = nowTs;
            return;
        }

        const returnBps = Math.abs((mid - this.lastMid) / this.lastMid) * 10_000;
        if (Number.isFinite(returnBps)) {
            this.ewmaVolBps = this.sampleCount === 0
                ? returnBps
                : (this.config.alpha * returnBps) + ((1 - this.config.alpha) * this.ewmaVolBps);
            this.sampleCount += 1;
        }

        this.lastMid = mid;
        this.lastUpdateTs = nowTs;
    }

    getVolBps(): number {
        return Number.isFinite(this.ewmaVolBps) && this.ewmaVolBps >= 0
            ? this.ewmaVolBps
            : 0;
    }

    isReady(nowTs: number = Date.now()): boolean {
        const warmupElapsed = Number.isFinite(nowTs) && (nowTs - this.startedAtTs) >= this.config.warmupMs;
        return this.sampleCount >= this.config.minSamples || warmupElapsed;
    }

    getState(): VolatilityEstimatorState {
        return {
            lastMid: this.lastMid,
            ewmaVolBps: this.getVolBps(),
            sampleCount: this.sampleCount,
            lastUpdateTs: this.lastUpdateTs,
            startedAtTs: this.startedAtTs,
        };
    }

    reset(startTs: number = Date.now()): void {
        this.lastMid = null;
        this.ewmaVolBps = 0;
        this.sampleCount = 0;
        this.lastUpdateTs = 0;
        this.startedAtTs = Number.isFinite(startTs) ? startTs : Date.now();
    }
}
