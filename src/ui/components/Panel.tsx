'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { LucideIcon } from 'lucide-react';

export interface PanelActionProps {
    icon: LucideIcon;
    onClick: () => void;
    label: string;
    active?: boolean | undefined;
}

export interface PanelProps {
    title: string;
    icon?: LucideIcon;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
    bodyClassName?: string;
    /** If true, body uses flex-1 to fill available space */
    fillHeight?: boolean;
    /** Optional footer content */
    footer?: ReactNode;
    /** Compact mode reduces padding */
    compact?: boolean;
    /** Dense mode for tables - minimal header, tighter spacing */
    dense?: boolean;
    /** Enable internal scrolling in body */
    scrollable?: boolean;
    /** No padding in body - for charts/tables that need full bleed */
    noPadding?: boolean;
    /** Optional subtitle or secondary info */
    subtitle?: ReactNode;
}

export function Panel({
    title,
    icon: Icon,
    actions,
    children,
    className,
    bodyClassName,
    fillHeight = false,
    footer,
    compact = false,
    dense = false,
    scrollable = false,
    noPadding = false,
    subtitle,
}: PanelProps) {
    const effectivePadding = noPadding ? 'p-0' : dense ? 'px-2 py-1' : compact ? 'px-2.5 py-1.5' : 'px-3 py-2';
    const headerPadding = dense ? 'px-2 py-1' : compact ? 'px-2.5 py-1.5' : 'px-3 py-2';

    return (
        <div
            className={clsx(
                'flex flex-col rounded-lg bg-card/90 border border-white/[0.06]',
                fillHeight && 'h-full',
                'min-h-0 min-w-0',
                'overflow-hidden',
                className
            )}
        >
            {/* Header */}
            <div className={clsx(
                'flex items-center justify-between border-b border-white/[0.06] shrink-0',
                headerPadding
            )}>
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    {Icon && <Icon size={dense ? 12 : 13} className="text-slate-500 shrink-0" />}
                    <div className="min-w-0 flex-1">
                        <h3 className={clsx(
                            'font-semibold text-slate-300 truncate',
                            'text-[11px] uppercase tracking-wider'
                        )}>
                            {title}
                        </h3>
                        {subtitle && (
                            <div className="text-[10px] text-slate-500 truncate">{subtitle}</div>
                        )}
                    </div>
                </div>
                {actions && (
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                        {actions}
                    </div>
                )}
            </div>

            {/* Body */}
            <div
                className={clsx(
                    // Flex child sizing
                    fillHeight ? 'flex-1 min-h-0' : '',
                    // Scrolling behavior
                    scrollable ? 'overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent' : 'overflow-hidden',
                    // Padding
                    effectivePadding,
                    bodyClassName
                )}
            >
                {children}
            </div>

            {/* Footer */}
            {footer && (
                <div className={clsx(
                    'border-t border-white/[0.06] shrink-0',
                    dense ? 'px-2 py-1' : compact ? 'px-2.5 py-1.5' : 'px-3 py-2'
                )}>
                    {footer}
                </div>
            )}
        </div>
    );
}

/** Small badge for panel headers */
export function PanelBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'warning' }) {
    const toneMap = {
        neutral: 'bg-white/10 text-slate-300',
        success: 'bg-emerald-500/20 text-emerald-400',
        danger: 'bg-red-500/20 text-red-400',
        warning: 'bg-amber-500/20 text-amber-400',
    };
    return (
        <span className={clsx('px-1.5 py-0.5 text-[9px] font-semibold rounded', toneMap[tone])}>
            {children}
        </span>
    );
}

/** Icon button for panel actions */
export function PanelAction({
    icon: Icon,
    onClick,
    label,
    active,
}: PanelActionProps) {
    return (
        <button
            onClick={onClick}
            title={label}
            className={clsx(
                'p-1.5 rounded-lg transition-colors',
                active
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            )}
        >
            <Icon size={14} />
        </button>
    );
}
