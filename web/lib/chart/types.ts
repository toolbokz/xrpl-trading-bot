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

/** Default adaptive scaling options (TradingView-like professional look) */
export const DEFAULT_SCALING_OPTIONS: AdaptiveScalingOptions = {
    maxCachedPairs: 100,
    logScaleMagnitudeThreshold: 3, // 3 orders of magnitude
    logScalePrecisionThreshold: 8, // 8 decimal places
    baseBarSpacing: 6,             // Slim professional candles
    spacingGrowthPerDecimal: 0.15,
    minBarSpacing: 2,              // Never below 2px for readability
    maxBarSpacing: 10,             // Never above 10px for cleanliness
    thickMicroCandles: false,
};

/** TradingView-inspired color scheme - professional muted tones */
export const BINANCE_COLORS = {
    // Primary candle colors (85% opacity feel)
    up: '#22c55e',              // Emerald green - professional
    down: '#ef4444',            // Soft red - not harsh
    upTransparent: 'rgba(34, 197, 94, 0.4)',
    downTransparent: 'rgba(239, 68, 68, 0.4)',
    // Chart background
    background: '#131722',      // TradingView dark
    grid: '#1e222d',            // Subtle grid
    gridLight: '#2a2e39',
    text: '#d1d4dc',
    textMuted: '#787b86',
    border: '#2a2e39',
    crosshair: '#9598a1',
    /** Candle-specific colors - crisp wicks at 100% opacity */
    candle: {
        up: '#22c55e',          // Emerald - body
        down: '#ef4444',        // Soft red - body
        wickUp: '#22c55e',      // Same as body for clean look
        wickDown: '#ef4444',    // Same as body for clean look
    },
    /** Volume-specific colors - subtle 30% opacity */
    volume: {
        up: 'rgba(34, 197, 94, 0.30)',
        down: 'rgba(239, 68, 68, 0.30)',
    },
};
