'use client';

import clsx from 'clsx';
import { Activity, Play, Pause, Square, Wifi, WifiOff } from 'lucide-react';

interface TerminalHeaderProps {
    status: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';
    paper: boolean;
    network: 'MAINNET' | 'TESTNET';
    connected: boolean;
    loading: boolean;
    onRun: () => void;
    onPause: () => void;
    onKill: () => void;
    message?: string;
}

export function TerminalHeader({
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
    const dotColor = {
        RUNNING: 'bg-emerald-400',
        PAUSED: 'bg-amber-400',
        STOPPED: 'bg-slate-500',
        ERROR: 'bg-red-400',
    }[status];

    return (
        <div className="h-full flex items-center justify-between gap-3 px-2">
            {/* ── Left: brand + connection ── */}
            <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-2 shrink-0">
                    <Activity size={14} className="text-sky-400" />
                    <span className="text-xs font-semibold text-slate-200 hidden sm:inline">XRPL Bot</span>
                </div>

                <div className={clsx(
                    'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]',
                    connected ? 'text-emerald-400' : 'text-red-400'
                )}>
                    {connected ? <Wifi size={10} /> : <WifiOff size={10} />}
                    <span className="hidden md:inline">{connected ? 'Connected' : 'Offline'}</span>
                </div>
            </div>

            {/* ── Center: status indicator ── */}
            <div className="flex items-center gap-1.5">
                <div className={clsx('w-1.5 h-1.5 rounded-full', dotColor, status === 'RUNNING' && 'animate-pulse')} />
                <span className="text-[10px] font-semibold text-slate-400 tracking-wider">{status}</span>
            </div>

            {/* ── Right: env badges + action buttons ── */}
            <div className="flex items-center gap-2 shrink-0">
                <span className={clsx(
                    'px-1.5 py-0.5 text-[9px] font-bold rounded hidden sm:inline-block tracking-wide',
                    network === 'MAINNET'
                        ? 'bg-red-500/15 text-red-400 border border-red-500/20'
                        : 'bg-slate-500/15 text-slate-400 border border-slate-500/20'
                )}>
                    {network}
                </span>
                <span className={clsx(
                    'px-1.5 py-0.5 text-[9px] font-bold rounded tracking-wide',
                    paper
                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20'
                        : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                )}>
                    {paper ? 'PAPER' : 'LIVE'}
                </span>

                <div className="flex items-center gap-1 ml-1">
                    <button
                        onClick={onRun}
                        disabled={loading || status === 'RUNNING'}
                        className={clsx(
                            'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors',
                            status === 'RUNNING'
                                ? 'text-emerald-500/40 cursor-not-allowed'
                                : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/25'
                        )}
                    >
                        <Play size={9} /> Run
                    </button>
                    <button
                        onClick={onPause}
                        disabled={loading || status !== 'RUNNING'}
                        className={clsx(
                            'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors',
                            status !== 'RUNNING'
                                ? 'text-slate-600 cursor-not-allowed'
                                : 'bg-white/8 text-slate-300 hover:bg-white/12 border border-white/10'
                        )}
                    >
                        <Pause size={9} /> Pause
                    </button>
                    <button
                        onClick={onKill}
                        disabled={loading}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors"
                    >
                        <Square size={9} /> Kill
                    </button>
                </div>

                {message && (
                    <span className="text-[9px] text-slate-500 max-w-[100px] truncate hidden lg:inline">
                        {message}
                    </span>
                )}
            </div>
        </div>
    );
}
