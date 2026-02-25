/**
 * Shared metric utilities for PnL classification, profit factor,
 * win rate, and diagnostic logging.
 *
 * All PF/WR computation sites should use these canonical helpers
 * to ensure consistent behavior across dashboard, capital protection,
 * feedback engine, and chart/heatmap layers.
 *
 * Units note: PnL values passed here are in quote currency (e.g., RLUSD)
 * unless documented otherwise at the call site.
 */

import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Epsilon for PnL win/loss classification.
 *
 * Values with |pnl| <= PNL_EPSILON are classified as "breakeven" and
 * excluded from the win/loss denominator.
 *
 * Magnitude rationale:
 *   - Typical trade PnL is O(0.001–1) quote units for XRP/RLUSD.
 *   - 1e-9 is well below any meaningful trade outcome.
 *   - This avoids classifying floating-point rounding artefacts as wins/losses
 *     while being far too small to mask any real P&L.
 */
export const PNL_EPSILON = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
// PnL Classification
// ─────────────────────────────────────────────────────────────────────────────

export type PnlClass = 'win' | 'loss' | 'breakeven';

/**
 * Classify a PnL value using epsilon-aware comparison.
 */
export function classifyPnl(pnl: number): PnlClass {
    if (!Number.isFinite(pnl)) return 'breakeven';
    if (pnl > PNL_EPSILON) return 'win';
    if (pnl < -PNL_EPSILON) return 'loss';
    return 'breakeven';
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Profit Factor
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfitFactorOptions {
    /**
     * Cap the result for visualization layers (charts, heatmaps).
     * Risk/capital-protection callers should NOT cap — they need Infinity
     * to distinguish "all wins" from "good but finite".
     * Default: no cap (Infinity preserved).
     */
    displayCap?: number;
}

/**
 * Compute profit factor with a single canonical policy:
 *   - no data (gain=0, loss=0)   → 1.0  (neutral / no information)
 *   - all wins (gain>0, loss=0)  → Infinity (optionally capped for display)
 *   - mixed                      → gain / loss
 *   - all losses (gain=0, loss>0) → 0
 *
 * @param totalGain  Sum of positive PnL (>= 0)
 * @param totalLoss  Sum of |negative PnL| (>= 0, always positive magnitude)
 * @param options    Optional display cap
 */
export function computeProfitFactorCanonical(
    totalGain: number,
    totalLoss: number,
    options?: ProfitFactorOptions,
): number {
    const gain = Math.max(0, totalGain);
    const loss = Math.max(0, totalLoss);

    let pf: number;
    if (loss === 0) {
        pf = gain > 0 ? Infinity : 1;
    } else {
        pf = gain / loss;
    }

    if (options?.displayCap != null && !Number.isFinite(pf)) {
        pf = options.displayCap;
    } else if (options?.displayCap != null && pf > options.displayCap) {
        pf = options.displayCap;
    }

    return pf;
}

/**
 * Make a PF value safe for JSON serialization (Infinity → cap).
 * Used as the last step before returning from APIs or writing to stores.
 */
export function pfToFinite(pf: number, cap: number = 100): number {
    if (!Number.isFinite(pf)) return cap;
    return pf;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rolling-Window Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifiabilityReport {
    total: number;
    classifiable: number;
    breakeven: number;
    unclassifiableReasons: {
        missingMidPrice: number;
        zeroFillSize: number;
        missingFeeConversion: number;
        breakeven: number;
        nonFillEvent: number;
    };
    ratio: number; // classifiable / total, 0 if total=0
}

/**
 * Emit diagnostic warnings when rolling-window quality is poor.
 *
 * @param context    A label for the computation site (e.g., 'getRollingRiskMetrics')
 * @param report     The classifiability report
 * @param rateLimit  Optional: last warn timestamp ref, to avoid log spam
 */
export function warnOnPoorClassifiability(
    context: string,
    report: ClassifiabilityReport,
    rateLimit?: { lastWarnTs: number; intervalMs: number },
): void {
    const now = Date.now();
    if (rateLimit && (now - rateLimit.lastWarnTs) < rateLimit.intervalMs) {
        return;
    }

    if (report.total === 0) return;

    if (report.classifiable === 0) {
        logger.warn(
            { context, ...report },
            `[${context}] 0 classifiable trades out of ${report.total} — WR/PF metrics are meaningless`,
        );
        if (rateLimit) rateLimit.lastWarnTs = now;
        return;
    }

    if (report.ratio < 0.5) {
        logger.warn(
            { context, ...report },
            `[${context}] Only ${(report.ratio * 100).toFixed(0)}% of ${report.total} trades classifiable — metrics may be unreliable`,
        );
        if (rateLimit) rateLimit.lastWarnTs = now;
        return;
    }

    // Log at debug level when there's some attrition but it's not critical
    if (report.breakeven > 0 || report.total - report.classifiable > 0) {
        logger.debug(
            { context, classifiable: report.classifiable, total: report.total, breakeven: report.breakeven },
            `[${context}] ${report.classifiable}/${report.total} trades classifiable`,
        );
    }
}
