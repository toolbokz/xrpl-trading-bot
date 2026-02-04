'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { Activity, Play, Pause, AlertTriangle, Wifi, WifiOff } from 'lucide-react';

interface TerminalHeaderProps {
    /** Pair selector element */
    pairSelector: ReactNode;
    /** Bot status */
    status: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';
    /** Paper trading mode */
    paper: boolean;
    /** Network type */
    network: 'MAINNET' | 'TESTNET';
    /** XRPL connection status */
    connected: boolean;
    /** Loading state for actions */
    loading: boolean;
    /** Action handlers */
    onRun: () => void;
    onPause: () => void;
    onKill: () => void;
    /** Optional status message */
    message?: string;
}

export function TerminalHeader({
    pairSelector,
    status,
    paper,
    network,
    connected,
    loading,
    onRun,
    onPause,
    onKill,
    message,
}: TerminalHeaderProps) {
    const statusColors = {
        RUNNING: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]',
        PAUSED: 'bg-slate-500',
        STOPPED: 'bg-slate-600',
        ERROR: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]',
    };

    return (
        <div className="h-full flex items-center justify-between gap-4 px-4 bg-card/80 backdrop-blur-sm rounded-2xl border border-white/5">
            {/* Left: Logo + Status */}
            <div className="flex items-center gap-4 min-w-0">
                {/* Logo/Brand */}
                <div className="flex items-center gap-3 shrink-0">
                    <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-sky-500/20 to-indigo-500/20 border border-white/10 flex items-center justify-center">
                        <Activity size={18} className="text-sky-400" />
                    </div>
                    <div className="hidden sm:block">
                        <div className="text-xs text-slate-500 uppercase tracking-wider leading-none">XRPL</div>
                        <div className="text-sm font-semibold text-slate-100 leading-tight">Trading Bot</div>
                    </div>
                </div>

                {/* Connection indicator */}
                <div className={clsx(
                    'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs',
                    connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                )}>
                    {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
                    <span className="hidden md:inline">{connected ? 'Connected' : 'Disconnected'}</span>
                </div>

                {/* Status dot */}
                <div className="flex items-center gap-2">
                    <div className={clsx('w-2.5 h-2.5 rounded-full animate-pulse', statusColors[status])} />
                    <span className="text-xs text-slate-400 hidden md:inline">{status}</span>
                </div>
            </div>

            {/* Center: Pair Selector */}
            <div className="flex-1 max-w-md min-w-0">
                {pairSelector}
            </div>

            {/* Right: Controls + Badges */}
            <div className="flex items-center gap-3 shrink-0">
                {/* Network badge */}
                <span className={clsx(
                    'px-2 py-1 text-[10px] font-bold rounded-full hidden sm:inline-block',
                    network === 'MAINNET'
                        ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                        : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                )}>
                    {network}
                </span>

                {/* Paper/Live badge */}
                <span className={clsx(
                    'px-2 py-1 text-[10px] font-bold rounded-full',
                    paper
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                )}>
                    {paper ? 'PAPER' : 'LIVE'}
                </span>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={onRun}
                        disabled={loading || status === 'RUNNING'}
                        className={clsx(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                            status === 'RUNNING'
                                ? 'bg-emerald-500/10 text-emerald-500/50 cursor-not-allowed'
                                : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
                        )}
                    >
                        <Play size={12} />
                        <span className="hidden md:inline">Run</span>
                    </button>
                    <button
                        onClick={onPause}
                        disabled={loading || status !== 'RUNNING'}
                        className={clsx(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                            status !== 'RUNNING'
                                ? 'bg-white/5 text-slate-500 cursor-not-allowed'
                                : 'bg-white/10 text-slate-200 hover:bg-white/15 border border-white/10'
                        )}
                    >
                        <Pause size={12} />
                        <span className="hidden md:inline">Pause</span>
                    </button>
                    <button
                        onClick={onKill}
                        disabled={loading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/25 transition-all"
                    >
                        <AlertTriangle size={12} />
                        <span className="hidden md:inline">Kill</span>
                    </button>
                </div>

                {/* Status message */}
                {message && (
                    <span className="text-[10px] text-slate-500 max-w-[120px] truncate hidden lg:inline">
                        {message}
                    </span>
                )}
            </div>
        </div>
    );
}
