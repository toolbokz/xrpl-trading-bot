"use client";

/**
 * AdaptiveCandleChart - Production-quality candlestick chart
 * 
 * Features:
 * - Gap rendering with whitespace (no fake flat candles)
 * - Incremental updates (no flicker on poll)
 * - Separate volume pane with synced time scale
 * - Micro-price formatting with scientific notation
 * - Stable bar spacing based on interval
 */

import {
    useEffect,
    useRef,
    useCallback,
    useState,
    useMemo,
} from 'react';
import {
    createChart,
    CandlestickData,
    IChartApi,
    ISeriesApi,
    HistogramData,
    Time,
    LineStyle,
    WhitespaceData,
} from 'lightweight-charts';

// Chart utilities
import {
    OHLCData,
    VolumeData,
    HeikinAshiData,
    AdaptiveScalingOptions,
    DEFAULT_SCALING_OPTIONS,
    BINANCE_COLORS,
} from '../lib/chart/types';
import {
    ScalingState,
    createInitialScalingState,
    computeScalingFromData,
    handlePairChange,
    createChartScalingOptions,
    captureChartState,
    restoreChartState,
} from '../lib/chart/adaptiveScaling';
import {
    convertToHeikinAshi,
} from '../lib/chart/heikinAshi';
import {
    createVolumeFromCandles,
    normalizeVolumeData,
} from '../lib/chart/volumeScaling';
import {
    buildSeriesDataWithGaps,
    buildVolumeDataWithGaps,
    shouldResetSeries,
    getUpdateCandles,
    formatPrice,
    formatVolume,
    ohlcToCandlestick,
    getBarSpacingForInterval,
    intervalToSeconds,
    CandleSeriesData,
    VolumeSeriesData,
    isWhitespace,
} from '../lib/chart/seriesUtils';

// =============================================================================
// Types
// =============================================================================

export interface AdaptiveCandleChartProps {
    /** Candlestick data (OHLC format) */
    data: OHLCData[];
    /** Trading pair identifier (e.g., 'XRP/RLUSD') */
    pair?: string;
    /** Chart interval (e.g., '1m', '5m', '1h') for stable spacing */
    interval?: string;
    /** Chart height in pixels */
    height?: number;
    /** Show volume in separate pane */
    showVolume?: boolean;
    /** Volume data (optional, auto-generated if not provided) */
    volumeData?: VolumeData[];
    /** Enable Heikin-Ashi mode */
    heikinAshi?: boolean;
    /** Custom scaling options */
    scalingOptions?: Partial<AdaptiveScalingOptions>;
    /** Callback when scaling changes */
    onScalingChange?: (state: ScalingState) => void;
    /** Enable crosshair */
    crosshair?: boolean;
    /** Show legend with current values */
    showLegend?: boolean;
}

interface LegendData {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// =============================================================================
// Component
// =============================================================================

export function AdaptiveCandleChart({
    data,
    pair = '',
    interval = '1m',
    height = 400,
    showVolume = true,
    volumeData,
    heikinAshi = false,
    scalingOptions,
    onScalingChange,
    crosshair = true,
    showLegend = true,
}: AdaptiveCandleChartProps) {
    // =========================================================================
    // Refs
    // =========================================================================

    // Chart containers
    const priceContainerRef = useRef<HTMLDivElement | null>(null);
    const volumeContainerRef = useRef<HTMLDivElement | null>(null);

    // Chart instances
    const priceChartRef = useRef<IChartApi | null>(null);
    const volumeChartRef = useRef<IChartApi | null>(null);

    // Series refs
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

    // Incremental update tracking
    const lastRenderedTimeRef = useRef<number | null>(null);
    const lastDataRef = useRef<OHLCData[] | null>(null);
    const lastIntervalRef = useRef<string>(interval);
    const lastPairRef = useRef<string>(pair);

    // Sync flag to prevent feedback loops
    const isSyncingRef = useRef(false);

    // =========================================================================
    // State
    // =========================================================================

    const [scalingState, setScalingState] = useState<ScalingState>(() =>
        createInitialScalingState(pair, { ...DEFAULT_SCALING_OPTIONS, ...scalingOptions })
    );
    const [legendData, setLegendData] = useState<LegendData | null>(null);

    // =========================================================================
    // Memoized Values
    // =========================================================================

    const options = useMemo(
        () => ({ ...DEFAULT_SCALING_OPTIONS, ...scalingOptions }),
        [scalingOptions]
    );

    // Process data (Heikin-Ashi if enabled)
    const processedData = useMemo(() => {
        if (!data || data.length === 0) return [];
        return heikinAshi ? convertToHeikinAshi(data) : data;
    }, [data, heikinAshi]);

    // Generate volume data if not provided
    const effectiveVolumeData = useMemo(() => {
        if (volumeData) return volumeData;
        return createVolumeFromCandles(data);
    }, [data, volumeData]);

    // Normalized volume (cap spikes)
    const normalizedVolume = useMemo(() => {
        return normalizeVolumeData(effectiveVolumeData);
    }, [effectiveVolumeData]);

    // Interval in seconds for gap calculation
    const intervalSec = useMemo(() => intervalToSeconds(interval), [interval]);

    // Heights for price and volume charts
    const priceHeight = useMemo(() => {
        return showVolume ? Math.floor(height * 0.75) : height;
    }, [height, showVolume]);

    const volumeHeight = useMemo(() => {
        return showVolume ? Math.floor(height * 0.25) : 0;
    }, [height, showVolume]);

    // =========================================================================
    // Chart Initialization
    // =========================================================================

    useEffect(() => {
        if (!priceContainerRef.current) return;

        const barSpacing = getBarSpacingForInterval(interval);
        const chartOptions = createChartScalingOptions(scalingState);

        // --- Price Chart ---
        const priceChart = createChart(priceContainerRef.current, {
            layout: {
                background: { color: BINANCE_COLORS.background },
                textColor: BINANCE_COLORS.text,
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                fontSize: 11,
            },
            grid: {
                vertLines: { color: BINANCE_COLORS.grid, style: LineStyle.Solid, visible: true },
                horzLines: { color: BINANCE_COLORS.grid, style: LineStyle.Solid, visible: true },
            },
            timeScale: {
                borderColor: BINANCE_COLORS.border,
                barSpacing,
                minBarSpacing: 2,
                rightOffset: 8,
                fixLeftEdge: false,
                lockVisibleTimeRangeOnResize: true,
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (time: number) => {
                    const date = new Date(time * 1000);
                    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
                },
            },
            rightPriceScale: {
                borderColor: BINANCE_COLORS.border,
                mode: chartOptions.priceScale.mode,
                autoScale: true,
                alignLabels: true,
                borderVisible: true,
                scaleMargins: { top: 0.08, bottom: 0.08 },
            },
            crosshair: {
                mode: crosshair ? 1 : 0,
                vertLine: {
                    color: BINANCE_COLORS.crosshair,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: BINANCE_COLORS.gridLight,
                },
                horzLine: {
                    color: BINANCE_COLORS.crosshair,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: BINANCE_COLORS.gridLight,
                },
            },
            autoSize: true,
            handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
        });

        // Create candlestick series
        const candleSeries = priceChart.addCandlestickSeries({
            upColor: BINANCE_COLORS.candle.up,
            downColor: BINANCE_COLORS.candle.down,
            wickUpColor: BINANCE_COLORS.candle.wickUp,
            wickDownColor: BINANCE_COLORS.candle.wickDown,
            borderVisible: false,
            priceFormat: {
                type: 'price',
                precision: chartOptions.priceFormat.precision,
                minMove: chartOptions.priceFormat.minMove,
            },
        });

        priceChartRef.current = priceChart;
        candleSeriesRef.current = candleSeries;

        // --- Volume Chart (separate pane) ---
        let volumeChart: IChartApi | null = null;
        let volumeSeries: ISeriesApi<'Histogram'> | null = null;

        if (showVolume && volumeContainerRef.current) {
            volumeChart = createChart(volumeContainerRef.current, {
                layout: {
                    background: { color: BINANCE_COLORS.background },
                    textColor: BINANCE_COLORS.text,
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                    fontSize: 11,
                },
                grid: {
                    vertLines: { color: BINANCE_COLORS.grid, style: LineStyle.Solid, visible: true },
                    horzLines: { color: BINANCE_COLORS.grid, style: LineStyle.Solid, visible: false },
                },
                timeScale: {
                    borderColor: BINANCE_COLORS.border,
                    barSpacing,
                    minBarSpacing: 2,
                    rightOffset: 8,
                    fixLeftEdge: false,
                    lockVisibleTimeRangeOnResize: true,
                    timeVisible: false,
                    visible: true,
                },
                rightPriceScale: {
                    borderColor: BINANCE_COLORS.border,
                    autoScale: true,
                    scaleMargins: { top: 0.1, bottom: 0 },
                },
                crosshair: {
                    mode: crosshair ? 1 : 0,
                    vertLine: {
                        color: BINANCE_COLORS.crosshair,
                        width: 1,
                        style: LineStyle.Dashed,
                        labelVisible: false,
                    },
                    horzLine: {
                        color: BINANCE_COLORS.crosshair,
                        width: 1,
                        style: LineStyle.Dashed,
                        labelBackgroundColor: BINANCE_COLORS.gridLight,
                    },
                },
                autoSize: true,
                handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
                handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
            });

            volumeSeries = volumeChart.addHistogramSeries({
                color: BINANCE_COLORS.volume.up,
                priceFormat: { type: 'volume' },
                lastValueVisible: false,
                priceLineVisible: false,
            });

            volumeChartRef.current = volumeChart;
            volumeSeriesRef.current = volumeSeries;

            // --- Sync time scales between price and volume charts ---
            const syncTimeScales = () => {
                if (isSyncingRef.current) return;
                isSyncingRef.current = true;

                const priceTimeScale = priceChart.timeScale();
                const volumeTimeScale = volumeChart!.timeScale();

                const visibleRange = priceTimeScale.getVisibleRange();
                if (visibleRange) {
                    volumeTimeScale.setVisibleRange(visibleRange);
                }

                const scrollPos = priceTimeScale.scrollPosition();
                volumeTimeScale.scrollToPosition(scrollPos, false);

                isSyncingRef.current = false;
            };

            const syncFromVolume = () => {
                if (isSyncingRef.current) return;
                isSyncingRef.current = true;

                const priceTimeScale = priceChart.timeScale();
                const volumeTimeScale = volumeChart!.timeScale();

                const visibleRange = volumeTimeScale.getVisibleRange();
                if (visibleRange) {
                    priceTimeScale.setVisibleRange(visibleRange);
                }

                const scrollPos = volumeTimeScale.scrollPosition();
                priceTimeScale.scrollToPosition(scrollPos, false);

                isSyncingRef.current = false;
            };

            priceChart.timeScale().subscribeVisibleTimeRangeChange(syncTimeScales);
            volumeChart.timeScale().subscribeVisibleTimeRangeChange(syncFromVolume);
        }

        // --- Crosshair legend ---
        if (showLegend) {
            priceChart.subscribeCrosshairMove((param) => {
                if (!param || !param.time) {
                    const lastCandle = processedData[processedData.length - 1];
                    const lastVol = normalizedVolume[normalizedVolume.length - 1];
                    if (lastCandle) {
                        setLegendData({
                            open: lastCandle.open,
                            high: lastCandle.high,
                            low: lastCandle.low,
                            close: lastCandle.close,
                            volume: lastVol?.value ?? 0,
                        });
                    }
                    return;
                }

                const candleData = param.seriesData.get(candleSeries) as CandlestickData | undefined;
                const volData = volumeSeries
                    ? (param.seriesData.get(volumeSeries) as HistogramData | undefined)
                    : undefined;

                if (candleData && 'open' in candleData) {
                    setLegendData({
                        open: candleData.open,
                        high: candleData.high,
                        low: candleData.low,
                        close: candleData.close,
                        volume: volData?.value ?? 0,
                    });
                }
            });
        }

        // --- Resize handler ---
        const handleResize = () => {
            if (priceContainerRef.current && priceChartRef.current) {
                priceChartRef.current.applyOptions({ width: priceContainerRef.current.clientWidth });
            }
            if (volumeContainerRef.current && volumeChartRef.current) {
                volumeChartRef.current.applyOptions({ width: volumeContainerRef.current.clientWidth });
            }
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            priceChart.remove();
            volumeChart?.remove();
            priceChartRef.current = null;
            volumeChartRef.current = null;
            candleSeriesRef.current = null;
            volumeSeriesRef.current = null;
            lastRenderedTimeRef.current = null;
            lastDataRef.current = null;
        };
    }, []);

    // =========================================================================
    // Data Updates (Incremental)
    // =========================================================================

    useEffect(() => {
        if (!candleSeriesRef.current || !priceChartRef.current) return;
        if (!processedData || processedData.length === 0) return;

        const chart = priceChartRef.current;
        const candleSeries = candleSeriesRef.current;
        const volumeChart = volumeChartRef.current;
        const volumeSeries = volumeSeriesRef.current;

        const intervalChanged = interval !== lastIntervalRef.current;
        const pairChanged = pair !== lastPairRef.current;
        const needsReset = intervalChanged || pairChanged || shouldResetSeries(lastDataRef.current, processedData);

        if (needsReset) {
            // --- Full setData ---
            const seriesData = buildSeriesDataWithGaps(processedData, intervalSec);
            candleSeries.setData(seriesData as CandlestickData[]);

            if (showVolume && volumeSeries) {
                const volData = buildVolumeDataWithGaps(processedData, normalizedVolume, intervalSec);
                volumeSeries.setData(volData as HistogramData[]);
            }

            const lastCandle = processedData[processedData.length - 1];
            lastRenderedTimeRef.current = lastCandle
                ? (typeof lastCandle.time === 'number' ? lastCandle.time : Number(lastCandle.time))
                : null;
            lastDataRef.current = [...processedData];
            lastIntervalRef.current = interval;
            lastPairRef.current = pair;

            chart.timeScale().fitContent();
            volumeChart?.timeScale().fitContent();

            const scalingResult = computeScalingFromData(processedData, scalingState, options);
            if (scalingResult.changed) {
                const chartOpts = createChartScalingOptions(scalingResult.state);
                candleSeries.applyOptions({
                    priceFormat: {
                        type: 'price',
                        precision: chartOpts.priceFormat.precision,
                        minMove: chartOpts.priceFormat.minMove,
                    },
                });
                chart.applyOptions({ rightPriceScale: { mode: chartOpts.priceScale.mode } });
                setScalingState(scalingResult.state);
                onScalingChange?.(scalingResult.state);
            }

            if (intervalChanged) {
                const newBarSpacing = getBarSpacingForInterval(interval);
                chart.timeScale().applyOptions({ barSpacing: newBarSpacing });
                volumeChart?.timeScale().applyOptions({ barSpacing: newBarSpacing });
            }
        } else {
            // --- Incremental update ---
            const updateCandles = getUpdateCandles(processedData, lastRenderedTimeRef.current);

            for (const candle of updateCandles) {
                const candleTime = typeof candle.time === 'number' ? candle.time : Number(candle.time);

                if (lastRenderedTimeRef.current !== null) {
                    let expectedTime = lastRenderedTimeRef.current + intervalSec;
                    while (expectedTime < candleTime) {
                        candleSeries.update({ time: expectedTime as Time } as WhitespaceData);
                        if (volumeSeries) {
                            volumeSeries.update({ time: expectedTime as Time } as WhitespaceData);
                        }
                        expectedTime += intervalSec;
                    }
                }

                candleSeries.update(ohlcToCandlestick(candle));

                if (volumeSeries) {
                    const volItem = normalizedVolume.find((v) => {
                        const vTime = typeof v.time === 'number' ? v.time : Number(v.time);
                        return vTime === candleTime;
                    });
                    const isBullish = candle.close >= candle.open;
                    volumeSeries.update({
                        time: candleTime as Time,
                        value: volItem?.value ?? 0,
                        color: isBullish ? BINANCE_COLORS.volume.up : BINANCE_COLORS.volume.down,
                    });
                }

                lastRenderedTimeRef.current = candleTime;
            }

            lastDataRef.current = [...processedData];
        }

        if (showLegend) {
            const lastCandle = processedData[processedData.length - 1];
            const lastVol = normalizedVolume[normalizedVolume.length - 1];
            if (lastCandle) {
                setLegendData({
                    open: lastCandle.open,
                    high: lastCandle.high,
                    low: lastCandle.low,
                    close: lastCandle.close,
                    volume: lastVol?.value ?? 0,
                });
            }
        }
    }, [processedData, normalizedVolume, interval, pair, showVolume, intervalSec, options]);

    // =========================================================================
    // Pair Change Handler
    // =========================================================================

    useEffect(() => {
        if (!pair) return;
        const newState = handlePairChange(pair, scalingState, options);
        setScalingState(newState);
    }, [pair, options]);

    // =========================================================================
    // Formatters
    // =========================================================================

    const formatLegendPrice = useCallback(
        (value: number) => formatPrice(value, scalingState.precision.precision),
        [scalingState.precision.precision]
    );

    // =========================================================================
    // Render
    // =========================================================================

    const legendColor = legendData && legendData.close >= legendData.open
        ? BINANCE_COLORS.candle.up
        : BINANCE_COLORS.candle.down;

    return (
        <div className="relative" style={{ width: '100%', height }}>
            {showLegend && legendData && (
                <div
                    className="absolute top-2 left-2 z-10 flex gap-4 text-xs font-mono"
                    style={{ color: BINANCE_COLORS.text }}
                >
                    <span>O: <span style={{ color: legendColor }}>{formatLegendPrice(legendData.open)}</span></span>
                    <span>H: <span style={{ color: legendColor }}>{formatLegendPrice(legendData.high)}</span></span>
                    <span>L: <span style={{ color: legendColor }}>{formatLegendPrice(legendData.low)}</span></span>
                    <span>C: <span style={{ color: legendColor }}>{formatLegendPrice(legendData.close)}</span></span>
                    {showVolume && (
                        <span>Vol: <span style={{ color: BINANCE_COLORS.text }}>{formatVolume(legendData.volume)}</span></span>
                    )}
                    {heikinAshi && (
                        <span className="px-1 rounded text-[10px]" style={{ backgroundColor: BINANCE_COLORS.grid, color: BINANCE_COLORS.candle.up }}>
                            HA
                        </span>
                    )}
                    {scalingState.scaleMode === 'logarithmic' && (
                        <span className="px-1 rounded text-[10px]" style={{ backgroundColor: BINANCE_COLORS.grid, color: '#F0B90B' }}>
                            LOG
                        </span>
                    )}
                </div>
            )}

            <div ref={priceContainerRef} style={{ width: '100%', height: priceHeight }} />

            {showVolume && (
                <div
                    ref={volumeContainerRef}
                    style={{ width: '100%', height: volumeHeight, borderTop: `1px solid ${BINANCE_COLORS.border}` }}
                />
            )}
        </div>
    );
}

export { CandleChart } from './CandleChart';
