'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { Settings, AlertTriangle } from 'lucide-react';
import { Panel, PanelBadge } from './Panel';

interface ControlsPanelProps {
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
    /** Trading pair selector component */
    pairSelector?: ReactNode;
    /** Position size change handler */
    onPositionSizeChange?: (size: number) => void;
    /** Apply position size handler */
    onApplyPositionSize?: () => void;
    /** Position size feedback message */
    positionSizeMessage?: string;
    /** Whether actions are loading */
    loading?: boolean;
}

export function ControlsPanel({
    strategy,
    lastLedger,
    liquidity,
    slippageBps,
    positionSize,
    maxExposure,
    currentExposure,
    dailyLossLimit,
    killSwitch,
    pairSelector,
    onPositionSizeChange,
    onApplyPositionSize,
    positionSizeMessage,
    loading,
}: ControlsPanelProps) {
    return (
        <Panel
            title="Strategy & Risk"
            icon={Settings}
            compact
            actions={
                <PanelBadge tone={killSwitch ? 'danger' : 'success'}>
                    {killSwitch ? 'KILL' : 'OK'}
                </PanelBadge>
            }
            bodyClassName="p-2 overflow-y-auto"
        >
            {/* Pair Selector */}
            {pairSelector && (
                <div className="mb-2 pb-2 border-b border-white/5">
                    <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Pair</div>
                    {pairSelector}
                </div>
            )}

            {/* Position Size */}
            {onPositionSizeChange && onApplyPositionSize && (
                <div className="mb-2 pb-2 border-b border-white/5">
                    <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Position Size</div>
                    <div className="flex items-center gap-1.5">
                        <input
                            type="number"
                            min={0}
                            step={1}
                            value={positionSize}
                            onChange={(e) => onPositionSizeChange(Number(e.target.value))}
                            className="flex-1 rounded bg-slate-900 border border-white/10 px-2 py-1 text-[11px] text-right text-slate-100 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                        />
                        <span className="text-[9px] text-slate-500">XRP</span>
                        <button
                            onClick={onApplyPositionSize}
                            disabled={loading}
                            className="px-2 py-1 rounded text-[9px] font-semibold bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 transition-colors disabled:opacity-50"
                        >
                            Set
                        </button>
                    </div>
                    {positionSizeMessage && (
                        <div className="text-[9px] text-slate-500 mt-0.5">{positionSizeMessage}</div>
                    )}
                </div>
            )}

            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                <ControlItem label="Strategy" value={strategy} />
                <ControlItem label="Slippage" value={`${slippageBps} bps`} />
                <ControlItem label="Liquidity" value={liquidity} />
                <ControlItem label="Ledger" value={lastLedger.toLocaleString()} mono />
            </div>

            {/* Risk limits */}
            <div className="grid grid-cols-3 gap-1.5 mt-2 pt-2 border-t border-white/5">
                <RiskStat label="Max" value={maxExposure} />
                <RiskStat label="Current" value={currentExposure} warn={currentExposure > maxExposure * 0.8} />
                <RiskStat label="Loss Lim" value={dailyLossLimit} />
            </div>

            {killSwitch && (
                <div className="mt-2 flex items-center gap-1.5 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20">
                    <AlertTriangle size={11} className="text-red-400 shrink-0" />
                    <span className="text-[10px] text-red-400">Kill switch — halted</span>
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
            <div className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</div>
            <div className={clsx('text-[12px] text-slate-200', mono && 'font-mono')}>{value}</div>
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
        <div className="rounded bg-white/[0.04] px-1.5 py-1 text-center">
            <div className="text-[8px] text-slate-500 uppercase tracking-wider">{label}</div>
            <div className={clsx('text-[11px] font-semibold font-mono', warn ? 'text-amber-400' : 'text-slate-200')}>
                {value.toLocaleString()}
            </div>
        </div>
    );
}
