'use client';

import clsx from 'clsx';
import { Sparkline } from './charts/Sparkline';

interface MarketStatsPanelProps {
    totalPnl: number;
    todayPnl: number;
    winRate: number;
    position: string;
    xrpBalance: number;
    quoteBalance: number;
    quoteCurrency: string;
    usdRate: number | null;
    xrpBalanceHistory?: number[];
}

export function MarketStatsPanel({
    totalPnl,
    todayPnl,
    winRate,
    position,
    xrpBalance,
    quoteBalance,
    quoteCurrency,
    usdRate,
    xrpBalanceHistory,
}: MarketStatsPanelProps) {
    const xrpUsdValue = usdRate !== null ? xrpBalance * usdRate : null;
    const USD_PEGGED = new Set(['RLUSD', 'USDT', 'USDC']);
    const quoteUsdValue = USD_PEGGED.has(quoteCurrency) ? quoteBalance : null;
    const totalUsdValue = xrpUsdValue !== null ? xrpUsdValue + (quoteUsdValue ?? 0) : null;

    return (
        <div className="rounded-lg bg-card/60 border border-white/[0.06] px-2 py-1.5">
            <div className="flex items-center justify-center gap-2 flex-wrap">
                <span className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider shrink-0">Stats</span>

                <Stat
                    label="P&L"
                    value={`${(totalPnl ?? 0) >= 0 ? '+' : ''}${(totalPnl ?? 0).toFixed(4)}`}
                    suffix="XRP"
                    positive={(totalPnl ?? 0) >= 0}
                />
                <Stat
                    label="Today"
                    value={`${(todayPnl ?? 0) >= 0 ? '+' : ''}${(todayPnl ?? 0).toFixed(4)}`}
                    suffix="XRP"
                    positive={(todayPnl ?? 0) >= 0}
                />
                <Stat label="Win" value={`${(winRate ?? 0).toFixed(1)}%`} positive={(winRate ?? 0) >= 50} />
                <Stat label="Pos" value={position} neutral />

                {/* Balance cell */}
                <div className="flex items-center gap-2 px-2 py-1 rounded bg-white/[0.03] min-w-0">
                    <div className="flex items-baseline gap-1 min-w-0">
                        <span className="text-[11px] font-semibold text-slate-100 font-mono">
                            {xrpBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                        <span className="text-[9px] text-sky-400">XRP</span>
                    </div>
                    {quoteCurrency && (
                        <div className="flex items-baseline gap-1 min-w-0">
                            <span className="text-[11px] font-semibold text-slate-200 font-mono">
                                {quoteBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                            <span className="text-[9px] text-emerald-400">{quoteCurrency}</span>
                        </div>
                    )}
                    {totalUsdValue !== null && (
                        <span className="text-[9px] text-slate-500">
                            ≈${totalUsdValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                    )}
                    {xrpBalanceHistory && xrpBalanceHistory.length >= 3 && (
                        <Sparkline data={xrpBalanceHistory} width={60} height={14} fill strokeWidth={1} />
                    )}
                </div>
            </div>
        </div>
    );
}

function Stat({
    label,
    value,
    suffix,
    positive,
    neutral,
}: {
    label: string;
    value: string;
    suffix?: string;
    positive?: boolean;
    neutral?: boolean;
}) {
    return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/[0.03] min-w-0">
            <span className="text-[9px] text-slate-500 uppercase tracking-wider shrink-0">{label}</span>
            <span className={clsx(
                'text-[11px] font-semibold font-mono',
                neutral ? 'text-slate-200' : positive ? 'text-emerald-400' : 'text-red-400'
            )}>
                {value}
            </span>
            {suffix && <span className="text-[9px] text-slate-500">{suffix}</span>}
        </div>
    );
}
