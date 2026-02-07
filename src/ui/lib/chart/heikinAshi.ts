/**
 * Heikin-Ashi Candlestick Module
 * Calculates Heikin-Ashi candles with adaptive precision handling
 */

import { OHLCData, HeikinAshiData } from './types';
import { detectOHLCPrecision } from './precision';

/**
 * Calculate a single Heikin-Ashi candle from OHLC data
 * Requires previous HA candle for proper calculation
 */
export function calculateHACandle(
    current: OHLCData,
    previousHA: HeikinAshiData | null
): HeikinAshiData {
    // HA Close = (Open + High + Low + Close) / 4
    const haClose = (current.open + current.high + current.low + current.close) / 4;

    // HA Open = (Previous HA Open + Previous HA Close) / 2
    // For first candle, use (Current Open + Current Close) / 2
    const haOpen = previousHA
        ? (previousHA.open + previousHA.close) / 2
        : (current.open + current.close) / 2;

    // HA High = Max(High, HA Open, HA Close)
    const haHigh = Math.max(current.high, haOpen, haClose);

    // HA Low = Min(Low, HA Open, HA Close)
    const haLow = Math.min(current.low, haOpen, haClose);

    return {
        time: current.time,
        open: haOpen,
        high: haHigh,
        low: haLow,
        close: haClose,
        originalOpen: current.open,
        originalHigh: current.high,
        originalLow: current.low,
        originalClose: current.close,
    };
}

/**
 * Convert an array of OHLC data to Heikin-Ashi candles
 */
export function convertToHeikinAshi(data: OHLCData[]): HeikinAshiData[] {
    if (!data || data.length === 0) {
        return [];
    }

    const result: HeikinAshiData[] = [];
    let previousHA: HeikinAshiData | null = null;

    for (const candle of data) {
        const haCandle = calculateHACandle(candle, previousHA);
        result.push(haCandle);
        previousHA = haCandle;
    }

    return result;
}

/**
 * Update the last Heikin-Ashi candle with new OHLC data
 * Used for streaming updates
 */
export function updateLastHACandle(
    haCandles: HeikinAshiData[],
    newOHLC: OHLCData
): HeikinAshiData[] {
    if (haCandles.length === 0) {
        // First candle
        return [calculateHACandle(newOHLC, null)];
    }

    const result = [...haCandles];
    const lastIndex = result.length - 1;
    const lastCandle = result[lastIndex];
    const prevCandle = lastIndex > 0 ? result[lastIndex - 1] : null;
    const previousHA = prevCandle ?? null;

    if (!lastCandle) {
        // Safety check - should not happen since we already checked haCandles.length
        return [calculateHACandle(newOHLC, null)];
    }

    // Check if this is an update to the current candle or a new candle
    const lastTime = typeof lastCandle.time === 'number'
        ? lastCandle.time
        : Number(lastCandle.time);
    const newTime = typeof newOHLC.time === 'number'
        ? newOHLC.time
        : Number(newOHLC.time);

    if (newTime === lastTime) {
        // Update existing candle
        result[lastIndex] = calculateHACandle(newOHLC, previousHA);
    } else if (newTime > lastTime) {
        // New candle
        const newHA = calculateHACandle(newOHLC, lastCandle);
        result.push(newHA);
    }

    return result;
}

/**
 * Append a new Heikin-Ashi candle from new OHLC data
 */
export function appendHACandle(
    haCandles: HeikinAshiData[],
    newOHLC: OHLCData
): HeikinAshiData[] {
    const lastCandle = haCandles.length > 0 ? haCandles[haCandles.length - 1] : null;
    const previousHA = lastCandle ?? null;
    const newHA = calculateHACandle(newOHLC, previousHA);
    return [...haCandles, newHA];
}

/**
 * Detect decimal precision from Heikin-Ashi data
 * HA values can have higher precision due to averaging
 */
export function detectHAPrecision(data: HeikinAshiData[]): number {
    if (!data || data.length === 0) {
        return 2;
    }

    // HA calculation can increase precision due to division by 4
    // We need to check both HA values and original values
    let maxPrecision = 0;

    for (const candle of data) {
        // Check HA values
        const haPrecision = detectOHLCPrecision(candle);

        // Check original values if available
        const originalPrecision = candle.originalClose !== undefined
            ? Math.max(
                countDecimalsSimple(candle.originalOpen || 0),
                countDecimalsSimple(candle.originalHigh || 0),
                countDecimalsSimple(candle.originalLow || 0),
                countDecimalsSimple(candle.originalClose || 0)
            )
            : 0;

        maxPrecision = Math.max(maxPrecision, haPrecision, originalPrecision);
    }

    // HA calculation can add up to 2 extra decimals due to /4 operation
    // But we cap it to prevent excessive precision
    return Math.min(maxPrecision + 2, 12);
}

/**
 * Simple decimal counter (inlined for performance)
 */
function countDecimalsSimple(value: number): number {
    if (!Number.isFinite(value) || value === 0) return 0;
    const str = Math.abs(value).toString();
    if (!str.includes('.')) return 0;
    return str.split('.')[1]?.replace(/0+$/, '').length || 0;
}

/**
 * Check if data is Heikin-Ashi (has original values)
 */
export function isHeikinAshiData(data: OHLCData[]): data is HeikinAshiData[] {
    if (!data || data.length === 0) return false;
    const first = data[0] as HeikinAshiData;
    return first.originalClose !== undefined;
}

/**
 * Extract original OHLC data from Heikin-Ashi data
 */
export function extractOriginalOHLC(haData: HeikinAshiData[]): OHLCData[] {
    return haData.map((ha) => ({
        time: ha.time,
        open: ha.originalOpen ?? ha.open,
        high: ha.originalHigh ?? ha.high,
        low: ha.originalLow ?? ha.low,
        close: ha.originalClose ?? ha.close,
    }));
}

/**
 * Calculate Heikin-Ashi trend direction
 * Returns: 1 for bullish, -1 for bearish, 0 for neutral
 */
export function getHATrend(candle: HeikinAshiData): number {
    // Strong bullish: no lower wick
    if (candle.low === Math.min(candle.open, candle.close)) {
        return 1;
    }
    // Strong bearish: no upper wick
    if (candle.high === Math.max(candle.open, candle.close)) {
        return -1;
    }
    // Neutral/indecision
    return 0;
}

/**
 * Calculate Heikin-Ashi body percentage (body size / total range)
 */
export function getHABodyRatio(candle: HeikinAshiData): number {
    const totalRange = candle.high - candle.low;
    if (totalRange === 0) return 0;
    const bodySize = Math.abs(candle.close - candle.open);
    return bodySize / totalRange;
}
