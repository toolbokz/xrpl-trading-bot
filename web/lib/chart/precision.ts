/**
 * Precision Detection Module
 * Detects and manages decimal precision for OHLC data
 */

import { OHLCData, PrecisionConfig } from './types';

/**
 * Count decimal places in a number
 * Handles floating point edge cases
 */
export function countDecimals(value: number): number {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
        return 0;
    }

    // Handle zero
    if (value === 0) {
        return 0;
    }

    // Convert to string and handle scientific notation
    const str = Math.abs(value).toString();

    // Handle scientific notation (e.g., 1.23e-7)
    if (str.includes('e')) {
        const parts = str.split('e');
        const mantissa = parts[0];
        const exponent = parts[1];
        if (!mantissa || !exponent) return 0;

        const exp = parseInt(exponent, 10);
        const mantissaDecimals = mantissa.includes('.')
            ? mantissa.split('.')[1]?.length ?? 0
            : 0;

        if (exp < 0) {
            return Math.min(mantissaDecimals - exp, 18); // Cap at 18 decimals
        }
        return Math.max(0, mantissaDecimals - exp);
    }

    // Standard decimal notation
    if (str.includes('.')) {
        const decimalPart = str.split('.')[1];
        if (!decimalPart) return 0;
        // Trim trailing zeros for actual precision
        const trimmed = decimalPart.replace(/0+$/, '');
        return trimmed.length;
    }

    return 0;
}

/**
 * Detect maximum precision from a single OHLC data point
 */
export function detectOHLCPrecision(data: OHLCData): number {
    return Math.max(
        countDecimals(data.open),
        countDecimals(data.high),
        countDecimals(data.low),
        countDecimals(data.close)
    );
}

/**
 * Detect maximum precision across an array of OHLC data
 */
export function detectDatasetPrecision(data: OHLCData[]): number {
    if (!data || data.length === 0) {
        return 2; // Default precision
    }

    let maxPrecision = 0;
    for (const candle of data) {
        const precision = detectOHLCPrecision(candle);
        if (precision > maxPrecision) {
            maxPrecision = precision;
        }
    }

    return maxPrecision;
}

/**
 * Detect precision from a streaming update
 * More efficient for single candle updates
 */
export function detectStreamingPrecision(
    currentPrecision: number,
    newCandle: OHLCData
): number {
    const newPrecision = detectOHLCPrecision(newCandle);
    return Math.max(currentPrecision, newPrecision);
}

/**
 * Create precision configuration from detected precision
 */
export function createPrecisionConfig(precision: number): PrecisionConfig {
    // Clamp precision to reasonable bounds (0-18)
    const clampedPrecision = Math.max(0, Math.min(18, precision));
    const minMove = Math.pow(10, -clampedPrecision);

    return {
        precision: clampedPrecision,
        minMove,
        tickSize: minMove,
    };
}

/**
 * Check if precision has changed significantly enough to warrant an update
 * Prevents unnecessary re-renders for minor precision fluctuations
 */
export function shouldUpdatePrecision(
    currentPrecision: number,
    newPrecision: number
): boolean {
    // Always update if precision increased
    if (newPrecision > currentPrecision) {
        return true;
    }

    // Don't decrease precision automatically (could lose detail)
    // Only decrease if significantly lower (3+ decimals less)
    if (newPrecision < currentPrecision - 2) {
        return true;
    }

    return false;
}

/**
 * Format a price value with the given precision
 */
export function formatPrice(value: number, precision: number): string {
    if (!Number.isFinite(value)) {
        return '0';
    }
    return value.toFixed(precision);
}

/**
 * Round a price to the given precision (for order placement, etc.)
 */
export function roundToMinMove(value: number, minMove: number): number {
    if (!Number.isFinite(value) || minMove <= 0) {
        return value;
    }
    return Math.round(value / minMove) * minMove;
}
