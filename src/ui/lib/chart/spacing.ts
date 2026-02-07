/**
 * TradingView-Style Spacing Calculator
 * Implements professional candle spacing with dynamic pixel-aware widths
 */

import { SpacingConfig, SpacingTier, AdaptiveScalingOptions, DEFAULT_SCALING_OPTIONS } from './types';

/**
 * TradingView-style spacing constants
 * Professional chart appearance with crisp, readable candles
 */
export const BINANCE_SPACING = {
    /** Base spacing for 0-2 decimal assets - slim professional look */
    BASE_SPACING: 6,
    /** Spacing for 3-4 decimal assets */
    MEDIUM_SPACING: 7,
    /** Spacing for 5-6 decimal assets */
    EXTENDED_SPACING: 8,
    /** Spacing for 7-8 decimal assets */
    HIGH_PRECISION_SPACING: 10,
    /** Spacing for 9+ decimal assets */
    MICRO_SPACING: 12,
    /** Absolute minimum spacing - never go below 2px for readability */
    MIN_CLAMP: 2,
    /** Absolute maximum spacing - never exceed 10px for cleanliness */
    MAX_CLAMP: 14,
    /** Micro-price threshold (price < this uses thicker candles) */
    MICRO_PRICE_THRESHOLD: 0.0001,
    /** Growth factor per decimal beyond base */
    GROWTH_PER_DECIMAL: 0.15,
    /** Minimum gap between candles (25% of width) */
    GAP_RATIO: 0.25,
    /** Candle body to total width ratio (75%) */
    BODY_RATIO: 0.75,
};

/**
 * Calculate Binance-style bar spacing based on decimal precision
 */
export function calculateBinanceSpacing(
    precision: number,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): number {
    const tier = getSpacingTier(precision);
    const tierSpacing = getSpacingForTier(tier);
    return Math.max(options.minBarSpacing, Math.min(options.maxBarSpacing, tierSpacing));
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
    if (options.thickMicroCandles && currentPrice <= BINANCE_SPACING.MICRO_PRICE_THRESHOLD) {
        // Increase spacing by 20% for micro-priced assets
        spacing = Math.min(spacing + 1, options.maxBarSpacing);
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
    // Volume bars are 70% of candle width for clean separation
    return Math.max(1, Math.floor(candleSpacing * 0.7));
}

/**
 * Calculate dynamic candle width based on chart dimensions and data count
 * This is the core of TradingView-style pixel-aware rendering
 */
export function calculateDynamicBarSpacing(
    chartWidth: number,
    dataLength: number,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): number {
    if (chartWidth <= 0 || dataLength <= 0) {
        return options.baseBarSpacing;
    }

    // Calculate ideal candle width: 75% of available space per candle
    const availablePerCandle = chartWidth / dataLength;
    const candleWidth = Math.floor(availablePerCandle * BINANCE_SPACING.BODY_RATIO);

    // Clamp to professional bounds: never below 2px, never above 10px
    return Math.max(
        BINANCE_SPACING.MIN_CLAMP,
        Math.min(BINANCE_SPACING.MAX_CLAMP, candleWidth)
    );
}

/**
 * Calculate gap between candles
 */
export function calculateCandleGap(candleWidth: number): number {
    return Math.max(1, Math.floor(candleWidth * BINANCE_SPACING.GAP_RATIO));
}

/**
 * Adjust spacing for zoom level
 * Maintains visual consistency across zoom levels
 */
export function adjustSpacingForZoom(
    baseSpacing: number,
    zoomLevel: number,
    _options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): number {
    // zoomLevel: 1 = default, >1 = zoomed in, <1 = zoomed out
    const adjusted = baseSpacing * zoomLevel;
    return Math.max(BINANCE_SPACING.MIN_CLAMP, Math.min(BINANCE_SPACING.MAX_CLAMP, adjusted));
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
 * Calculate spacing adjustments for high candle counts (zoom safety)
 * When candle count > 150, compress width and optionally disable wicks
 */
export function calculateZoomSafeSpacing(
    chartWidth: number,
    dataLength: number,
    baseSpacing: number
): { barSpacing: number; disableWicks: boolean } {
    const dynamicSpacing = calculateDynamicBarSpacing(chartWidth, dataLength);

    // For very high candle counts, use compressed spacing
    if (dataLength > 150) {
        const compressedSpacing = Math.max(
            BINANCE_SPACING.MIN_CLAMP,
            Math.min(dynamicSpacing, 4)
        );
        return {
            barSpacing: compressedSpacing,
            disableWicks: compressedSpacing < 2, // Disable wicks if too thin
        };
    }

    return {
        barSpacing: Math.max(baseSpacing, dynamicSpacing),
        disableWicks: false,
    };
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
