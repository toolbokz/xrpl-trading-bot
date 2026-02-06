/**
 * Logarithmic Scale Detection Module
 * Determines when to switch between linear and logarithmic price scales
 */

import { OHLCData, ScaleMode, AdaptiveScalingOptions, DEFAULT_SCALING_OPTIONS } from './types';

/**
 * Calculate the order of magnitude span in a dataset
 * Returns the number of orders of magnitude between min and max prices
 */
export function calculateMagnitudeSpan(data: OHLCData[]): number {
    if (!data || data.length === 0) {
        return 0;
    }

    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (const candle of data) {
        const close = candle.close;
        if (close > 0 && close < minPrice) minPrice = close;
        if (close > maxPrice) maxPrice = close;
    }

    if (minPrice <= 0 || maxPrice <= 0 || !Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
        return 0;
    }

    if (Math.abs(maxPrice - minPrice) < Number.EPSILON) {
        return 0;
    }

    // Calculate orders of magnitude difference
    const magnitudeSpan = Math.log10(maxPrice) - Math.log10(minPrice);
    return Math.abs(magnitudeSpan);
}

/**
 * Calculate magnitude span from min/max values directly
 */
export function calculateMagnitudeSpanFromRange(minPrice: number, maxPrice: number): number {
    if (minPrice <= 0 || maxPrice <= 0 || !Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
        return 0;
    }

    if (Math.abs(maxPrice - minPrice) < Number.EPSILON) {
        return 0;
    }

    const magnitudeSpan = Math.log10(maxPrice) - Math.log10(minPrice);
    return Math.abs(magnitudeSpan);
}

/**
 * Determine if logarithmic scale should be enabled
 */
export function shouldUseLogScale(
    data: OHLCData[],
    precision: number,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): boolean {
    const { logScaleMagnitudeThreshold, logScalePrecisionThreshold } = options;

    // Check precision threshold
    if (precision > logScalePrecisionThreshold) {
        return true;
    }

    // Check magnitude span
    const magnitudeSpan = calculateMagnitudeSpan(data);
    if (magnitudeSpan > logScaleMagnitudeThreshold) {
        return true;
    }

    return false;
}

/**
 * Determine scale mode with streaming update consideration
 */
export function determineScaleMode(
    data: OHLCData[],
    precision: number,
    currentMode: ScaleMode,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): ScaleMode {
    const shouldLog = shouldUseLogScale(data, precision, options);

    if (shouldLog) {
        return 'logarithmic';
    }

    // Add hysteresis to prevent rapid switching
    // Only revert to linear if conditions are clearly normalized
    if (currentMode === 'logarithmic') {
        const magnitudeSpan = calculateMagnitudeSpan(data);
        // Require span to be significantly below threshold before reverting
        if (magnitudeSpan < options.logScaleMagnitudeThreshold * 0.7 &&
            precision < options.logScalePrecisionThreshold - 1) {
            return 'linear';
        }
        return 'logarithmic'; // Keep current mode
    }

    return 'linear';
}

/**
 * Check if scale mode transition is safe
 * Validates that the chart can safely switch modes without data issues
 */
export function isScaleTransitionSafe(data: OHLCData[]): boolean {
    if (!data || data.length === 0) {
        return true;
    }

    // Check for zero or negative prices (log scale requires positive values)
    for (const candle of data) {
        if (candle.low <= 0 || candle.high <= 0 || candle.open <= 0 || candle.close <= 0) {
            return false;
        }
    }

    return true;
}

/**
 * Get scale mode display name for UI
 */
export function getScaleModeDisplayName(mode: ScaleMode): string {
    return mode === 'logarithmic' ? 'Log' : 'Linear';
}

/**
 * Calculate price range for scale configuration
 */
export function calculatePriceRange(data: OHLCData[]): { min: number; max: number } {
    if (!data || data.length === 0) {
        return { min: 0, max: 1 };
    }

    let min = Infinity;
    let max = -Infinity;

    for (const candle of data) {
        if (candle.low < min) min = candle.low;
        if (candle.high > max) max = candle.high;
    }

    // Add padding (5% on each side)
    const range = max - min;
    const padding = range * 0.05;

    return {
        min: Math.max(0, min - padding),
        max: max + padding,
    };
}

/**
 * Calculate visible price range for log scale
 */
export function calculateLogScaleRange(data: OHLCData[]): { min: number; max: number } {
    const range = calculatePriceRange(data);

    // Ensure positive values for log scale
    const safeMin = Math.max(range.min, 1e-10);
    const safeMax = Math.max(range.max, safeMin * 10);

    return { min: safeMin, max: safeMax };
}
