import { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { ReactNode } from 'react';

export const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'warning' }) => {
    const toneMap: Record<typeof tone, string> = {
        neutral: 'bg-white/10 text-slate-200 border-white/10',
        success: 'bg-success/15 text-success border-success/20',
        danger: 'bg-danger/15 text-danger border-danger/20',
        warning: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    } as const;
    return <span className={clsx('px-2 py-1 text-[11px] rounded-full border', toneMap[tone])}>{children}</span>;
};

export const StatCard = ({ label, value, delta, positive }: { label: string; value: string; delta?: string; positive?: boolean }) => (
    <div className="card p-4 flex flex-col gap-2">
        <div className="stat-label">{label}</div>
        <div className="stat-value flex items-center gap-2">
            <span>{value}</span>
            {delta && <span className={clsx('text-sm', positive ? 'text-success' : 'text-danger')}>{delta}</span>}
        </div>
    </div>
);

export const Pill = ({ label, icon: Icon, tone = 'neutral' }: { label: string; icon: LucideIcon; tone?: 'neutral' | 'success' | 'danger' }) => (
    <div className={clsx('flex items-center gap-2 px-3 py-2 rounded-full border text-sm', {
        'border-white/10 text-slate-200 bg-white/5': tone === 'neutral',
        'border-success/30 text-success bg-success/10': tone === 'success',
        'border-danger/30 text-danger bg-danger/10': tone === 'danger',
    })}>
        <Icon size={16} />
        <span>{label}</span>
    </div>
);
