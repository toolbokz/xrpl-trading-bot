/**
 * Reprice Policy — Evidence-Based Order Replacement/Cancel Decisions
 *
 * Prevents churn (excessive order replacement), enforces cancel on stale data,
 * and determines when to replace a resting order vs keeping or pausing.
 *
 * Decision matrix:
 *   KEEP    — drift is within tolerance, no action needed.
 *   REPLACE — drift exceeds tolerance, replace rate is under churn limit.
 *   CANCEL  — feed staleness exceeds hard limit; cancel rather than trade stale.
 *   PAUSE   — churn breaker tripped (too many replaces/min).
 *
 * @module execution/repricePolicy
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RepriceAction = 'KEEP' | 'REPLACE' | 'CANCEL' | 'PAUSE';

export interface RepriceDecision {
    action: RepriceAction;
    reason: string;
    newPrice?: number;
}

export interface RepriceInput {
    /** Current resting quote price. */
    currentQuote: number;
    /** Fair (theoretical) quote price. */
    fairQuote: number;
    /** Absolute drift in basis points between current and fair. */
    driftBps: number;
    /** Feed staleness in ms. */
    feedStalenessMs: number;
    /** Whether the spread regime changed since the order was placed. */
    spreadRegimeChanged: boolean;
    /** Depth deterioration factor (0 = no change, >0 = worse). */
    queueDeterioration: number;
    /** Current order replace rate (per minute). */
    replaceRatePerMin: number;
    /** Maximum allowed replaces per minute before churn breaker trips. */
    churnLimitPerMin: number;
}

export interface RepriceConfig {
    /** Drift threshold in bps before REPLACE (default: 5). */
    driftThresholdBps: number;
    /** Hard staleness limit in ms for CANCEL (default: 10000). */
    hardStalenessLimitMs: number;
    /** Soft staleness limit in ms for REPLACE urgency boost (default: 3000). */
    softStalenessLimitMs: number;
    /** Queue deterioration threshold before REPLACE (default: 0.3). */
    queueDeteriorationThreshold: number;
    /** Default churn limit per minute (default: 8). */
    defaultChurnLimitPerMin: number;
}

const DEFAULT_CONFIG: RepriceConfig = {
    driftThresholdBps: 5,
    hardStalenessLimitMs: 10_000,
    softStalenessLimitMs: 3_000,
    queueDeteriorationThreshold: 0.3,
    defaultChurnLimitPerMin: 8,
};

// ─────────────────────────────────────────────────────────────────────────────
// Core Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a resting order should be kept, replaced, cancelled, or paused.
 */
export function evaluateRepricePolicy(
    input: RepriceInput,
    config: Partial<RepriceConfig> = {},
): RepriceDecision {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    const staleness = Math.max(0, input.feedStalenessMs);
    const drift = Math.max(0, input.driftBps);
    const churnLimit = input.churnLimitPerMin > 0 ? input.churnLimitPerMin : cfg.defaultChurnLimitPerMin;

    // 1. Hard staleness → cancel immediately
    if (staleness > cfg.hardStalenessLimitMs) {
        return {
            action: 'CANCEL',
            reason: `hard-staleness:${Math.round(staleness)}ms>${cfg.hardStalenessLimitMs}ms`,
        };
    }

    // 2. Churn breaker → pause (too many replaces)
    if (input.replaceRatePerMin >= churnLimit) {
        return {
            action: 'PAUSE',
            reason: `churn-breaker:${input.replaceRatePerMin.toFixed(1)}>=${churnLimit}/min`,
        };
    }

    // 3. Spread regime changed → replace (market structure shifted)
    if (input.spreadRegimeChanged && drift > cfg.driftThresholdBps * 0.5) {
        return {
            action: 'REPLACE',
            reason: 'spread-regime-changed',
            newPrice: input.fairQuote,
        };
    }

    // 4. Queue deterioration above threshold → replace (order is at risk)
    if (input.queueDeterioration > cfg.queueDeteriorationThreshold && drift > cfg.driftThresholdBps * 0.5) {
        return {
            action: 'REPLACE',
            reason: `queue-deterioration:${input.queueDeterioration.toFixed(2)}`,
            newPrice: input.fairQuote,
        };
    }

    // 5. Soft staleness + drift → replace with urgency
    if (staleness > cfg.softStalenessLimitMs && drift > cfg.driftThresholdBps * 0.75) {
        return {
            action: 'REPLACE',
            reason: `soft-staleness-drift:${Math.round(staleness)}ms,${drift.toFixed(1)}bps`,
            newPrice: input.fairQuote,
        };
    }

    // 6. Drift above threshold → replace
    if (drift > cfg.driftThresholdBps) {
        return {
            action: 'REPLACE',
            reason: `drift:${drift.toFixed(1)}bps>${cfg.driftThresholdBps}bps`,
            newPrice: input.fairQuote,
        };
    }

    // 7. Below all thresholds → keep
    return {
        action: 'KEEP',
        reason: `within-tolerance:drift=${drift.toFixed(1)}bps`,
    };
}

/**
 * Compute a maker (passive) quote given market conditions.
 *
 * The quote widens from mid-price based on spread, volatility, and staleness
 * to reduce adverse selection risk on passive orders.
 */
export function computeMakerQuote(args: {
    mid: number;
    side: 'buy' | 'sell';
    spreadBps: number;
    volBps: number;
    stalenessMs: number;
    minTick: number;
}): number {
    const halfSpread = Math.max(0, args.spreadBps) / 2;
    const volAdj = Math.max(0, args.volBps) * 0.15;
    const staleAdj = Math.max(0, args.stalenessMs) / 400;

    const totalOffsetBps = halfSpread + volAdj + staleAdj;
    const offsetFraction = totalOffsetBps / 10_000;

    let quote: number;
    if (args.side === 'buy') {
        quote = args.mid * (1 - offsetFraction);
    } else {
        quote = args.mid * (1 + offsetFraction);
    }

    // Round to minTick
    if (args.minTick > 0) {
        quote = Math.round(quote / args.minTick) * args.minTick;
    }

    return quote;
}

/**
 * Load reprice config from environment.
 */
export function loadRepriceConfig(): Partial<RepriceConfig> {
    const toNumber = (val: string | undefined): number | undefined => {
        if (val === undefined) return undefined;
        const parsed = Number(val);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const config: Partial<RepriceConfig> = {};
    const drift = toNumber(process.env.REPRICE_DRIFT_THRESHOLD_BPS);
    if (drift !== undefined) config.driftThresholdBps = drift;
    const hardStale = toNumber(process.env.REPRICE_HARD_STALENESS_MS);
    if (hardStale !== undefined) config.hardStalenessLimitMs = hardStale;
    const churn = toNumber(process.env.REPRICE_CHURN_LIMIT_PER_MIN);
    if (churn !== undefined) config.defaultChurnLimitPerMin = churn;

    return config;
}
