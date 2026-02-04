'use client';

import { Activity, Maximize2 } from 'lucide-react';
import { Panel, PanelAction, PanelBadge } from './Panel';
import { CandleChart } from './CandleChart';
import { CandlestickData } from 'lightweight-charts';

interface ChartPanelProps {
    data: CandlestickData[];
    pairKey: string;
    currentPrice: number;
    quoteCurrency: string;
    spreadBps: number;
    onExpand?: () => void;
}

export function ChartPanel({
    data,
    pairKey,
    currentPrice,
    quoteCurrency,
    spreadBps,
    onExpand,
}: ChartPanelProps) {
    const formatPrice = (p: number) => {
        if (p >= 1) return p.toFixed(4);
        if (p >= 0.001) return p.toFixed(6);
        return p.toFixed(8);
    };

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
                                {quoteCurrency || 'QUOTE'}/XRP
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
            <div className="h-full w-full">
                <CandleChart data={data} height="100%" />
            </div>
        </Panel>
    );
}
