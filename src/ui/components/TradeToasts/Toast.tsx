'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { TradeToastItem } from './toastModel';

interface ToastProps {
    toast: TradeToastItem;
    onClose: (id: string) => void;
    onPause: (id: string) => void;
    onResume: (id: string) => void;
}

export function Toast({ toast, onClose, onPause, onResume }: ToastProps) {
    const [entered, setEntered] = useState(false);

    useEffect(() => {
        const frame = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <div
            onMouseEnter={() => onPause(toast.id)}
            onMouseLeave={() => onResume(toast.id)}
            className={clsx(
                'pointer-events-auto w-[min(92vw,360px)] rounded-lg border border-white/10 bg-card/95 p-3 shadow-xl backdrop-blur',
                'transition-all duration-200',
                entered
                    ? 'opacity-100 translate-y-0 sm:translate-x-0'
                    : 'opacity-0 translate-y-3 sm:translate-y-0 sm:translate-x-6',
            )}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <h4 className="truncate text-sm font-semibold text-slate-100">{toast.title}</h4>
                        {toast.badge && (
                            <span className={clsx(
                                'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                                toast.badge === 'BUY' && 'bg-emerald-500/20 text-emerald-300',
                                toast.badge === 'SELL' && 'bg-red-500/20 text-red-300',
                                toast.badge === 'PROFIT' && 'bg-emerald-500/20 text-emerald-300',
                                toast.badge === 'LOSS' && 'bg-amber-500/20 text-amber-300',
                            )}>
                                {toast.badge}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-xs text-slate-300">{toast.message}</p>
                </div>
                <button
                    type="button"
                    className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                    onClick={() => onClose(toast.id)}
                    aria-label="Close toast"
                >
                    ×
                </button>
            </div>
        </div>
    );
}

export default Toast;

