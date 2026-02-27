/**
 * Unified order sizing pipeline ("Option A: one-knob sizing").
 *
 * The canonical function `computeFinalOrderSizeXrp()` computes the final order
 * size from a single primary knob (`BASE_ORDER_SIZE_XRP`) and three independent
 * multipliers (capital protection, regime policy, adaptive learning).
 *
 * The execution minimum base size is **derived** from the primary knob so that
 * scaling `BASE_ORDER_SIZE_XRP` keeps min sizes consistent automatically.
 *
 * @module execution/orderSizing
 */

import { logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CpMode = 'NORMAL' | 'THROTTLE' | 'PAUSE' | 'SHUTDOWN';

export interface OrderSizingContext {
    /** Capital protection mode (default: NORMAL) */
    cpMode: CpMode;
    /** Capital protection size multiplier (NORMAL=1, THROTTLE=CP_SIZE_THROTTLE_MULT, PAUSE/SHUTDOWN=0) */
    cpSizeMult: number;
    /** Regime policy size multiplier (default: 1.0) */
    regimeSizeMult: number;
    /** Adaptive learner size multiplier (default: 1.0) */
    adaptiveSizeMult: number;
    /** Strategy name (for logging) */
    strategy: string;
}

export interface OrderSizingResult {
    /** The primary knob value (BASE_ORDER_SIZE_XRP) */
    baseSize: number;
    /** Capital protection multiplier actually used */
    cpMult: number;
    /** Regime policy multiplier actually used */
    regimeMult: number;
    /** Adaptive learner multiplier actually used */
    adaptiveMult: number;
    /** Final clamped size in XRP */
    finalSize: number;
    /** Effective minimum size in XRP */
    minSize: number;
    /** Effective maximum size in XRP */
    maxSize: number;
    /** If set, the order should be skipped (not rejected) */
    skip: boolean;
    /** Human-readable reason (set when skip=true) */
    reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderSizingConfig {
    /** Primary sizing knob */
    baseOrderSizeXrp: number;
    /** Absolute maximum trade size (from MAX_TRADE_SIZE) */
    maxTradeSize: number;
    /** Fraction of base size used to derive execution min (default: 0.25) */
    executionMinBaseFrac: number;
    /** Explicit execution min base XRP (if set, effective min = max(explicit, derived)) */
    explicitMinBaseXrp: number | null;
    /** Explicit execution min quote RLUSD (kept for backward compat) */
    explicitMinQuoteRlusd: number | null;
}

/** Default fraction: min base = 25% of base order size */
const DEFAULT_EXECUTION_MIN_BASE_FRAC = 0.25;

const toFinitePositive = (val: string | undefined, fallback: number): number => {
    if (val === undefined) return fallback;
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const toFiniteNonNeg = (val: string | undefined): number | null => {
    if (val === undefined) return null;
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Load sizing config from environment.
 *
 * Precedence: BASE_ORDER_SIZE_XRP > POSITION_SIZE_XRP (deprecated).
 * Logs a deprecation warning when falling back.
 */
export function loadOrderSizingConfig(env: NodeJS.ProcessEnv = process.env): OrderSizingConfig {
    let baseOrderSizeXrp: number;
    const rawBase = env.BASE_ORDER_SIZE_XRP;
    const rawLegacy = env.POSITION_SIZE_XRP;

    if (rawBase !== undefined) {
        baseOrderSizeXrp = toFinitePositive(rawBase, 5);
    } else if (rawLegacy !== undefined) {
        baseOrderSizeXrp = toFinitePositive(rawLegacy, 5);
        logger.warn(
            { envVar: 'POSITION_SIZE_XRP', value: baseOrderSizeXrp },
            '[sizing] POSITION_SIZE_XRP is deprecated — migrate to BASE_ORDER_SIZE_XRP',
        );
    } else {
        baseOrderSizeXrp = 5;
    }

    const maxTradeSize = toFinitePositive(env.MAX_TRADE_SIZE, 1_000);

    const executionMinBaseFrac = (() => {
        const raw = env.EXECUTION_MIN_BASE_FRAC;
        if (raw === undefined) return DEFAULT_EXECUTION_MIN_BASE_FRAC;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_EXECUTION_MIN_BASE_FRAC;
    })();

    const explicitMinBaseXrp = toFiniteNonNeg(env.EXECUTION_MIN_BASE_XRP);
    const explicitMinQuoteRlusd = toFiniteNonNeg(env.EXECUTION_MIN_QUOTE_RLUSD);

    return {
        baseOrderSizeXrp,
        maxTradeSize,
        executionMinBaseFrac,
        explicitMinBaseXrp,
        explicitMinQuoteRlusd,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the effective execution minimum base in XRP.
 *
 * Policy: max(explicit EXECUTION_MIN_BASE_XRP, BASE_ORDER_SIZE_XRP * EXECUTION_MIN_BASE_FRAC)
 */
export function deriveMinBaseXrp(cfg: OrderSizingConfig): number {
    const derived = cfg.baseOrderSizeXrp * cfg.executionMinBaseFrac;
    if (cfg.explicitMinBaseXrp !== null) {
        return Math.max(cfg.explicitMinBaseXrp, derived);
    }
    return derived;
}

/**
 * Compute the effective execution minimum quote in RLUSD (best-effort).
 *
 * If a mid-price is available, derives from base order size * midPrice * frac.
 * Otherwise falls back to the explicit env var.
 */
export function deriveMinQuoteRlusd(cfg: OrderSizingConfig, midPrice: number | null): number {
    const derivedFromBase = midPrice != null && midPrice > 0
        ? cfg.baseOrderSizeXrp * midPrice * cfg.executionMinBaseFrac
        : null;
    const explicit = cfg.explicitMinQuoteRlusd;

    if (derivedFromBase !== null && explicit !== null) return Math.max(explicit, derivedFromBase);
    if (derivedFromBase !== null) return derivedFromBase;
    if (explicit !== null) return explicit;
    // No mid-price and no explicit env var: derive from base size assuming
    // a conservative 1:1 XRP-to-quote ratio.  This avoids the old hardcoded
    // 5 RLUSD floor that rejected legitimate small orders.
    return Math.max(0.01, cfg.baseOrderSizeXrp * cfg.executionMinBaseFrac);
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical sizing function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the final order size in XRP.
 *
 * This is the **single** sizing function that all strategies must call.
 *
 * ```
 * finalSizeXrp = clamp(
 *   BASE_ORDER_SIZE_XRP * cpSizeMult * regimeSizeMult * adaptiveSizeMult,
 *   min = executionMinBaseXrp,
 *   max = MAX_TRADE_SIZE
 * )
 * ```
 *
 * If the unclamped result is below `minSize`, the order is **skipped** (not
 * rejected) to avoid rejection spirals from throttling shrinkage.
 */
export function computeFinalOrderSizeXrp(
    ctx: OrderSizingContext,
    cfg: OrderSizingConfig,
): OrderSizingResult {
    const minSize = deriveMinBaseXrp(cfg);
    const maxSize = cfg.maxTradeSize;

    const raw = cfg.baseOrderSizeXrp * ctx.cpSizeMult * ctx.regimeSizeMult * ctx.adaptiveSizeMult;

    // Guard: if any multiplier drove the size below minimum, skip the order
    if (raw < minSize) {
        const result: OrderSizingResult = {
            baseSize: cfg.baseOrderSizeXrp,
            cpMult: ctx.cpSizeMult,
            regimeMult: ctx.regimeSizeMult,
            adaptiveMult: ctx.adaptiveSizeMult,
            finalSize: raw,
            minSize,
            maxSize,
            skip: true,
            reason: `final<min base=${cfg.baseOrderSizeXrp} cp=${ctx.cpSizeMult} regime=${ctx.regimeSizeMult} adaptive=${ctx.adaptiveSizeMult} final=${raw.toFixed(6)} min=${minSize}`,
        };

        logger.warn({
            strategy: ctx.strategy,
            base: cfg.baseOrderSizeXrp,
            cp: ctx.cpSizeMult,
            regime: ctx.regimeSizeMult,
            adaptive: ctx.adaptiveSizeMult,
            final: raw,
            min: minSize,
            mode: ctx.cpMode,
        }, '[size-skip] final<min');

        return result;
    }

    // Clamp to max
    const finalSize = Math.min(raw, maxSize);

    const result: OrderSizingResult = {
        baseSize: cfg.baseOrderSizeXrp,
        cpMult: ctx.cpSizeMult,
        regimeMult: ctx.regimeSizeMult,
        adaptiveMult: ctx.adaptiveSizeMult,
        finalSize,
        minSize,
        maxSize,
        skip: false,
    };

    logger.debug({
        strategy: ctx.strategy,
        base: cfg.baseOrderSizeXrp,
        cp: ctx.cpSizeMult,
        regime: ctx.regimeSizeMult,
        adaptive: ctx.adaptiveSizeMult,
        final: finalSize,
        min: minSize,
        max: maxSize,
        mode: ctx.cpMode,
    }, '[size] order sized');

    return result;
}

/**
 * Log the effective sizing config at startup for observability.
 */
export function logSizingConfigSummary(cfg: OrderSizingConfig): void {
    const minBaseXrp = deriveMinBaseXrp(cfg);
    logger.info({
        baseOrderSizeXrp: cfg.baseOrderSizeXrp,
        maxTradeSize: cfg.maxTradeSize,
        executionMinBaseFrac: cfg.executionMinBaseFrac,
        derivedMinBaseXrp: minBaseXrp,
        explicitMinBaseXrp: cfg.explicitMinBaseXrp,
        explicitMinQuoteRlusd: cfg.explicitMinQuoteRlusd,
    }, '[sizing] Effective sizing config (one-knob sizing active)');
}
