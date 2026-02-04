"use client";

import { useEffect, useRef } from 'react';
import { createChart, CandlestickData, IChartApi, ISeriesApi } from 'lightweight-charts';

export type CandleChartProps = {
    data: CandlestickData[];
    height?: number | string;
};

const BINANCE_COLORS = {
    up: '#0ECB81',
    down: '#F6465D',
    background: '#0B0E11',
    grid: '#1E2329',
    text: '#D1D4DC',
};

export function CandleChart({ data, height = 320 }: CandleChartProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

    // Initialize chart
    useEffect(() => {
        if (!containerRef.current) return;

        // Get actual pixel height from container
        const containerHeight = containerRef.current.clientHeight || (typeof height === 'number' ? height : 320);

        const chart = createChart(containerRef.current, {
            width: containerRef.current.clientWidth || 600,
            height: containerHeight,
            layout: {
                background: { color: BINANCE_COLORS.background },
                textColor: BINANCE_COLORS.text,
            },
            grid: {
                vertLines: { color: BINANCE_COLORS.grid },
                horzLines: { color: BINANCE_COLORS.grid },
            },
            timeScale: {
                borderColor: BINANCE_COLORS.grid,
                timeVisible: true,
                secondsVisible: false,
            },
            rightPriceScale: {
                borderColor: BINANCE_COLORS.grid,
                scaleMargins: {
                    top: 0.1,
                    bottom: 0.1,
                },
            },
            crosshair: {
                mode: 1,
                horzLine: {
                    color: '#758696',
                    width: 1,
                    style: 2,
                    labelBackgroundColor: '#2B3139',
                },
                vertLine: {
                    color: '#758696',
                    width: 1,
                    style: 2,
                    labelBackgroundColor: '#2B3139',
                },
            },
        });

        const series = chart.addCandlestickSeries({
            upColor: BINANCE_COLORS.up,
            downColor: BINANCE_COLORS.down,
            wickUpColor: BINANCE_COLORS.up,
            wickDownColor: BINANCE_COLORS.down,
            borderVisible: false,
        });

        chartRef.current = chart;
        seriesRef.current = series;

        const handleResize = () => {
            if (containerRef.current && chartRef.current) {
                const newHeight = containerRef.current.clientHeight || (typeof height === 'number' ? height : 320);
                chartRef.current.applyOptions({
                    width: containerRef.current.clientWidth || 600,
                    height: newHeight,
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
