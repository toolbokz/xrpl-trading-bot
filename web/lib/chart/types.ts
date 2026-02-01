/**
 * Chart Scaling Types
 * Type definitions for the adaptive chart scaling system
 */

import { CandlestickData, UTCTimestamp } from 'lightweight-charts';

/** OHLC data with required fields */
export interface OHLCData {
    time: UTCTimestamp | number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

/** Volume data point */
export interface VolumeData {
    time: UTCTimestamp | number;
    value: number;
    color?: string;
}

/** Heikin-Ashi candlestick data */
export interface HeikinAshiData extends OHLCData {
    /** Original OHLC for reference */
    originalOpen?: number;
    originalHigh?: number;
    originalLow?: number;
    originalClose?: number;
}

/** Precision configuration for price formatting */
export interface PrecisionConfig {
    /** Number of decimal places */
    precision: number;
    /** Minimum price movement (10^-precision) */
    minMove: number;
    /** Tick size for price axis */
    tickSize: number;
}

/** Spacing tier names */
export type SpacingTier = 'base' | 'medium' | 'extended' | 'highPrecision' | 'micro';

/** Spacing configuration for candle rendering */
export interface SpacingConfig {
    /** Bar spacing in pixels */
    barSpacing: number;
    /** Minimum bar spacing clamp */
    minBarSpacing: number;
    /** Whether thin candle mode is active */
    thinCandles: boolean;
    /** Spacing tier based on precision */
    tier: SpacingTier;
    /** Volume bar width */
    volumeBarWidth: number;
}

/** Scale mode for the price axis */
export type ScaleMode = 'linear' | 'logarithmic';

/** Complete scaling configuration */
export interface ScalingConfig {
    precision: PrecisionConfig;
    spacing: SpacingConfig;
    scaleMode: ScaleMode;
}

/** Per-pair cached precision entry */
export interface PairPrecisionEntry {
    pair: string;
    precision: number;
    lastUpdated: number;
    accessCount: number;
}

/** Chart state snapshot for preservation during updates */
export interface ChartStateSnapshot {
    /** Visible time range */
    visibleRange: {
        from: number;
        to: number;
    } | null;
    /** Current bar spacing */
    barSpacing: number;
    /** Scroll position */
    scrollPosition: number;
    /** Whether crosshair was visible */
    crosshairVisible: boolean;
}

/** Configuration for the adaptive scaling system */
export interface AdaptiveScalingOptions {
    /** Maximum cached pairs (LRU eviction) */
    maxCachedPairs: number;
    /** Log scale trigger: price magnitude span */
    logScaleMagnitudeThreshold: number;
    /** Log scale trigger: decimal precision */
    logScalePrecisionThreshold: number;
    /** Base bar spacing for ≤2 decimals */
    baseBarSpacing: number;
    /** Spacing growth per additional decimal */
    spacingGrowthPerDecimal: number;
    /** Minimum bar spacing clamp */
    minBarSpacing: number;
    /** Maximum bar spacing clamp */
    maxBarSpacing: number;
    /** Whether to favor thicker candles for micro-priced assets */
    thickMicroCandles: boolean;
}

/** Default adaptive scaling options (Binance-like) */
export const DEFAULT_SCALING_OPTIONS: AdaptiveScalingOptions = {
    maxCachedPairs: 100,
    logScaleMagnitudeThreshold: 3, // 3 orders of magnitude
    logScalePrecisionThreshold: 8, // 8 decimal places
    baseBarSpacing: 6,
    spacingGrowthPerDecimal: 0.5,
    minBarSpacing: 4,
    maxBarSpacing: 24,
    thickMicroCandles: true,
};

/** Binance color scheme */
export const BINANCE_COLORS = {
    up: '#0ECB81',
    down: '#F6465D',
    upTransparent: 'rgba(14, 203, 129, 0.5)',
    downTransparent: 'rgba(246, 70, 93, 0.5)',
    background: '#0B0E11',
    grid: '#1E2329',
    gridLight: '#2B3139',
    text: '#D1D4DC',
    textMuted: '#848E9C',
    border: '#2B3139',
    crosshair: '#758696',
    /** Candle-specific colors */
    candle: {
        up: '#0ECB81',
        down: '#F6465D',
        wickUp: '#0ECB81',
        wickDown: '#F6465D',
    },
    /** Volume-specific colors */
    volume: {
        up: 'rgba(14, 203, 129, 0.5)',
        down: 'rgba(246, 70, 93, 0.5)',
    },
};
