/**
 * Adaptive Scaling Controller
 * Central coordinator for all chart scaling operations
 */

import {
    OHLCData,
    HeikinAshiData,
    VolumeData,
    ScalingConfig,
    ChartStateSnapshot,
    AdaptiveScalingOptions,
    DEFAULT_SCALING_OPTIONS,
    ScaleMode,
    PrecisionConfig,
    SpacingConfig,
} from './types';
import {
    detectDatasetPrecision,
    detectStreamingPrecision,
    createPrecisionConfig,
    shouldUpdatePrecision,
} from './precision';
import {
    createSpacingConfig,
    calculateSpacingWithMicroAdjustment,
} from './spacing';
import {
    determineScaleMode,
    isScaleTransitionSafe,
} from './logScale';
import {
    PrecisionCache,
    getGlobalPrecisionCache,
} from './precisionCache';
import {
    detectHAPrecision,
    isHeikinAshiData,
} from './heikinAshi';
import {
    calculateVolumeBarWidth,
    normalizeVolumeData,
} from './volumeScaling';

/**
 * Scaling state for a chart instance
 */
export interface ScalingState {
    /** Current precision configuration */
    precision: PrecisionConfig;
    /** Current spacing configuration */
    spacing: SpacingConfig;
    /** Current scale mode */
    scaleMode: ScaleMode;
    /** Trading pair identifier */
    pair: string;
    /** Last update timestamp */
    lastUpdate: number;
    /** Whether Heikin-Ashi mode is active */
    heikinAshiMode: boolean;
}

/**
 * Scaling update result
 */
export interface ScalingUpdateResult {
    /** Whether any scaling changed */
    changed: boolean;
    /** New scaling state */
    state: ScalingState;
    /** What specifically changed */
    changes: {
        precision: boolean;
        spacing: boolean;
        scaleMode: boolean;
    };
}

/**
 * Create initial scaling state
 */
export function createInitialScalingState(
    pair: string = '',
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): ScalingState {
    const precisionCache = getGlobalPrecisionCache(options);
    const cachedPrecision = precisionCache.get(pair);
    const precision = cachedPrecision ?? 2;

    return {
        precision: createPrecisionConfig(precision),
        spacing: createSpacingConfig(precision, 1, options),
        scaleMode: 'linear',
        pair,
        lastUpdate: Date.now(),
        heikinAshiMode: false,
    };
}

/**
 * Compute scaling configuration from data
 */
export function computeScalingFromData(
    data: OHLCData[] | HeikinAshiData[],
    currentState: ScalingState,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): ScalingUpdateResult {
    if (!data || data.length === 0) {
        return {
            changed: false,
            state: currentState,
            changes: { precision: false, spacing: false, scaleMode: false },
        };
    }

    const precisionCache = getGlobalPrecisionCache(options);

    // Detect precision (different for HA data)
    const isHA = isHeikinAshiData(data);
    const detectedPrecision = isHA
        ? detectHAPrecision(data as HeikinAshiData[])
        : detectDatasetPrecision(data);

    // Get cached precision and merge
    const cachedPrecision = precisionCache.get(currentState.pair);
    const effectivePrecision = Math.max(
        detectedPrecision,
        cachedPrecision ?? 0,
        currentState.precision.precision
    );

    // Update cache if precision increased
    if (currentState.pair) {
        precisionCache.updateIfHigher(currentState.pair, effectivePrecision);
    }

    // Get current price for micro-adjustment
    const currentPrice = data[data.length - 1]?.close ?? 1;

    // Create new configurations
    const newPrecision = createPrecisionConfig(effectivePrecision);
    const newSpacing = createSpacingConfig(effectivePrecision, currentPrice, options);
    const newScaleMode = determineScaleMode(data, effectivePrecision, currentState.scaleMode, options);

    // Determine what changed
    const precisionChanged = newPrecision.precision !== currentState.precision.precision;
    const spacingChanged = Math.abs(newSpacing.barSpacing - currentState.spacing.barSpacing) > 0.1;
    const scaleModeChanged = newScaleMode !== currentState.scaleMode;

    const changed = precisionChanged || spacingChanged || scaleModeChanged;

    return {
        changed,
        state: {
            precision: newPrecision,
            spacing: newSpacing,
            scaleMode: newScaleMode,
            pair: currentState.pair,
            lastUpdate: Date.now(),
            heikinAshiMode: isHA,
        },
        changes: {
            precision: precisionChanged,
            spacing: spacingChanged,
            scaleMode: scaleModeChanged,
        },
    };
}

/**
 * Process streaming update and check if scaling needs adjustment
 */
export function processStreamingUpdate(
    newCandle: OHLCData,
    currentState: ScalingState,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): ScalingUpdateResult {
    const precisionCache = getGlobalPrecisionCache(options);

    // Detect precision of new candle
    const newPrecision = detectStreamingPrecision(
        currentState.precision.precision,
        newCandle
    );

    // Check if precision increased
    const precisionIncreased = newPrecision > currentState.precision.precision;

    if (!precisionIncreased) {
        return {
            changed: false,
            state: currentState,
            changes: { precision: false, spacing: false, scaleMode: false },
        };
    }

    // Update cache
    if (currentState.pair) {
        precisionCache.updateIfHigher(currentState.pair, newPrecision);
    }

    // Create new configurations
    const newPrecisionConfig = createPrecisionConfig(newPrecision);
    const newSpacing = createSpacingConfig(newPrecision, newCandle.close, options);

    return {
        changed: true,
        state: {
            ...currentState,
            precision: newPrecisionConfig,
            spacing: newSpacing,
            lastUpdate: Date.now(),
        },
        changes: {
            precision: true,
            spacing: true,
            scaleMode: false,
        },
    };
}

/**
 * Handle pair change
 */
export function handlePairChange(
    newPair: string,
    currentState: ScalingState,
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): ScalingState {
    const precisionCache = getGlobalPrecisionCache(options);

    // Get cached precision for new pair
    const cachedPrecision = precisionCache.get(newPair) ?? 2;

    return {
        precision: createPrecisionConfig(cachedPrecision),
        spacing: createSpacingConfig(cachedPrecision, 1, options),
        scaleMode: 'linear', // Reset to linear on pair change
        pair: newPair,
        lastUpdate: Date.now(),
        heikinAshiMode: currentState.heikinAshiMode,
    };
}

/**
 * Toggle Heikin-Ashi mode
 */
export function toggleHeikinAshiMode(
    currentState: ScalingState,
    data: OHLCData[] | HeikinAshiData[],
    options: AdaptiveScalingOptions = DEFAULT_SCALING_OPTIONS
): ScalingState {
    const newHAMode = !currentState.heikinAshiMode;

    // Recalculate precision for HA mode
    const precision = newHAMode && isHeikinAshiData(data)
        ? detectHAPrecision(data as HeikinAshiData[])
        : detectDatasetPrecision(data);

    return {
        ...currentState,
        precision: createPrecisionConfig(precision),
        spacing: createSpacingConfig(precision, data[data.length - 1]?.close ?? 1, options),
        heikinAshiMode: newHAMode,
        lastUpdate: Date.now(),
    };
}

/**
 * Create complete scaling configuration for chart options
 */
export function createChartScalingOptions(state: ScalingState): {
    priceScale: {
        mode: number; // 0 = normal, 1 = logarithmic
    };
    priceFormat: {
        type: 'price';
        precision: number;
        minMove: number;
    };
    timeScale: {
        barSpacing: number;
        minBarSpacing: number;
    };
} {
    return {
        priceScale: {
            mode: state.scaleMode === 'logarithmic' ? 1 : 0,
        },
        priceFormat: {
            type: 'price',
            precision: state.precision.precision,
            minMove: state.precision.minMove,
        },
        timeScale: {
            barSpacing: state.spacing.barSpacing,
            minBarSpacing: state.spacing.minBarSpacing,
        },
    };
}

/**
 * Capture chart state for preservation during updates
 */
export function captureChartState(
    chart: any // IChartApi
): ChartStateSnapshot | null {
    try {
        const timeScale = chart.timeScale();
        const visibleRange = timeScale.getVisibleRange();
        const barSpacing = timeScale.options().barSpacing;

        return {
            visibleRange: visibleRange
                ? { from: Number(visibleRange.from), to: Number(visibleRange.to) }
                : null,
            barSpacing,
            scrollPosition: timeScale.scrollPosition(),
            crosshairVisible: true, // Always true for now
        };
    } catch {
        return null;
    }
}

/**
 * Restore chart state after updates
 */
export function restoreChartState(
    chart: any, // IChartApi
    snapshot: ChartStateSnapshot
): void {
    try {
        const timeScale = chart.timeScale();

        // Restore bar spacing first
        if (snapshot.barSpacing > 0) {
            timeScale.applyOptions({ barSpacing: snapshot.barSpacing });
        }

        // Restore visible range
        if (snapshot.visibleRange) {
            timeScale.setVisibleRange({
                from: snapshot.visibleRange.from,
                to: snapshot.visibleRange.to,
            });
        }
    } catch {
        // Ignore errors during restore
    }
}

/**
 * Calculate volume scaling synchronized with candles
 */
export function calculateSynchronizedVolumeScaling(
    volumeData: VolumeData[],
    scalingState: ScalingState
): VolumeData[] {
    // Normalize volume data to prevent clipping
    const normalized = normalizeVolumeData(volumeData);
    return normalized;
}
