/**
 * Mid-Price Trend Tracker
 *
 * Detects persistent price trends over configurable time horizons using
 * exponentially weighted moving averages (EMA).  Unlike the flow-regime
 * classifier (which measures short-term order-flow imbalance), this module
 * tracks the *realised* mid-price trajectory over minutes, catching slow
 * drifts that a 10-60 s flow window misses.
 *
 * The scalper entry gate uses the trend signal to suppress long entries
 * during sustained downtrends and short entries during sustained uptrends.
 *
 * All prices are expected in quote-per-base convention (e.g. RLUSD/XRP).
 */


// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface MidPriceTrendConfig {
    /** Enable/disable the trend detector (default: true) */
    enabled: boolean;

    /**
     * Half-life of the fast EMA in milliseconds (default: 60_000 = 1 min).
     * Reacts quickly to recent price changes.
     */
    fastHalfLifeMs: number;

    /**
     * Half-life of the slow EMA in milliseconds (default: 300_000 = 5 min).
     * Smooths over noise to capture the underlying drift.
     */
    slowHalfLifeMs: number;

    /**
     * Minimum trend magnitude (in bps) to classify as trending.
     * Below this threshold the trend is considered "flat" (default: 5).
     */
    flatThresholdBps: number;

    /**
     * Minimum number of samples before the tracker emits a signal.
     * Prevents early spurious signals during warmup (default: 10).
     */
    minSamples: number;

    /**
     * Maximum age of the last sample (in ms) before the tracker considers
     * itself stale and returns "unknown" (default: 30_000).
     */
    staleAfterMs: number;
}

export const DEFAULT_MID_PRICE_TREND_CONFIG: MidPriceTrendConfig = {
    enabled: true,
    fastHalfLifeMs: 60_000,
    slowHalfLifeMs: 300_000,
    flatThresholdBps: 5,
    minSamples: 10,
    staleAfterMs: 30_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Trend classification
// ─────────────────────────────────────────────────────────────────────────────

export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';

export interface TrendSignal {
    /** Current trend direction */
    direction: TrendDirection;

    /** Trend magnitude in basis points (positive = up, negative = down).
     *  Computed as (fastEma − slowEma) / slowEma × 10 000. */
    trendBps: number;

    /** Rate of change of mid-price over the fast window, in bps/min.
     *  Gives a velocity measure of how fast the price is moving. */
    velocityBpsPerMin: number;

    /** Fast EMA value (responsive to recent prices) */
    fastEma: number;

    /** Slow EMA value (baseline level) */
    slowEma: number;

    /** Number of observations recorded so far */
    sampleCount: number;

    /** Whether the tracker has enough data to make a confident classification */
    ready: boolean;

    /** Timestamp of last update */
    lastUpdateMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core tracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EMA decay factor for a given elapsed time and half-life.
 *
 *   α = 1 − exp(−ln(2) × dt / halfLife)
 *
 * When dt = halfLife, α ≈ 0.5 — the new sample receives 50 % weight.
 */
function emaAlpha(dtMs: number, halfLifeMs: number): number {
    if (halfLifeMs <= 0 || dtMs <= 0) return 1; // instant snap
    return 1 - Math.exp(-Math.LN2 * dtMs / halfLifeMs);
}

export class MidPriceTrendTracker {
    private config: MidPriceTrendConfig;

    private fastEma = 0;
    private slowEma = 0;
    private sampleCount = 0;
    private lastUpdateMs = 0;
    private lastMid = 0;

    /** Stored for velocity: mid price and timestamp of the observation
     *  `fastHalfLifeMs` ago (approximated by a separate slow-decayed tracker). */
    private velocityRefMid = 0;
    private velocityRefTs = 0;

    constructor(config?: Partial<MidPriceTrendConfig>) {
        this.config = { ...DEFAULT_MID_PRICE_TREND_CONFIG, ...config };
    }

    /**
     * Feed a new mid-price observation.
     * Should be called once per tick (every ~250-1000 ms).
     */
    update(midPrice: number, nowMs: number = Date.now()): void {
        if (!Number.isFinite(midPrice) || midPrice <= 0) return;
        if (!Number.isFinite(nowMs)) return;

        if (this.sampleCount === 0) {
            // First sample — initialise both EMAs to the observed price.
            this.fastEma = midPrice;
            this.slowEma = midPrice;
            this.velocityRefMid = midPrice;
            this.velocityRefTs = nowMs;
            this.lastMid = midPrice;
            this.lastUpdateMs = nowMs;
            this.sampleCount = 1;
            return;
        }

        const dt = nowMs - this.lastUpdateMs;
        if (dt <= 0) return; // duplicate or out-of-order

        const alphaFast = emaAlpha(dt, this.config.fastHalfLifeMs);
        const alphaSlow = emaAlpha(dt, this.config.slowHalfLifeMs);

        this.fastEma += alphaFast * (midPrice - this.fastEma);
        this.slowEma += alphaSlow * (midPrice - this.slowEma);

        // Update velocity reference — use a very slow decay so it represents
        // the price ~fastHalfLifeMs ago.
        const alphaVelRef = emaAlpha(dt, this.config.fastHalfLifeMs * 2);
        this.velocityRefMid += alphaVelRef * (midPrice - this.velocityRefMid);
        if (this.velocityRefTs === 0) this.velocityRefTs = nowMs;

        this.lastMid = midPrice;
        this.lastUpdateMs = nowMs;
        this.sampleCount++;
    }

    /**
     * Get the current trend signal.
     */
    getSignal(nowMs: number = Date.now()): TrendSignal {
        const ready = this.sampleCount >= this.config.minSamples;
        const stale = (nowMs - this.lastUpdateMs) > this.config.staleAfterMs;

        if (!ready || stale || this.slowEma <= 0) {
            return {
                direction: 'unknown',
                trendBps: 0,
                velocityBpsPerMin: 0,
                fastEma: this.fastEma,
                slowEma: this.slowEma,
                sampleCount: this.sampleCount,
                ready: false,
                lastUpdateMs: this.lastUpdateMs,
            };
        }

        // Trend = (fast − slow) / slow, in bps
        const trendBps = ((this.fastEma - this.slowEma) / this.slowEma) * 10_000;

        // Velocity = price change per minute over the fast window
        const velElapsedMs = this.lastUpdateMs - this.velocityRefTs;
        let velocityBpsPerMin = 0;
        if (velElapsedMs > 1000 && this.velocityRefMid > 0) {
            const changeBps = ((this.lastMid - this.velocityRefMid) / this.velocityRefMid) * 10_000;
            velocityBpsPerMin = changeBps / (velElapsedMs / 60_000);
        }

        let direction: TrendDirection;
        if (trendBps > this.config.flatThresholdBps) {
            direction = 'up';
        } else if (trendBps < -this.config.flatThresholdBps) {
            direction = 'down';
        } else {
            direction = 'flat';
        }

        return {
            direction,
            trendBps,
            velocityBpsPerMin,
            fastEma: this.fastEma,
            slowEma: this.slowEma,
            sampleCount: this.sampleCount,
            ready: true,
            lastUpdateMs: this.lastUpdateMs,
        };
    }

    /**
     * Reset all state (e.g. on pair change).
     */
    reset(): void {
        this.fastEma = 0;
        this.slowEma = 0;
        this.sampleCount = 0;
        this.lastUpdateMs = 0;
        this.lastMid = 0;
        this.velocityRefMid = 0;
        this.velocityRefTs = 0;
    }
}
