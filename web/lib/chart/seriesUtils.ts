/**
 * Series Utilities for Candlestick Chart
 * 
 * Handles gap detection, whitespace data, incremental updates,
 * and price formatting for micro-prices.
 */

import { CandlestickData, WhitespaceData, HistogramData, Time } from 'lightweight-charts';
import { OHLCData, VolumeData, BINANCE_COLORS } from './types';

// =============================================================================
// Types
// =============================================================================

/** Extended candle data that can include whitespace for gaps */
export type CandleSeriesData = CandlestickData | WhitespaceData;

/** Extended volume data that can include whitespace for gaps */
export type VolumeSeriesData = HistogramData | WhitespaceData;

/** Candle with optional synthetic flag (fallback if whitespace doesn't work) */
export interface ExtendedOHLCData extends OHLCData {
    isSynthetic?: boolean;
}

/** Bar spacing by interval - stable values that don't change with data length */
export const INTERVAL_BAR_SPACING: Record<string, number> = {
    '1m': 6,
    '5m': 7,
    '15m': 8,
    '1h': 9,
    '4h': 10,
    '1d': 10,
};

// =============================================================================
// Gap Detection & Whitespace Building
// =============================================================================

/**
 * Build series data with proper gaps (whitespace items) instead of flat synthetic candles.
 * 
 * @param candles - Raw OHLC candles (may have gaps)
 * @param intervalSec - Interval in seconds (e.g., 60 for 1m)
 * @returns Array of CandlestickData with WhitespaceData for gaps
 */
export function buildSeriesDataWithGaps(
    candles: OHLCData[],
    intervalSec: number
): CandleSeriesData[] {
    if (!candles || candles.length === 0) return [];
    if (candles.length === 1) {
        return [ohlcToCandlestick(candles[0]!)];
    }

    const result: CandleSeriesData[] = [];

    for (let i = 0; i < candles.length; i++) {
        const current = candles[i]!;
        result.push(ohlcToCandlestick(current));

        // Check for gap to next candle
        if (i < candles.length - 1) {
            const next = candles[i + 1]!;
            const currentTime = typeof current.time === 'number' ? current.time : Number(current.time);
            const nextTime = typeof next.time === 'number' ? next.time : Number(next.time);

            let expectedTime = currentTime + intervalSec;

            // Insert whitespace items for each missing interval
            while (expectedTime < nextTime) {
                result.push({ time: expectedTime as Time });
                expectedTime += intervalSec;
            }
        }
    }

    return result;
}

/**
 * Build volume series data with gaps matching candle gaps.
 */
export function buildVolumeDataWithGaps(
    candles: OHLCData[],
    volumeData: VolumeData[],
    intervalSec: number
): VolumeSeriesData[] {
    if (!candles || candles.length === 0) return [];

    const result: VolumeSeriesData[] = [];
    const volumeMap = new Map<number, VolumeData>();

    // Build lookup map for volume by time
    for (const vol of volumeData) {
        const time = typeof vol.time === 'number' ? vol.time : Number(vol.time);
        volumeMap.set(time, vol);
    }

    for (let i = 0; i < candles.length; i++) {
        const current = candles[i]!;
        const currentTime = typeof current.time === 'number' ? current.time : Number(current.time);
        const vol = volumeMap.get(currentTime);
        const isBullish = current.close >= current.open;

        if (vol) {
            result.push({
                time: currentTime as Time,
                value: vol.value,
                color: isBullish ? BINANCE_COLORS.volume.up : BINANCE_COLORS.volume.down,
            });
        } else {
            // No volume data for this candle, use 0
            result.push({
                time: currentTime as Time,
                value: 0,
                color: isBullish ? BINANCE_COLORS.volume.up : BINANCE_COLORS.volume.down,
            });
        }

        // Add whitespace for gaps
        if (i < candles.length - 1) {
            const next = candles[i + 1]!;
            const nextTime = typeof next.time === 'number' ? next.time : Number(next.time);

            let expectedTime = currentTime + intervalSec;
            while (expectedTime < nextTime) {
                result.push({ time: expectedTime as Time });
                expectedTime += intervalSec;
            }
        }
    }

    return result;
}

// =============================================================================
// Incremental Update Detection
// =============================================================================

/**
 * Determine if series data needs full reset vs incremental update.
 * 
 * Returns true (needs reset) when:
 * - prev is empty or next is empty
 * - Data is out of order (next earliest > prev earliest)
 * - Pair/interval changed (detected externally)
 * - Data has significant discontinuity
 */
export function shouldResetSeries(
    prevData: OHLCData[] | null,
    nextData: OHLCData[]
): boolean {
    // No previous data - need initial setData
    if (!prevData || prevData.length === 0) return true;

    // No next data - clear needed
    if (!nextData || nextData.length === 0) return true;

    const prevFirst = prevData[0]!;
    const nextFirst = nextData[0]!;
    const prevLast = prevData[prevData.length - 1]!;
    const nextLast = nextData[nextData.length - 1]!;

    const prevFirstTime = typeof prevFirst.time === 'number' ? prevFirst.time : Number(prevFirst.time);
    const nextFirstTime = typeof nextFirst.time === 'number' ? nextFirst.time : Number(nextFirst.time);
    const prevLastTime = typeof prevLast.time === 'number' ? prevLast.time : Number(prevLast.time);
    const nextLastTime = typeof nextLast.time === 'number' ? nextLast.time : Number(nextLast.time);

    // Rewind detected: new data starts later than old data started
    if (nextFirstTime > prevFirstTime) return true;

    // Data went backwards: new last time is before old last time
    if (nextLastTime < prevLastTime) return true;

    // Significant change in data range (more than just appending)
    // If the first candle changed, we need reset
    if (nextFirstTime !== prevFirstTime) return true;

    return false;
}

/**
 * Get candles that need to be updated/appended.
 * Returns only candles with time >= lastRenderedTime.
 */
export function getUpdateCandles(
    candles: OHLCData[],
    lastRenderedTime: number | null
): OHLCData[] {
    if (lastRenderedTime === null) return candles;

    return candles.filter((c) => {
        const time = typeof c.time === 'number' ? c.time : Number(c.time);
        return time >= lastRenderedTime;
    });
}

// =============================================================================
// Price Formatting
// =============================================================================

/**
 * Format price with proper handling for micro-prices and large numbers.
 * 
 * - For |price| < 1e-6 or > 1e9: use scientific notation
 * - Otherwise: fixed decimals with trailing zero trimming
 */
export function formatPrice(price: number, precision: number): string {
    if (!Number.isFinite(price)) return '—';
    if (price === 0) return '0';

    const absPrice = Math.abs(price);

    // Scientific notation for extreme values
    if (absPrice < 1e-6 || absPrice > 1e9) {
        return price.toExponential(3);
    }

    // Fixed decimals with trailing zero trimming
    const fixed = price.toFixed(precision);

    // Trim trailing zeros and trailing decimal point
    return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * Format volume with K/M/B suffixes.
 */
export function formatVolume(value: number): string {
    if (!Number.isFinite(value)) return '—';

    if (value >= 1_000_000_000) {
        return `${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(2)}K`;
    }
    return value.toFixed(2);
}

// =============================================================================
// Conversion Helpers
// =============================================================================

/**
 * Convert OHLCData to CandlestickData for lightweight-charts.
 */
export function ohlcToCandlestick(candle: OHLCData): CandlestickData {
    return {
        time: candle.time as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
    };
}

/**
 * Convert VolumeData to HistogramData for lightweight-charts.
 */
export function volumeToHistogram(
    vol: VolumeData,
    isBullish: boolean
): HistogramData {
    return {
        time: vol.time as Time,
        value: vol.value,
        color: isBullish ? BINANCE_COLORS.volume.up : BINANCE_COLORS.volume.down,
    };
}

/**
 * Get bar spacing for an interval string.
 */
export function getBarSpacingForInterval(interval: string): number {
    return INTERVAL_BAR_SPACING[interval] ?? 6;
}

/**
 * Parse interval string to seconds.
 */
export function intervalToSeconds(interval: string): number {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 60; // Default 1 minute

    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;

    switch (unit) {
        case 'm': return value * 60;
        case 'h': return value * 60 * 60;
        case 'd': return value * 24 * 60 * 60;
        default: return 60;
    }
}

/**
 * Check if a data point is whitespace (gap).
 */
export function isWhitespace(data: CandleSeriesData): data is WhitespaceData {
    return !('open' in data);
}
