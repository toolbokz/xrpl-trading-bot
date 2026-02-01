/**
 * Binance-Style Spacing Calculator
 * Implements candle spacing logic matching Binance UX
 */

import { SpacingConfig, SpacingTier, AdaptiveScalingOptions, DEFAULT_SCALING_OPTIONS } from './types';

/**
 * Binance spacing constants
 * Derived from observing Binance chart behavior
 */
export const BINANCE_SPACING = {
    /** Base spacing for 0-2 decimal assets (BTC, ETH) */
    BASE_SPACING: 6,
    /** Spacing for 3-4 decimal assets */
    MEDIUM_SPACING: 7,
    /** Spacing for 5-6 decimal assets (mid-cap alts) */
    EXTENDED_SPACING: 8,
    /** Spacing for 7-8 decimal assets (low-cap, meme) */
    HIGH_PRECISION_SPACING: 10,
    /** Spacing for 9+ decimal assets (micro-priced) */
    MICRO_SPACING: 12,
    /** Absolute minimum spacing */
    MIN_CLAMP: 4,
    /** Absolute maximum spacing */
    MAX_CLAMP: 24,
    /** Micro-price threshold (price < this uses thicker candles) */
    MICRO_PRICE_THRESHOLD: 0.0001,
    /** Growth factor per decimal beyond base */
    GROWTH_PER_DECIMAL: 0.5,
};

/**
 * Calculate Binance-style bar spacing based on decimal precision
 */
export function calculateBinanceSpacing(
    precision: number,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): number {
    const {
        baseBarSpacing,
        spacingGrowthPerDecimal,
        minBarSpacing,
        maxBarSpacing,
    } = options;

    // Base case: 0-2 decimals
    if (precision <= 2) {
        return baseBarSpacing;
    }

    // Progressive spacing growth for higher precision
    const extraDecimals = precision - 2;
    const rawSpacing = baseBarSpacing + (extraDecimals * spacingGrowthPerDecimal);

    // Clamp to bounds
    return Math.max(minBarSpacing, Math.min(maxBarSpacing, rawSpacing));
}

/**
 * Calculate spacing with micro-price adjustment
 * Micro-priced assets get slightly thicker candles for visibility
 */
export function calculateSpacingWithMicroAdjustment(
    precision: number,
    currentPrice: number,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): number {
    let spacing = calculateBinanceSpacing(precision, options);

    // Apply micro-price adjustment for very small prices
    if (options.thickMicroCandles && currentPrice < BINANCE_SPACING.MICRO_PRICE_THRESHOLD) {
        // Increase spacing by 20% for micro-priced assets
        spacing = Math.min(spacing * 1.2, options.maxBarSpacing);
    }

    return spacing;
}

/**
 * Get preset spacing tier name based on precision
 * Uses Binance-observed spacing tiers
 */
export function getSpacingTier(precision: number): SpacingTier {
    if (precision <= 2) return 'base';
    if (precision <= 4) return 'medium';
    if (precision <= 6) return 'extended';
    if (precision <= 8) return 'highPrecision';
    return 'micro';
}

/**
 * Get spacing value for a tier
 */
export function getSpacingForTier(tier: SpacingTier): number {
    switch (tier) {
        case 'base': return BINANCE_SPACING.BASE_SPACING;
        case 'medium': return BINANCE_SPACING.MEDIUM_SPACING;
        case 'extended': return BINANCE_SPACING.EXTENDED_SPACING;
        case 'highPrecision': return BINANCE_SPACING.HIGH_PRECISION_SPACING;
        case 'micro': return BINANCE_SPACING.MICRO_SPACING;
    }
}

/**
 * Create complete spacing configuration
 */
export function createSpacingConfig(
    precision: number,
    currentPrice: number = 1,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): SpacingConfig {
    const barSpacing = calculateSpacingWithMicroAdjustment(precision, currentPrice, options);
    const isMicroPrice = currentPrice < BINANCE_SPACING.MICRO_PRICE_THRESHOLD;
    const tier = getSpacingTier(precision);

    return {
        barSpacing,
        minBarSpacing: options.minBarSpacing,
        thinCandles: !isMicroPrice && precision <= 4,
        tier,
        volumeBarWidth: calculateVolumeBarWidth(barSpacing),
    };
}

/**
 * Calculate volume bar width relative to candle width
 * Volume bars should be proportionally scaled with candles
 */
export function calculateVolumeBarWidth(candleSpacing: number): number {
    // Volume bars are typically 80% of candle width
    return Math.max(1, candleSpacing * 0.8);
}

/**
 * Adjust spacing for zoom level
 * Maintains visual consistency across zoom levels
 */
export function adjustSpacingForZoom(
    baseSpacing: number,
    zoomLevel: number,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): number {
    // zoomLevel: 1 = default, >1 = zoomed in, <1 = zoomed out
    const adjusted = baseSpacing * zoomLevel;
    return Math.max(options.minBarSpacing, Math.min(options.maxBarSpacing, adjusted));
}

/**
 * Calculate optimal visible bar count based on container width
 */
export function calculateVisibleBars(
    containerWidth: number,
    barSpacing: number
): number {
    if (barSpacing <= 0 || containerWidth <= 0) {
        return 100; // Default fallback
    }
    return Math.floor(containerWidth / barSpacing);
}

/**
 * Interpolate spacing for smooth transitions
 */
export function interpolateSpacing(
    fromSpacing: number,
    toSpacing: number,
    progress: number // 0-1
): number {
    const clamped = Math.max(0, Math.min(1, progress));
    return fromSpacing + (toSpacing - fromSpacing) * clamped;
}
