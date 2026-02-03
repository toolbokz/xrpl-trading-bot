"use client";

import { useEffect, useRef } from 'react';
import { createChart, CandlestickData, IChartApi, ISeriesApi } from 'lightweight-charts';

export type CandleChartProps = {
    data: CandlestickData[];
    height?: number;
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

        const chart = createChart(containerRef.current, {
            width: containerRef.current.clientWidth || 600,
            height: height,
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
                chartRef.current.applyOptions({
                    width: containerRef.current.clientWidth || 600,
                });
            }
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
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

    return <div ref={containerRef} style={{ width: '100%', height }} />;
}
