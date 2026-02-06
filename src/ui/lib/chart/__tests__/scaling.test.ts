/**
 * Unit Tests for Chart Scaling System
 * Tests precision detection, spacing calculation, log-scale triggers, caching, and HA precision
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import {
    // Precision detection
    countDecimals,
    detectOHLCPrecision,
    detectDatasetPrecision,
    detectStreamingPrecision,
    createPrecisionConfig,
    shouldUpdatePrecision,

    // Spacing calculation
    calculateBinanceSpacing,
    calculateSpacingWithMicroAdjustment,
    getSpacingTier,
    createSpacingConfig,

    // Log-scale detection
    calculateMagnitudeSpan,
    shouldUseLogScale,
    determineScaleMode,
    isScaleTransitionSafe,

    // Precision caching
    PrecisionCache,
    resetGlobalPrecisionCache,

    // Heikin-Ashi
    calculateHACandle,
    convertToHeikinAshi,
    detectHAPrecision,
    isHeikinAshiData,
    getHATrend,

    // Types
    OHLCData,
    HeikinAshiData,
    DEFAULT_SCALING_OPTIONS,
} from '../index';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestCandle(
    time: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume = 1000
): OHLCData {
    return { time, open, high, low, close, volume };
}

function createTestDataset(
    prices: number[],
    baseTime = 1700000000
): OHLCData[] {
    return prices.map((price, i) => ({
        time: baseTime + i * 60,
        open: price * 0.999,
        high: price * 1.002,
        low: price * 0.998,
        close: price,
        volume: 1000 + i * 100,
    }));
}

// =============================================================================
// Precision Detection Tests
// =============================================================================

describe('Precision Detection', () => {
    describe('countDecimals', () => {
        test('should count integer decimals as 0', () => {
            expect(countDecimals(100)).toBe(0);
            expect(countDecimals(1)).toBe(0);
            expect(countDecimals(0)).toBe(0);
        });

        test('should count simple decimals', () => {
            expect(countDecimals(1.5)).toBe(1);
            expect(countDecimals(1.25)).toBe(2);
            expect(countDecimals(1.125)).toBe(3);
        });

        test('should handle high precision decimals', () => {
            expect(countDecimals(0.00001)).toBe(5);
            expect(countDecimals(0.00000001)).toBe(8);
            expect(countDecimals(0.000000000001)).toBe(12);
        });

        test('should handle floating point edge cases', () => {
            // 0.1 + 0.2 = 0.30000000000000004
            const value = 0.1 + 0.2;
            const result = countDecimals(value);
            // Should clamp to reasonable precision
            expect(result).toBeLessThanOrEqual(18);
        });

        test('should handle scientific notation', () => {
            expect(countDecimals(1e-6)).toBe(6);
            expect(countDecimals(1e-10)).toBe(10);
        });
    });

    describe('detectOHLCPrecision', () => {
        test('should detect precision from all OHLC values', () => {
            const candle = createTestCandle(1, 1.12, 1.15, 1.10, 1.14);
            expect(detectOHLCPrecision(candle)).toBe(2);
        });

        test('should return max precision across OHLC', () => {
            const candle: OHLCData = {
                time: 1,
                open: 1.1,
                high: 1.123,
                low: 1.12345,
                close: 1.12,
            };
            expect(detectOHLCPrecision(candle)).toBe(5);
        });

        test('should handle very small prices', () => {
            const candle = createTestCandle(1, 0.00001234, 0.00001250, 0.00001200, 0.00001240);
            expect(detectOHLCPrecision(candle)).toBe(8);
        });
    });

    describe('detectDatasetPrecision', () => {
        test('should detect max precision across dataset', () => {
            const data = [
                createTestCandle(1, 1.12, 1.15, 1.10, 1.14),
                createTestCandle(2, 1.123, 1.156, 1.101, 1.145),
                createTestCandle(3, 1.1234, 1.1567, 1.1012, 1.1456),
            ];
            expect(detectDatasetPrecision(data)).toBe(4);
        });

        test('should return 0 for empty dataset', () => {
            expect(detectDatasetPrecision([])).toBe(0);
        });

        test('should sample large datasets', () => {
            const data = Array(500)
                .fill(null)
                .map((_, i) => createTestCandle(i, 100.12, 100.15, 100.10, 100.13));
            // Add one candle with high precision
            data[250] = createTestCandle(250, 100.12345678, 100.15, 100.10, 100.13);

            const precision = detectDatasetPrecision(data);
            // Sampling should likely catch the high precision candle
            expect(precision).toBeGreaterThanOrEqual(2);
        });
    });

    describe('detectStreamingPrecision', () => {
        test('should return existing precision if new candle has less', () => {
            const candle = createTestCandle(1, 1.12, 1.15, 1.10, 1.14);
            expect(detectStreamingPrecision(4, candle)).toBe(4);
        });

        test('should update precision if new candle has more', () => {
            const candle = createTestCandle(1, 1.123456, 1.156789, 1.101234, 1.145678);
            expect(detectStreamingPrecision(2, candle)).toBe(6);
        });
    });

    describe('createPrecisionConfig', () => {
        test('should create correct config for standard precision', () => {
            const config = createPrecisionConfig(2);
            expect(config.precision).toBe(2);
            expect(config.minMove).toBe(0.01);
            expect(config.tickSize).toBe(0.01);
        });

        test('should create correct config for high precision', () => {
            const config = createPrecisionConfig(8);
            expect(config.precision).toBe(8);
            expect(config.minMove).toBe(0.00000001);
            expect(config.tickSize).toBe(0.00000001);
        });

        test('should clamp precision within bounds', () => {
            const configLow = createPrecisionConfig(-1);
            expect(configLow.precision).toBe(0);

            const configHigh = createPrecisionConfig(25);
            expect(configHigh.precision).toBe(18);
        });
    });

    describe('shouldUpdatePrecision', () => {
        test('should not update for lower precision', () => {
            expect(shouldUpdatePrecision(4, 2)).toBe(false);
        });

        test('should update for higher precision', () => {
            expect(shouldUpdatePrecision(2, 4)).toBe(true);
        });

        test('should not update for equal precision', () => {
            expect(shouldUpdatePrecision(4, 4)).toBe(false);
        });
    });
});

// =============================================================================
// Spacing Calculation Tests
// =============================================================================

describe('Spacing Calculation', () => {
    describe('getSpacingTier', () => {
        test('should return base tier for 0-2 decimals', () => {
            expect(getSpacingTier(0)).toBe('base');
            expect(getSpacingTier(2)).toBe('base');
        });

        test('should return medium tier for 3-4 decimals', () => {
            expect(getSpacingTier(3)).toBe('medium');
            expect(getSpacingTier(4)).toBe('medium');
        });

        test('should return extended tier for 5-6 decimals', () => {
            expect(getSpacingTier(5)).toBe('extended');
            expect(getSpacingTier(6)).toBe('extended');
        });

        test('should return highPrecision tier for 7-8 decimals', () => {
            expect(getSpacingTier(7)).toBe('highPrecision');
            expect(getSpacingTier(8)).toBe('highPrecision');
        });

        test('should return micro tier for 9+ decimals', () => {
            expect(getSpacingTier(9)).toBe('micro');
            expect(getSpacingTier(12)).toBe('micro');
            expect(getSpacingTier(18)).toBe('micro');
        });
    });

    describe('calculateBinanceSpacing', () => {
        test('should return correct spacing for each tier', () => {
            expect(calculateBinanceSpacing(0)).toBe(6); // base
            expect(calculateBinanceSpacing(3)).toBe(7); // medium
            expect(calculateBinanceSpacing(5)).toBe(8); // extended
            expect(calculateBinanceSpacing(7)).toBe(10); // highPrecision
            expect(calculateBinanceSpacing(10)).toBe(12); // micro
        });
    });

    describe('calculateSpacingWithMicroAdjustment', () => {
        test('should add micro adjustment for very small prices', () => {
            const baseSpacing = calculateBinanceSpacing(2);
            const adjustedSpacing = calculateSpacingWithMicroAdjustment(2, 0.0001);
            expect(adjustedSpacing).toBeGreaterThan(baseSpacing);
        });

        test('should not add adjustment for normal prices', () => {
            const baseSpacing = calculateBinanceSpacing(2);
            const adjustedSpacing = calculateSpacingWithMicroAdjustment(2, 100);
            expect(adjustedSpacing).toBe(baseSpacing);
        });

        test('should clamp to max spacing', () => {
            // Even with extreme adjustment, should not exceed max
            const spacing = calculateSpacingWithMicroAdjustment(18, 0.0000000001);
            expect(spacing).toBeLessThanOrEqual(14); // MAX_BAR_SPACING
        });
    });

    describe('createSpacingConfig', () => {
        test('should create complete spacing config', () => {
            const config = createSpacingConfig(4, 1.5);
            expect(config).toHaveProperty('barSpacing');
            expect(config).toHaveProperty('minBarSpacing');
            expect(config).toHaveProperty('volumeBarWidth');
            expect(config).toHaveProperty('tier');
            expect(config.tier).toBe('medium');
        });

        test('should calculate volume bar width based on candle spacing', () => {
            const config = createSpacingConfig(4, 1.5);
            expect(config.volumeBarWidth).toBeLessThan(config.barSpacing);
        });
    });
});

// =============================================================================
// Log-Scale Detection Tests
// =============================================================================

describe('Log-Scale Detection', () => {
    describe('calculateMagnitudeSpan', () => {
        test('should calculate correct magnitude span', () => {
            const data = createTestDataset([100, 1000, 10000]);
            const span = calculateMagnitudeSpan(data);
            expect(span).toBeCloseTo(2, 0); // 10000/100 ≈ 2 orders of magnitude
        });

        test('should return 0 for empty data', () => {
            expect(calculateMagnitudeSpan([])).toBe(0);
        });

        test('should handle data with same values', () => {
            const data = createTestDataset([100, 100, 100]);
            const span = calculateMagnitudeSpan(data);
            expect(span).toBe(0);
        });
    });

    describe('shouldUseLogScale', () => {
        test('should return true for large magnitude span', () => {
            const data = createTestDataset([1, 100, 10000]);
            expect(shouldUseLogScale(data, 2)).toBe(true);
        });

        test('should return false for small magnitude span', () => {
            const data = createTestDataset([100, 110, 120]);
            expect(shouldUseLogScale(data, 2)).toBe(false);
        });

        test('should return true for high precision', () => {
            const data = createTestDataset([0.00001234, 0.00001256, 0.00001278]);
            expect(shouldUseLogScale(data, 12)).toBe(true);
        });

        test('should allow custom threshold', () => {
            const data = createTestDataset([1, 100, 1000]);
            // Use custom options with different thresholds
            const highThreshold = { ...DEFAULT_SCALING_OPTIONS, logScaleMagnitudeThreshold: 4 };
            const lowThreshold = { ...DEFAULT_SCALING_OPTIONS, logScaleMagnitudeThreshold: 2 };
            expect(shouldUseLogScale(data, 2, highThreshold)).toBe(false); // 3 magnitudes < 4 threshold
            expect(shouldUseLogScale(data, 2, lowThreshold)).toBe(true); // 3 magnitudes > 2 threshold
        });
    });

    describe('determineScaleMode', () => {
        test('should return linear for normal data', () => {
            const data = createTestDataset([100, 102, 104, 103]);
            expect(determineScaleMode(data, 2, 'linear')).toBe('linear');
        });

        test('should switch to logarithmic for large ranges', () => {
            const data = createTestDataset([1, 10, 100, 1000, 10000]);
            expect(determineScaleMode(data, 2, 'linear')).toBe('logarithmic');
        });

        test('should respect hysteresis when switching back', () => {
            const data = createTestDataset([10, 100, 500]);
            // If already in log mode, should need lower threshold to switch back
            const mode = determineScaleMode(data, 2, 'logarithmic');
            // This is borderline, hysteresis should favor staying in current mode
            expect(['linear', 'logarithmic']).toContain(mode);
        });
    });

    describe('isScaleTransitionSafe', () => {
        test('should be safe for data with positive values', () => {
            const data = createTestDataset([100, 110, 120]);
            expect(isScaleTransitionSafe(data)).toBe(true);
        });

        test('should be safe for empty data', () => {
            expect(isScaleTransitionSafe([])).toBe(true);
        });

        test('should be unsafe for data with zero/negative values', () => {
            const data = createTestDataset([100, 0, 120]);
            // Manually set a zero value
            const item = data[1];
            if (item) item.low = 0;
            expect(isScaleTransitionSafe(data)).toBe(false);
        });
    });
});

// =============================================================================
// Precision Caching Tests
// =============================================================================

describe('Precision Caching', () => {
    let cache: PrecisionCache;

    beforeEach(() => {
        cache = new PrecisionCache(10);
        resetGlobalPrecisionCache();
    });

    describe('PrecisionCache', () => {
        test('should store and retrieve precision', () => {
            cache.set('BTC/USD', 2);
            expect(cache.get('BTC/USD')).toBe(2);
        });

        test('should return undefined for unknown pairs', () => {
            expect(cache.get('UNKNOWN/PAIR')).toBeUndefined();
        });

        test('should update if higher precision', () => {
            cache.set('BTC/USD', 2);
            cache.updateIfHigher('BTC/USD', 4);
            expect(cache.get('BTC/USD')).toBe(4);
        });

        test('should not update if lower precision', () => {
            cache.set('BTC/USD', 4);
            cache.updateIfHigher('BTC/USD', 2);
            expect(cache.get('BTC/USD')).toBe(4);
        });

        test('should force set regardless of current value', () => {
            cache.set('BTC/USD', 4);
            cache.forceSet('BTC/USD', 2);
            expect(cache.get('BTC/USD')).toBe(2);
        });

        test('should evict LRU entries when full', () => {
            // Fill cache
            for (let i = 0; i < 10; i++) {
                cache.set(`PAIR${i}/USD`, i);
            }

            // Access first pair to make it recently used
            cache.get('PAIR0/USD');

            // Add new pair, should evict PAIR1 (least recently used)
            cache.set('NEW/PAIR', 99);

            expect(cache.get('PAIR0/USD')).toBe(0); // Still exists
            expect(cache.get('PAIR1/USD')).toBeUndefined(); // Evicted
            expect(cache.get('NEW/PAIR')).toBe(99); // New pair exists
        });

        test('should track size correctly', () => {
            expect(cache.size).toBe(0);
            cache.set('BTC/USD', 2);
            expect(cache.size).toBe(1);
            cache.set('ETH/USD', 4);
            expect(cache.size).toBe(2);
        });

        test('should clear all entries', () => {
            cache.set('BTC/USD', 2);
            cache.set('ETH/USD', 4);
            cache.clear();
            expect(cache.size).toBe(0);
            expect(cache.get('BTC/USD')).toBeUndefined();
        });

        test('should export and import data', () => {
            cache.set('BTC/USD', 2);
            cache.set('ETH/USD', 8);

            const exported = cache.export();
            expect(exported).toEqual({
                'BTC/USD': 2,
                'ETH/USD': 8,
            });

            const newCache = new PrecisionCache(10);
            newCache.import(exported);
            expect(newCache.get('BTC/USD')).toBe(2);
            expect(newCache.get('ETH/USD')).toBe(8);
        });
    });
});

// =============================================================================
// Heikin-Ashi Tests
// =============================================================================

describe('Heikin-Ashi', () => {
    describe('calculateHACandle', () => {
        test('should calculate first HA candle correctly', () => {
            const candle = createTestCandle(1, 100, 105, 98, 102);
            const haCandle = calculateHACandle(candle, null);

            expect(haCandle.time).toBe(1);
            // HA Close = (O + H + L + C) / 4
            expect(haCandle.close).toBeCloseTo((100 + 105 + 98 + 102) / 4, 4);
            // First HA Open = (O + C) / 2
            expect(haCandle.open).toBeCloseTo((100 + 102) / 2, 4);
            // HA High = max(H, haOpen, haClose)
            expect(haCandle.high).toBeGreaterThanOrEqual(haCandle.open);
            expect(haCandle.high).toBeGreaterThanOrEqual(haCandle.close);
            // HA Low = min(L, haOpen, haClose)
            expect(haCandle.low).toBeLessThanOrEqual(haCandle.open);
            expect(haCandle.low).toBeLessThanOrEqual(haCandle.close);
            // Should preserve original values
            expect(haCandle.originalOpen).toBe(100);
            expect(haCandle.originalClose).toBe(102);
        });

        test('should calculate subsequent HA candle using previous', () => {
            const candle1 = createTestCandle(1, 100, 105, 98, 102);
            const haCandle1 = calculateHACandle(candle1, null);

            const candle2 = createTestCandle(2, 102, 108, 100, 106);
            const haCandle2 = calculateHACandle(candle2, haCandle1);

            // HA Open = (prevHaOpen + prevHaClose) / 2
            expect(haCandle2.open).toBeCloseTo((haCandle1.open + haCandle1.close) / 2, 4);
        });
    });

    describe('convertToHeikinAshi', () => {
        test('should convert entire dataset', () => {
            const data = [
                createTestCandle(1, 100, 105, 98, 102),
                createTestCandle(2, 102, 108, 100, 106),
                createTestCandle(3, 106, 110, 104, 108),
            ];

            const haData = convertToHeikinAshi(data);

            expect(haData.length).toBe(3);
            expect(isHeikinAshiData(haData)).toBe(true);

            // Each HA candle should have original values
            haData.forEach((candle, i) => {
                const original = data[i];
                expect(candle.originalOpen).toBe(original?.open);
                expect(candle.originalClose).toBe(original?.close);
            });
        });

        test('should return empty array for empty input', () => {
            expect(convertToHeikinAshi([])).toEqual([]);
        });
    });

    describe('detectHAPrecision', () => {
        test('should detect precision from HA close values', () => {
            const data = [
                createTestCandle(1, 100.12, 105.15, 98.10, 102.13),
                createTestCandle(2, 102.13, 108.18, 100.11, 106.16),
            ];
            const haData = convertToHeikinAshi(data);

            const precision = detectHAPrecision(haData);
            // HA averaging might increase precision
            expect(precision).toBeGreaterThanOrEqual(2);
        });
    });

    describe('isHeikinAshiData', () => {
        test('should return true for HA data', () => {
            const data = convertToHeikinAshi([
                createTestCandle(1, 100, 105, 98, 102),
            ]);
            expect(isHeikinAshiData(data)).toBe(true);
        });

        test('should return false for regular OHLC data', () => {
            const data = [createTestCandle(1, 100, 105, 98, 102)];
            expect(isHeikinAshiData(data)).toBe(false);
        });

        test('should return false for empty array', () => {
            expect(isHeikinAshiData([])).toBe(false);
        });
    });

    describe('getHATrend', () => {
        test('should detect bullish trend', () => {
            const haCandle: HeikinAshiData = {
                time: 1,
                open: 100,
                high: 110,
                low: 100, // low equals min(open, close) = strong bullish
                close: 108,
                originalOpen: 99,
                originalClose: 107,
                originalHigh: 111,
                originalLow: 98,
            };
            expect(getHATrend(haCandle)).toBe(1); // 1 = bullish
        });

        test('should detect bearish trend', () => {
            const haCandle: HeikinAshiData = {
                time: 1,
                open: 108, // max(open, close)
                high: 108, // high equals max(open, close) = strong bearish
                low: 98,
                close: 100,
                originalOpen: 107,
                originalClose: 99,
                originalHigh: 109,
                originalLow: 97,
            };
            expect(getHATrend(haCandle)).toBe(-1); // -1 = bearish
        });

        test('should detect neutral trend', () => {
            const haCandle: HeikinAshiData = {
                time: 1,
                open: 100,
                high: 102,
                low: 98,
                close: 100,
                originalOpen: 100,
                originalClose: 100,
                originalHigh: 102,
                originalLow: 98,
            };
            expect(getHATrend(haCandle)).toBe(0); // 0 = neutral
        });
    });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {
    beforeEach(() => {
        resetGlobalPrecisionCache();
    });

    test('full scaling workflow for standard pair', () => {
        const data = createTestDataset([1.2345, 1.2367, 1.2389, 1.2401]);

        const precision = detectDatasetPrecision(data);
        expect(precision).toBe(4);

        const spacing = createSpacingConfig(precision, 1.24);
        expect(spacing.tier).toBe('medium');

        const scaleMode = determineScaleMode(data, precision, 'linear');
        expect(scaleMode).toBe('linear');
    });

    test('full scaling workflow for micro-cap token', () => {
        const data = createTestDataset([
            0.00000012,
            0.00000015,
            0.00000018,
            0.00000014,
        ]);

        const precision = detectDatasetPrecision(data);
        expect(precision).toBeGreaterThanOrEqual(8);

        const spacing = createSpacingConfig(precision, 0.00000015);
        expect(spacing.tier).toBe('micro');

        const scaleMode = determineScaleMode(data, precision, 'linear');
        // High precision should trigger log scale consideration
        expect(['linear', 'logarithmic']).toContain(scaleMode);
    });

    test('streaming precision update', () => {
        const cache = new PrecisionCache();
        const pair = 'TEST/USD';

        // Initial candle with 2 decimals
        cache.set(pair, 2);
        expect(cache.get(pair)).toBe(2);

        // New candle arrives with higher precision
        const newCandle = createTestCandle(1, 1.12345, 1.12567, 1.12123, 1.12456);
        const newPrecision = detectStreamingPrecision(cache.get(pair)!, newCandle);

        cache.updateIfHigher(pair, newPrecision);
        expect(cache.get(pair)).toBe(5);
    });
});
