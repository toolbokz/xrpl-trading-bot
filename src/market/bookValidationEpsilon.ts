/**
 * Shared tolerance constants for order-book structural checks.
 *
 * These values only suppress epsilon-level float noise and should not
 * hide materially crossed or malformed books.
 */
export const BOOK_CROSS_EPS_ABS = 1e-6;
export const NEG_SPREAD_EPS_BPS = 0.1;
