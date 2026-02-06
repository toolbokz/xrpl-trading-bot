/**
 * Chart Scaling Module - Barrel Export
 * Binance-style adaptive scaling for TradingView Lightweight Charts
 */

// Types
export * from './types';

// Precision detection
export {
    countDecimals,
    detectOHLCPrecision,
    detectDatasetPrecision,
    detectStreamingPrecision,
    createPrecisionConfig,
    shouldUpdatePrecision,
} from './precision';

// Binance spacing calculation
export {
    calculateBinanceSpacing,
    calculateSpacingWithMicroAdjustment,
    getSpacingTier,
    createSpacingConfig,
    calculateVolumeBarWidth as calculateVolumeBarWidthFromSpacing,
} from './spacing';

// Logarithmic scale detection
export {
    calculateMagnitudeSpan,
    calculateMagnitudeSpanFromRange,
    shouldUseLogScale,
    determineScaleMode,
    isScaleTransitionSafe,
} from './logScale';

// Precision caching
export {
    PrecisionCache,
    getGlobalPrecisionCache,
    resetGlobalPrecisionCache,
} from './precisionCache';

// Heikin-Ashi support
export {
    calculateHACandle,
    convertToHeikinAshi,
    updateLastHACandle,
    detectHAPrecision,
    isHeikinAshiData,
    getHATrend,
    getHABodyRatio,
    extractOriginalOHLC,
} from './heikinAshi';

// Volume scaling
export {
    calculateVolumeBarWidth,
    normalizeVolumeData,
    createVolumeFromCandles,
    synchronizeVolumeWithCandles,
    calculateVWAP,
    applyLogVolumeScale,
    formatVolume,
    getVolumeColor,
    calculateVolumeStats,
    detectVolumeSpikes,
} from './volumeScaling';

// Main adaptive scaling controller
export {
    createInitialScalingState,
    computeScalingFromData,
    processStreamingUpdate,
    handlePairChange,
    toggleHeikinAshiMode,
    createChartScalingOptions,
    captureChartState,
    restoreChartState,
    calculateSynchronizedVolumeScaling,
    type ScalingState,
    type ScalingUpdateResult,
} from './adaptiveScaling';
