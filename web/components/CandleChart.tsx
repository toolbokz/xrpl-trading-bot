"use client";

import { useEffect, useRef } from 'react';
import { createChart, CandlestickData, IChartApi, ISeriesApi, LineStyle } from 'lightweight-charts';
import { BINANCE_COLORS } from '../lib/chart/types';
import { calculateDynamicBarSpacing, BINANCE_SPACING } from '../lib/chart/spacing';

export type CandleChartProps = {
    data: CandlestickData[];
    height?: number | string;
};

export function CandleChart({ data, height = 320 }: CandleChartProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

    // Initialize chart
    useEffect(() => {
        if (!containerRef.current) return;

        // Get actual pixel dimensions
        const containerWidth = containerRef.current.clientWidth || 600;
        const containerHeight = containerRef.current.clientHeight || (typeof height === 'number' ? height : 320);
        const dataLength = data.length || 50;

        // Calculate dynamic pixel-aware spacing
        const dynamicSpacing = calculateDynamicBarSpacing(containerWidth, dataLength);

        const chart = createChart(containerRef.current, {
            width: containerWidth,
            height: containerHeight,
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
                timeVisible: true,
                secondsVisible: false,
                barSpacing: dynamicSpacing,
                minBarSpacing: BINANCE_SPACING.MIN_CLAMP,
                rightOffset: 8,
            },
            rightPriceScale: {
                borderColor: BINANCE_COLORS.border,
                scaleMargins: {
                    top: 0.08,
                    bottom: 0.08,
                },
            },
            crosshair: {
                mode: 1,
                horzLine: {
                    color: BINANCE_COLORS.crosshair,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: BINANCE_COLORS.gridLight,
                },
                vertLine: {
                    color: BINANCE_COLORS.crosshair,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: BINANCE_COLORS.gridLight,
                },
            },
        });

        const series = chart.addCandlestickSeries({
            upColor: BINANCE_COLORS.candle.up,
            downColor: BINANCE_COLORS.candle.down,
            wickUpColor: BINANCE_COLORS.candle.wickUp,
            wickDownColor: BINANCE_COLORS.candle.wickDown,
            borderVisible: false,
            priceFormat: {
                type: 'price',
                precision: 4,
                minMove: 0.0001,
            },
        });

        chartRef.current = chart;
        seriesRef.current = series;

        const handleResize = () => {
            if (containerRef.current && chartRef.current) {
                const newWidth = containerRef.current.clientWidth || 600;
                const newHeight = containerRef.current.clientHeight || (typeof height === 'number' ? height : 320);
                const currentDataLength = data.length || 50;

                // Recalculate dynamic spacing on resize
                const newDynamicSpacing = calculateDynamicBarSpacing(newWidth, currentDataLength);

                chartRef.current.applyOptions({
                    width: newWidth,
                    height: newHeight,
                });
                chartRef.current.timeScale().applyOptions({
                    barSpacing: newDynamicSpacing,
                    minBarSpacing: BINANCE_SPACING.MIN_CLAMP,
                });
            }
        };
        window.addEventListener('resize', handleResize);

        // Also observe container size changes
        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(containerRef.current);

        return () => {
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
        };
    }, [height]);

    // Update data when it changes
    useEffect(() => {
        if (!seriesRef.current || !chartRef.current) return;

        seriesRef.current.setData(data);
        chartRef.current.timeScale().fitContent();
    }, [data]);

    const style = typeof height === 'number'
        ? { width: '100%', height }
        : { width: '100%', height: '100%' };

    return <div ref={containerRef} style={style} />;
}
