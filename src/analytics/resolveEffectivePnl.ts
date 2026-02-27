/**
 * Shared resolveEffectivePnl — single source of truth for PnL derivation.
 *
 * Used by both the backend TradeHistoryService (src/analytics/tradeHistory.ts)
 * and the web-side WebTradeHistoryService (src/ui/lib/tradeHistory.ts).
 *
 * This module must NOT import from modules that are only available in one
 * compilation target (e.g., no Next.js APIs, no runtime singletons).
 *
 * Units: result is in quote currency (e.g. RLUSD) unless noted otherwise.
 */

import { PNL_EPSILON } from './metricUtils';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal trade interface (structural subset compatible with both Trade types)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill snapshot from execution trace.
 */
export interface FillSnapshot {
    filled_base: number | null;
    filled_quote: number | null;
    avg_price: number | null;
    fee: number | null;
}

/**
 * Minimal trace interface needed for PnL derivation.
 */
export interface MinimalTrace {
    baseline_mid: number | null;
    fee_drops: string | null;
    fill_snapshot: FillSnapshot | null;
}

/**
 * Minimal trade interface — structural subset that both backend and UI
 * Trade types satisfy.
 */
export interface MinimalTrade {
    pnl: number;
    side: 'BUY' | 'SELL';
    price: number;
    filled: number;
    pair: string;
    /** Available on backend Trade; optional for web Trade. */
    priceQuotePerBase?: number;
    /** Available on backend Trade; optional for web Trade. */
    filledBase?: number;
    trace?: MinimalTrace;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether the base currency of a pair is XRP.
 *
 * Heuristic: parse pair key "BASE/QUOTE" and check if base === "XRP".
 * This matters for tx-fee conversion: XRPL fees are always in XRP drops.
 *
 * For XRP-base pairs (e.g. XRP/RLUSD), fillPrice is RLUSD-per-XRP,
 * so feeXrp * fillPrice gives the fee in quote currency.
 *
 * For non-XRP-base pairs (e.g. RLUSD/USD), fillPrice is USD-per-RLUSD,
 * and we need a separate XRP→quote rate to convert the fee.
 * We don't have it, so we log a warning and approximate.
 */
function isXrpBasePair(pair: string): boolean {
    const slash = pair.indexOf('/');
    if (slash < 0) return pair.toUpperCase() === 'XRP';
    return pair.substring(0, slash).toUpperCase() === 'XRP';
}

/**
 * Rate-limited warning tracker for fee conversion ambiguity.
 * Only fires once per pair per process lifetime to avoid log spam.
 */
const feeConversionWarnedPairs = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────
// Core function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the effective PnL for a trade.
 *
 * Priority:
 *   1. Use trade.pnl when it is meaningfully non-zero (|pnl| > PNL_EPSILON).
 *   2. Compute an edge-based proxy from trace data (mid vs fill price),
 *      subtracting fees if available.
 *   3. Return null if insufficient data (unclassifiable).
 *
 * Fee conversion:
 *   - TX fee is always in XRP drops (XRPL invariant).
 *   - For XRP-base pairs, fillPrice is quote-per-XRP, so fee_xrp * fillPrice
 *     converts precisely to quote currency.
 *   - For non-XRP-base pairs, this is an APPROXIMATION. A diagnostic warning
 *     is emitted (rate-limited) and the fee is still subtracted using fillPrice
 *     as a rough conversion factor. This is conservative (may overstate fee)
 *     but avoids ignoring fees entirely.
 *
 * @returns PnL in quote currency, or null if unclassifiable.
 */
export function resolveEffectivePnl(trade: MinimalTrade): number | null {
    // 1. Explicit PnL available and non-zero?
    if (Number.isFinite(trade.pnl) && Math.abs(trade.pnl) > PNL_EPSILON) {
        return trade.pnl;
    }

    // 2. Attempt trace-based edge proxy
    const trace = trade.trace;
    const fillSnap = trace?.fill_snapshot;
    const midPrice = trace?.baseline_mid;

    // Determine fill price and fill base from best-available source
    const fillPrice = fillSnap?.avg_price
        ?? (trade.priceQuotePerBase != null && trade.priceQuotePerBase > 0
            ? trade.priceQuotePerBase
            : null)
        ?? (trade.price > 0 ? trade.price : null);
    const fillBase = fillSnap?.filled_base
        ?? (trade.filledBase != null && trade.filledBase > 0
            ? trade.filledBase
            : null)
        ?? (trade.filled > 0 ? trade.filled : null);

    if (
        fillPrice != null && fillPrice > 0 &&
        fillBase != null && fillBase > 0 &&
        midPrice != null && midPrice > 0
    ) {
        // Edge in quote currency: for BUY, buying below mid is profit;
        // for SELL, selling above mid is profit.
        const rawDelta = fillPrice - midPrice; // positive = fill above mid
        const edgeQuote = trade.side === 'BUY'
            ? -rawDelta * fillBase
            : rawDelta * fillBase;

        // ── Fee deduction ───────────────────────────────────────────────
        let feeQuote = 0;
        const feeDropsStr = trace?.fee_drops;
        const txFeeXrp = feeDropsStr != null ? Number(feeDropsStr) / 1_000_000 : 0;

        if (txFeeXrp > 0 && Number.isFinite(txFeeXrp)) {
            const xrpBase = isXrpBasePair(trade.pair);

            if (xrpBase) {
                // XRP is base → fillPrice is quote-per-XRP → exact conversion
                feeQuote = txFeeXrp * fillPrice;
            } else {
                // Non-XRP base → fillPrice is NOT XRP-denominated.
                // We don't have an explicit XRP→quote rate.
                // Approximation: use fillPrice anyway (conservative — may
                // overstate fee for issued-base pairs where fillPrice >> 1).
                feeQuote = txFeeXrp * fillPrice;

                // Emit once-per-pair warning about approximate conversion
                if (!feeConversionWarnedPairs.has(trade.pair)) {
                    feeConversionWarnedPairs.add(trade.pair);
                    logger.warn(
                        {
                            pair: trade.pair,
                            txFeeXrp,
                            fillPrice,
                            approxFeeQuote: feeQuote,
                        },
                        `[resolveEffectivePnl] Non-XRP-base pair "${trade.pair}": `
                        + 'tx fee conversion uses fillPrice as approximation. '
                        + 'Fee may be overstated. TODO: add explicit XRP→quote rate.',
                    );
                }
            }
        }

        // fill_snapshot.fee is ledger-reported in quote currency (more precise)
        if (fillSnap?.fee != null && fillSnap.fee > 0) {
            feeQuote = Math.max(feeQuote, fillSnap.fee);
        }

        return edgeQuote - feeQuote;
    }

    // 3. Insufficient data
    return null;
}
