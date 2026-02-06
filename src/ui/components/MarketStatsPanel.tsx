'use client';

import clsx from 'clsx';
import { TrendingUp, TrendingDown, Wallet, Target, Shield } from 'lucide-react';
import { Panel } from './Panel';

interface MarketStatsPanelProps {
    /** Total PnL in XRP */
    totalPnl: number;
    /** Today's PnL in XRP */
    todayPnl: number;
    /** Win rate percentage */
    winRate: number;
    /** Current position (e.g., "Flat", "Long 100 XRP") */
    position: string;
    /** XRP balance */
    xrpBalance: number;
    /** Quote currency balance (e.g., RLUSD) */
    quoteBalance: number;
    /** Quote currency symbol */
    quoteCurrency: string;
    /** XRP to USD rate (null if unavailable) */
    usdRate: number | null;
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
}: MarketStatsPanelProps) {
    // Calculate USD value if rate is available
    // RLUSD is a USD stablecoin, so 1 RLUSD = 1 USD
    const xrpUsdValue = usdRate !== null ? xrpBalance * usdRate : null;
    const quoteUsdValue = quoteCurrency === 'RLUSD' ? quoteBalance : null;
    const totalUsdValue = xrpUsdValue !== null
        ? xrpUsdValue + (quoteUsdValue ?? 0)
        : null;

    return (
        <Panel
            title="Market Stats"
            icon={TrendingUp}
            fillHeight
            compact
            bodyClassName="p-3"
        >
            <div className="h-full flex flex-col gap-2">
                {/* PnL Row */}
                <div className="grid grid-cols-2 gap-2">
                    <StatBox
                        label="Total P&L"
                        value={`${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)}`}
                        suffix="XRP"
                        positive={totalPnl >= 0}
                    />
                    <StatBox
                        label="Today"
                        value={`${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(4)}`}
                        suffix="XRP"
                        positive={todayPnl >= 0}
                    />
                </div>

                {/* Win Rate & Position */}
                <div className="grid grid-cols-2 gap-2">
                    <StatBox
                        label="Win Rate"
                        value={`${winRate.toFixed(1)}%`}
                        icon={Target}
                        positive={winRate >= 50}
                    />
                    <StatBox
                        label="Position"
                        value={position}
                        icon={Shield}
                        neutral
                    />
                </div>

                {/* Balances */}
                <div className="flex-1 min-h-0 flex flex-col justify-end">
                    <div className="rounded-xl bg-white/5 p-3">
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wider mb-2">
                            <Wallet size={10} />
                            <span>Wallet Balances</span>
                        </div>
                        <div className="flex items-baseline justify-between">
                            <div>
                                <span className="text-lg font-semibold text-slate-100 font-mono">
                                    {xrpBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                </span>
                                <span className="text-xs text-sky-400 ml-1">XRP</span>
                            </div>
                            {quoteCurrency && (
                                <div className="text-right">
                                    <span className="text-sm font-semibold text-slate-200 font-mono">
                                        {quoteBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                    </span>
                                    <span className="text-xs text-emerald-400 ml-1">{quoteCurrency}</span>
                                </div>
                            )}
                        </div>
                        {totalUsdValue !== null ? (
                            <div className="text-[10px] text-slate-500 mt-1">
                                ≈ ${totalUsdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD
                            </div>
                        ) : (
                            <div className="text-[10px] text-slate-600 mt-1">
                                USD value unavailable
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </Panel>
    );
}

function StatBox({
    label,
    value,
    suffix,
    icon: Icon,
    positive,
    neutral,
}: {
    label: string;
    value: string;
    suffix?: string;
    icon?: typeof TrendingUp;
    positive?: boolean;
    neutral?: boolean;
}) {
    return (
        <div className="rounded-xl bg-white/5 px-3 py-2">
            <div className="flex items-center gap-1 text-[10px] text-slate-500 uppercase tracking-wider">
                {Icon && <Icon size={10} />}
                <span>{label}</span>
            </div>
            <div className="flex items-baseline gap-1 mt-0.5">
                <span className={clsx(
                    'text-sm font-semibold font-mono',
                    neutral ? 'text-slate-200' : positive ? 'text-emerald-400' : 'text-red-400'
                )}>
                    {value}
                </span>
                {suffix && <span className="text-[10px] text-slate-500">{suffix}</span>}
            </div>
        </div>
    );
}
