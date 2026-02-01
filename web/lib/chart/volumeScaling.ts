/**
 * Volume Scaling Module
 * Handles volume bar scaling synchronized with candle spacing
 */

import { VolumeData, OHLCData, SpacingConfig, BINANCE_COLORS } from './types';

/**
 * Volume scaling configuration
 */
export interface VolumeScalingConfig {
    /** Width ratio relative to candle width (0-1) */
    widthRatio: number;
    /** Minimum bar width in pixels */
    minWidth: number;
    /** Maximum bar width in pixels */
    maxWidth: number;
    /** Height percentage of chart area (0-1) */
    heightPercentage: number;
    /** Whether to use logarithmic volume scale */
    logScale: boolean;
    /** Opacity for volume bars */
    opacity: number;
}

/** Default volume scaling configuration */
export const DEFAULT_VOLUME_CONFIG: VolumeScalingConfig = {
    widthRatio: 0.8,
    minWidth: 1,
    maxWidth: 20,
    heightPercentage: 0.2,
    logScale: false,
    opacity: 0.5,
};

/**
 * Calculate volume bar width based on candle spacing
 */
export function calculateVolumeBarWidth(
    candleSpacing: number,
    config: VolumeScalingConfig = DEFAULT_VOLUME_CONFIG
): number {
    const rawWidth = candleSpacing * config.widthRatio;
    return Math.max(config.minWidth, Math.min(config.maxWidth, rawWidth));
}

/**
 * Normalize volume values to prevent clipping for extreme spikes
 * Uses adaptive scaling based on recent volume history
 */
export function normalizeVolumeData(
    volumeData: VolumeData[],
    windowSize: number = 50
): VolumeData[] {
    if (!volumeData || volumeData.length === 0) {
        return [];
    }

    // Calculate moving average of volume
    const values = volumeData.map((v) => v.value);
    const avgVolume = values.reduce((a, b) => a + b, 0) / values.length;

    // Find the 95th percentile to handle spikes
    const sorted = [...values].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95Volume = sorted[p95Index] || avgVolume;

    // Cap extreme values at 3x the 95th percentile
    const maxVolume = p95Volume * 3;

    return volumeData.map((v) => ({
        ...v,
        value: Math.min(v.value, maxVolume),
    }));
}

/**
 * Create volume data from OHLC candles
 * Assigns colors based on candle direction
 */
export function createVolumeFromCandles(
    candles: (OHLCData & { volume?: number })[],
    upColor: string = BINANCE_COLORS.upTransparent,
    downColor: string = BINANCE_COLORS.downTransparent
): VolumeData[] {
    return candles
        .filter((c) => c.volume !== undefined && c.volume > 0)
        .map((candle) => ({
            time: candle.time,
            value: candle.volume!,
            color: candle.close >= candle.open ? upColor : downColor,
        }));
}

/**
 * Synchronize volume bars with candle data
 * Ensures volume bars align temporally with candles
 */
export function synchronizeVolumeWithCandles(
    volumeData: VolumeData[],
    candleData: OHLCData[]
): VolumeData[] {
    if (!candleData || candleData.length === 0) {
        return volumeData;
    }

    // Create a map of candle times for quick lookup
    const candleTimes = new Set(
        candleData.map((c) => (typeof c.time === 'number' ? c.time : Number(c.time)))
    );

    // Filter volume data to only include times that have candles
    return volumeData.filter((v) => {
        const time = typeof v.time === 'number' ? v.time : Number(v.time);
        return candleTimes.has(time);
    });
}

/**
 * Calculate volume statistics for display
 */
export function calculateVolumeStats(volumeData: VolumeData[]): {
    min: number;
    max: number;
    avg: number;
    total: number;
} {
    if (!volumeData || volumeData.length === 0) {
        return { min: 0, max: 0, avg: 0, total: 0 };
    }

    const values = volumeData.map((v) => v.value);
    const total = values.reduce((a, b) => a + b, 0);

    return {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: total / values.length,
        total,
    };
}

/**
 * Apply logarithmic scaling to volume values
 */
export function applyLogVolumeScale(volumeData: VolumeData[]): VolumeData[] {
    if (!volumeData || volumeData.length === 0) {
        return [];
    }

    // Find min non-zero volume for log base
    const minNonZero = Math.min(
        ...volumeData.filter((v) => v.value > 0).map((v) => v.value)
    ) || 1;

    return volumeData.map((v) => ({
        ...v,
        value: v.value > 0 ? Math.log10(v.value / minNonZero + 1) : 0,
    }));
}

/**
 * Format volume for display (K, M, B suffixes)
 */
export function formatVolume(volume: number): string {
    if (!Number.isFinite(volume)) return '0';

    if (volume >= 1e9) {
        return (volume / 1e9).toFixed(2) + 'B';
    }
    if (volume >= 1e6) {
        return (volume / 1e6).toFixed(2) + 'M';
    }
    if (volume >= 1e3) {
        return (volume / 1e3).toFixed(2) + 'K';
    }
    return volume.toFixed(2);
}

/**
 * Get volume bar color based on price movement
 */
export function getVolumeColor(
    currentClose: number,
    previousClose: number,
    upColor: string = BINANCE_COLORS.upTransparent,
    downColor: string = BINANCE_COLORS.downTransparent
): string {
    return currentClose >= previousClose ? upColor : downColor;
}

/**
 * Calculate volume-weighted average price (VWAP)
 */
export function calculateVWAP(
    candles: (OHLCData & { volume?: number })[]
): number {
    if (!candles || candles.length === 0) {
        return 0;
    }

    let sumPriceVolume = 0;
    let sumVolume = 0;

    for (const candle of candles) {
        const volume = candle.volume || 0;
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        sumPriceVolume += typicalPrice * volume;
        sumVolume += volume;
    }

    return sumVolume > 0 ? sumPriceVolume / sumVolume : 0;
}

/**
 * Detect extreme volume spikes (potential manipulation or news events)
 */
export function detectVolumeSpikes(
    volumeData: VolumeData[],
    threshold: number = 3 // Standard deviations
): number[] {
    if (!volumeData || volumeData.length < 10) {
        return [];
    }

    const values = volumeData.map((v) => v.value);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    const spikeIndices: number[] = [];
    const spikeThreshold = avg + threshold * stdDev;

    for (let i = 0; i < values.length; i++) {
        if (values[i] > spikeThreshold) {
            spikeIndices.push(i);
        }
    }

    return spikeIndices;
}
