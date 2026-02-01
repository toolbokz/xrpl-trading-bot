"use client";

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
} from 'lightweight-charts';

// Import adaptive scaling system
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
    processStreamingUpdate,
    handlePairChange,
    toggleHeikinAshiMode,
    createChartScalingOptions,
    captureChartState,
    restoreChartState,
} from '../lib/chart/adaptiveScaling';
import {
    convertToHeikinAshi,
    updateLastHACandle,
} from '../lib/chart/heikinAshi';
import {
    createVolumeFromCandles,
    normalizeVolumeData,
} from '../lib/chart/volumeScaling';

/**
 * Enhanced CandleChart Props with adaptive scaling support
 */
export interface AdaptiveCandleChartProps {
    /** Candlestick data (OHLC format) */
    data: OHLCData[];
    /** Trading pair identifier (e.g., 'XRP/RLUSD') */
    pair?: string;
    /** Chart height in pixels */
    height?: number;
    /** Show volume histogram */
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

/**
 * Convert OHLCData to lightweight-charts CandlestickData
 */
function toChartData(data: OHLCData[]): CandlestickData[] {
    return data.map((candle) => ({
        time: candle.time as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
    }));
}

/**
 * Convert VolumeData to histogram data
 */
function toHistogramData(
    volumeData: VolumeData[],
    candles: OHLCData[]
): HistogramData[] {
    return volumeData.map((vol, i) => {
        const candle = candles[i];
        const isBullish = candle ? candle.close >= candle.open : true;
        return {
            time: vol.time as Time,
            value: vol.value,
            color: isBullish
                ? BINANCE_COLORS.volume.up
                : BINANCE_COLORS.volume.down,
        };
    });
}

/**
 * AdaptiveCandleChart - Enhanced candlestick chart with Binance-style scaling
 */
export function AdaptiveCandleChart({
    data,
    pair = '',
    height = 400,
    showVolume = true,
    volumeData,
    heikinAshi = false,
    scalingOptions,
    onScalingChange,
    crosshair = true,
    showLegend = true,
}: AdaptiveCandleChartProps) {
    // Refs
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

    // State
    const [scalingState, setScalingState] = useState<ScalingState>(() =>
        createInitialScalingState(pair, { ...DEFAULT_SCALING_OPTIONS, ...scalingOptions })
    );
    const [legendData, setLegendData] = useState<{
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    } | null>(null);

    // Merged options
    const options = useMemo(
        () => ({ ...DEFAULT_SCALING_OPTIONS, ...scalingOptions }),
        [scalingOptions]
    );

    // Process data based on mode
    const processedData = useMemo(() => {
        if (!data || data.length === 0) return [];
        if (heikinAshi) {
            return convertToHeikinAshi(data);
        }
        return data;
    }, [data, heikinAshi]);

    // Generate volume data if not provided
    const effectiveVolumeData = useMemo(() => {
        if (volumeData) return volumeData;
        return createVolumeFromCandles(data);
    }, [data, volumeData]);

    // Normalized volume data
    const normalizedVolume = useMemo(() => {
        return normalizeVolumeData(effectiveVolumeData);
    }, [effectiveVolumeData]);

    // Initialize chart
    useEffect(() => {
        if (!containerRef.current) return;

        const chartOptions = createChartScalingOptions(scalingState);

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: BINANCE_COLORS.background },
                textColor: BINANCE_COLORS.text,
            },
            grid: {
                vertLines: { color: BINANCE_COLORS.grid, style: LineStyle.Solid },
                horzLines: { color: BINANCE_COLORS.grid, style: LineStyle.Solid },
            },
            timeScale: {
                borderColor: BINANCE_COLORS.grid,
                barSpacing: chartOptions.timeScale.barSpacing,
                minBarSpacing: chartOptions.timeScale.minBarSpacing,
                rightOffset: 12,
                fixLeftEdge: true,
                lockVisibleTimeRangeOnResize: true,
            },
            rightPriceScale: {
                borderColor: BINANCE_COLORS.grid,
                mode: chartOptions.priceScale.mode,
                autoScale: true,
                scaleMargins: {
                    top: 0.1,
                    bottom: showVolume ? 0.25 : 0.1,
                },
            },
            crosshair: {
                mode: crosshair ? 1 : 0, // Magnet mode
                vertLine: {
                    color: BINANCE_COLORS.text,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: BINANCE_COLORS.grid,
                },
                horzLine: {
                    color: BINANCE_COLORS.text,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: BINANCE_COLORS.grid,
                },
            },
            autoSize: true,
        });

        // Create candlestick series
        const candleSeries = chart.addCandlestickSeries({
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

        // Create volume histogram if enabled
        let volumeSeries: ISeriesApi<'Histogram'> | null = null;
        if (showVolume) {
            volumeSeries = chart.addHistogramSeries({
                priceFormat: {
                    type: 'volume',
                },
                priceScaleId: 'volume',
            });

            // Set scale margins for volume pane
            chart.priceScale('volume').applyOptions({
                scaleMargins: {
                    top: 0.8,
                    bottom: 0,
                },
            });
        }

        chartRef.current = chart;
        candleSeriesRef.current = candleSeries;
        volumeSeriesRef.current = volumeSeries;

        // Subscribe to crosshair move for legend
        if (showLegend) {
            chart.subscribeCrosshairMove((param) => {
                if (!param || !param.time) {
                    // Show latest data when not hovering
                    const lastCandle = processedData[processedData.length - 1];
                    const lastVolume = effectiveVolumeData[effectiveVolumeData.length - 1];
                    if (lastCandle) {
                        setLegendData({
                            open: lastCandle.open,
                            high: lastCandle.high,
                            low: lastCandle.low,
                            close: lastCandle.close,
                            volume: lastVolume?.value ?? 0,
                        });
                    }
                    return;
                }

                const candleData = param.seriesData.get(candleSeries) as CandlestickData | undefined;
                const volumeDataPoint = volumeSeries
                    ? (param.seriesData.get(volumeSeries) as HistogramData | undefined)
                    : undefined;

                if (candleData) {
                    setLegendData({
                        open: candleData.open,
                        high: candleData.high,
                        low: candleData.low,
                        close: candleData.close,
                        volume: volumeDataPoint?.value ?? 0,
                    });
                }
            });
        }

        // Handle resize
        const handleResize = () => {
            if (containerRef.current && chartRef.current) {
                const { clientWidth } = containerRef.current;
                chartRef.current.applyOptions({ width: clientWidth });
            }
        };
        handleResize();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.remove();
            chartRef.current = null;
            candleSeriesRef.current = null;
            volumeSeriesRef.current = null;
        };
    }, []); // Only run once on mount

    // Update data and scaling when data changes
    useEffect(() => {
        if (!candleSeriesRef.current || !chartRef.current) return;
        if (!processedData || processedData.length === 0) return;

        // Capture current state before update
        const stateSnapshot = captureChartState(chartRef.current);

        // Compute new scaling
        const scalingResult = computeScalingFromData(processedData, scalingState, options);

        // Update series data
        candleSeriesRef.current.setData(toChartData(processedData));

        // Update volume if enabled
        if (showVolume && volumeSeriesRef.current) {
            volumeSeriesRef.current.setData(
                toHistogramData(normalizedVolume, processedData)
            );
        }

        // Apply scaling changes if needed
        if (scalingResult.changed) {
            const chartOptions = createChartScalingOptions(scalingResult.state);

            // Update price format
            candleSeriesRef.current.applyOptions({
                priceFormat: {
                    type: 'price',
                    precision: chartOptions.priceFormat.precision,
                    minMove: chartOptions.priceFormat.minMove,
                },
            });

            // Update time scale
            chartRef.current.timeScale().applyOptions({
                barSpacing: chartOptions.timeScale.barSpacing,
                minBarSpacing: chartOptions.timeScale.minBarSpacing,
            });

            // Update price scale mode
            chartRef.current.applyOptions({
                rightPriceScale: {
                    mode: chartOptions.priceScale.mode,
                },
            });

            // Update state
            setScalingState(scalingResult.state);

            // Notify callback
            if (onScalingChange) {
                onScalingChange(scalingResult.state);
            }
        }

        // Restore state if we had a snapshot, otherwise fit content
        if (stateSnapshot && stateSnapshot.visibleRange) {
            restoreChartState(chartRef.current, stateSnapshot);
        } else {
            chartRef.current.timeScale().fitContent();
        }

        // Update legend with latest data
        if (showLegend) {
            const lastCandle = processedData[processedData.length - 1];
            const lastVolume = effectiveVolumeData[effectiveVolumeData.length - 1];
            if (lastCandle) {
                setLegendData({
                    open: lastCandle.open,
                    high: lastCandle.high,
                    low: lastCandle.low,
                    close: lastCandle.close,
                    volume: lastVolume?.value ?? 0,
                });
            }
        }
    }, [processedData, normalizedVolume, showVolume, options]);

    // Handle pair change
    useEffect(() => {
        if (!pair) return;
        const newState = handlePairChange(pair, scalingState, options);
        setScalingState(newState);
    }, [pair, options]);

    // Format price for legend display
    const formatPrice = useCallback(
        (value: number) => {
            return value.toFixed(scalingState.precision.precision);
        },
        [scalingState.precision.precision]
    );

    // Format volume for legend display
    const formatVolume = useCallback((value: number) => {
        if (value >= 1_000_000) {
            return `${(value / 1_000_000).toFixed(2)}M`;
        }
        if (value >= 1_000) {
            return `${(value / 1_000).toFixed(2)}K`;
        }
        return value.toFixed(2);
    }, []);

    return (
        <div className="relative" style={{ width: '100%', height }}>
            {/* Legend */}
            {showLegend && legendData && (
                <div
                    className="absolute top-2 left-2 z-10 flex gap-4 text-xs font-mono"
                    style={{ color: BINANCE_COLORS.text }}
                >
                    <span>
                        O:{' '}
                        <span
                            style={{
                                color:
                                    legendData.close >= legendData.open
                                        ? BINANCE_COLORS.candle.up
                                        : BINANCE_COLORS.candle.down,
                            }}
                        >
                            {formatPrice(legendData.open)}
                        </span>
                    </span>
                    <span>
                        H:{' '}
                        <span
                            style={{
                                color:
                                    legendData.close >= legendData.open
                                        ? BINANCE_COLORS.candle.up
                                        : BINANCE_COLORS.candle.down,
                            }}
                        >
                            {formatPrice(legendData.high)}
                        </span>
                    </span>
                    <span>
                        L:{' '}
                        <span
                            style={{
                                color:
                                    legendData.close >= legendData.open
                                        ? BINANCE_COLORS.candle.up
                                        : BINANCE_COLORS.candle.down,
                            }}
                        >
                            {formatPrice(legendData.low)}
                        </span>
                    </span>
                    <span>
                        C:{' '}
                        <span
                            style={{
                                color:
                                    legendData.close >= legendData.open
                                        ? BINANCE_COLORS.candle.up
                                        : BINANCE_COLORS.candle.down,
                            }}
                        >
                            {formatPrice(legendData.close)}
                        </span>
                    </span>
                    {showVolume && (
                        <span>
                            Vol: <span style={{ color: BINANCE_COLORS.text }}>{formatVolume(legendData.volume)}</span>
                        </span>
                    )}
                    {heikinAshi && (
                        <span
                            className="px-1 rounded text-[10px]"
                            style={{
                                backgroundColor: BINANCE_COLORS.grid,
                                color: BINANCE_COLORS.candle.up,
                            }}
                        >
                            HA
                        </span>
                    )}
                    {scalingState.scaleMode === 'logarithmic' && (
                        <span
                            className="px-1 rounded text-[10px]"
                            style={{
                                backgroundColor: BINANCE_COLORS.grid,
                                color: '#F0B90B',
                            }}
                        >
                            LOG
                        </span>
                    )}
                </div>
            )}

            {/* Chart container */}
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>
    );
}

/**
 * Re-export original CandleChart for backward compatibility
 */
export { CandleChart } from './CandleChart';
