'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { Settings, Zap, Shield, AlertTriangle } from 'lucide-react';
import { Panel, PanelBadge } from './Panel';

interface ControlsPanelProps {
    /** Trading pair selector component */
    pairSelector: ReactNode;
    /** Current strategy */
    strategy: string;
    /** Last ledger index */
    lastLedger: number;
    /** Liquidity level */
    liquidity: string;
    /** Estimated slippage in bps */
    slippageBps: number;
    /** Position size in XRP */
    positionSize: number;
    /** Max exposure limit */
    maxExposure: number;
    /** Current exposure */
    currentExposure: number;
    /** Daily loss limit */
    dailyLossLimit: number;
    /** Kill switch engaged */
    killSwitch: boolean;
    /** Callbacks */
    onPositionSizeChange: (size: number) => void;
    onApplyPositionSize: () => void;
    loading?: boolean;
    message?: string;
}

export function ControlsPanel({
    pairSelector,
    strategy,
    lastLedger,
    liquidity,
    slippageBps,
    positionSize,
    maxExposure,
    currentExposure,
    dailyLossLimit,
    killSwitch,
    onPositionSizeChange,
    onApplyPositionSize,
    loading,
    message,
}: ControlsPanelProps) {
    const exposurePercent = maxExposure > 0 ? (currentExposure / maxExposure) * 100 : 0;

    return (
        <Panel
            title="Strategy & Risk"
            icon={Settings}
            fillHeight
            compact
            actions={
                <PanelBadge tone={killSwitch ? 'danger' : 'success'}>
                    {killSwitch ? 'KILL SWITCH' : 'Nominal'}
                </PanelBadge>
            }
            bodyClassName="p-3 overflow-y-auto"
        >
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {/* Trading Pair - spans 2 cols on lg */}
                <div className="col-span-2">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Trading Pair</div>
                    {pairSelector}
                </div>

                {/* Strategy */}
                <ControlItem label="Strategy" value={strategy} />

                {/* Position Size */}
                <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Position Size</div>
                    <div className="flex items-center gap-2">
                        <input
                            type="number"
                            min={0}
                            step={1}
                            value={positionSize}
                            onChange={(e) => onPositionSizeChange(Number(e.target.value))}
                            className="w-20 rounded-lg bg-slate-900 border border-white/10 px-2 py-1.5 text-xs text-right text-slate-100 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                        />
                        <button
                            onClick={onApplyPositionSize}
                            disabled={loading}
                            className="px-2 py-1.5 rounded-lg text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 transition-colors disabled:opacity-50"
                        >
                            Set
                        </button>
                    </div>
                    {message && <div className="text-[10px] text-slate-500 mt-1 truncate">{message}</div>}
                </div>

                {/* Risk Stats */}
                <ControlItem label="Slippage" value={`${slippageBps} bps`} />
                <ControlItem label="Liquidity" value={liquidity} />
                <ControlItem label="Ledger" value={lastLedger.toLocaleString()} mono />

                {/* Exposure meter */}
                <div className="col-span-2 lg:col-span-1">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Exposure</div>
                    <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden">
                            <div
                                className={clsx(
                                    'h-full rounded-full transition-all',
                                    exposurePercent > 80 ? 'bg-red-500' : exposurePercent > 50 ? 'bg-amber-500' : 'bg-emerald-500'
                                )}
                                style={{ width: `${Math.min(exposurePercent, 100)}%` }}
                            />
                        </div>
                        <span className="text-[10px] text-slate-400 font-mono w-10 text-right">
                            {exposurePercent.toFixed(0)}%
                        </span>
                    </div>
                </div>
            </div>

            {/* Risk limits row */}
            <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-white/5">
                <RiskStat label="Max Exposure" value={maxExposure} />
                <RiskStat label="Current" value={currentExposure} warn={currentExposure > maxExposure * 0.8} />
                <RiskStat label="Daily Loss Limit" value={dailyLossLimit} />
            </div>

            {/* Kill switch warning */}
            {killSwitch && (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20">
                    <AlertTriangle size={14} className="text-red-400 shrink-0" />
                    <span className="text-xs text-red-400">Kill switch engaged - trading halted</span>
                </div>
            )}
        </Panel>
    );
}

function ControlItem({
    label,
    value,
    mono,
}: {
    label: string;
    value: string | number;
    mono?: boolean;
}) {
    return (
        <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{label}</div>
            <div className={clsx('text-sm text-slate-200', mono && 'font-mono')}>{value}</div>
        </div>
    );
}

function RiskStat({
    label,
    value,
    warn,
}: {
    label: string;
    value: number;
    warn?: boolean;
}) {
    return (
        <div className="rounded-lg bg-white/5 px-2 py-1.5 text-center">
            <div className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</div>
            <div className={clsx('text-xs font-semibold font-mono', warn ? 'text-amber-400' : 'text-slate-200')}>
                {value.toLocaleString()}
            </div>
        </div>
    );
}
