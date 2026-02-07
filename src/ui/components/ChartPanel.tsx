'use client';

import { Activity, Maximize2, Loader2, AlertCircle } from 'lucide-react';
import { Panel, PanelAction, PanelBadge } from './Panel';
import { CandleChart } from './CandleChart';
import { CandlestickData } from 'lightweight-charts';
import { VolumeData } from '../lib/chart/types';

interface ChartPanelProps {
    data: CandlestickData[];
    volumeData?: VolumeData[];
    pairKey: string;
    currentPrice: number;
    quoteCurrency: string;
    spreadBps: number;
    loading?: boolean;
    error?: string | null;
    onExpand?: () => void;
}

export function ChartPanel({
    data,
    volumeData,
    pairKey,
    currentPrice,
    quoteCurrency,
    spreadBps,
    loading = false,
    error = null,
    onExpand,
}: ChartPanelProps) {
    const formatPrice = (p: number) => {
        if (p >= 1) return p.toFixed(4);
        if (p >= 0.001) return p.toFixed(6);
        return p.toFixed(8);
    };

    const isEmpty = data.length === 0;

    return (
        <Panel
            title={pairKey || 'Select Pair'}
            icon={Activity}
            fillHeight
            actions={
                <>
                    {currentPrice > 0 && (
                        <div className="flex items-baseline gap-2 mr-2">
                            <span className="text-base font-semibold text-emerald-400 font-mono">
                                {formatPrice(currentPrice)}
                            </span>
                            <span className="text-[10px] text-slate-500">
                                {quoteCurrency || 'QUOTE'}
                            </span>
                        </div>
                    )}
                    <PanelBadge tone={spreadBps > 30 ? 'warning' : 'neutral'}>
                        {spreadBps.toFixed(1)} bps
                    </PanelBadge>
                    {onExpand && (
                        <PanelAction icon={Maximize2} onClick={onExpand} label="Expand" />
                    )}
                </>
            }
            bodyClassName="p-2"
        >
            <div className="h-full w-full relative">
                {/* Loading state */}
                {loading && isEmpty && (
                    <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
                        <div className="flex items-center gap-2 text-slate-400">
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span className="text-sm">Loading chart data...</span>
                        </div>
                    </div>
                )}

                {/* Error state */}
                {error && (
                    <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
                        <div className="flex items-center gap-2 text-red-400">
                            <AlertCircle className="w-5 h-5" />
                            <span className="text-sm">{error}</span>
                        </div>
                    </div>
                )}

                {/* Empty state (no error, not loading, but no data) */}
                {!loading && !error && isEmpty && pairKey && pairKey !== 'Select Pair' && (
                    <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
                        <div className="text-center text-slate-500">
                            <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
                            <p className="text-sm">No trade data available</p>
                            <p className="text-xs mt-1">Candles will appear as trades occur</p>
                        </div>
                    </div>
                )}

                {/* No pair selected */}
                {(!pairKey || pairKey === 'Select Pair') && (
                    <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
                        <div className="text-center text-slate-500">
                            <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
                            <p className="text-sm">Select a trading pair</p>
                        </div>
                    </div>
                )}

                {/* Chart */}
                <CandleChart data={data} volumeData={volumeData ?? []} height="100%" />
            </div>
        </Panel>
    );
}
