'use client';

import { ReactNode, useState } from 'react';
import clsx from 'clsx';
import {
    BarChart3,
    BookOpen,
    Sliders,
    Activity,
    Shield,
    ChevronDown,
    ChevronUp,
    LucideIcon,
} from 'lucide-react';

type MobileTab = 'overview' | 'market' | 'trading' | 'analytics' | 'governance';

interface TabConfig {
    id: MobileTab;
    label: string;
    icon: LucideIcon;
}

const TABS: TabConfig[] = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'market', label: 'Market', icon: BookOpen },
    { id: 'trading', label: 'Trading', icon: Activity },
    { id: 'analytics', label: 'Analytics', icon: Sliders },
    { id: 'governance', label: 'Governance', icon: Shield },
];

interface MobileDashboardProps {
    /** Header component (compact version of TerminalHeader) */
    header: ReactNode;
    /** Content for each tab */
    overviewContent: ReactNode;
    marketContent: ReactNode;
    tradingContent: ReactNode;
    analyticsContent: ReactNode;
    governanceContent: ReactNode;
    /** Optional flow metrics drawer content */
    flowMetrics?: ReactNode;
}

/**
 * MobileDashboard - Tab-based mobile layout for trading dashboard.
 * 
 * Features:
 * - 5 swipeable/tappable tabs
 * - Collapsible flow metrics drawer at top
 * - Vertical scrolling within each tab
 * - Fixed header and tab bar
 */
export function MobileDashboard({
    header,
    overviewContent,
    marketContent,
    tradingContent,
    analyticsContent,
    governanceContent,
    flowMetrics,
}: MobileDashboardProps) {
    const [activeTab, setActiveTab] = useState<MobileTab>('overview');
    const [flowExpanded, setFlowExpanded] = useState(false);

    const contentMap: Record<MobileTab, ReactNode> = {
        overview: overviewContent,
        market: marketContent,
        trading: tradingContent,
        analytics: analyticsContent,
        governance: governanceContent,
    };

    return (
        <div className="h-screen w-screen flex flex-col bg-surface overflow-hidden">
            {/* Compact header */}
            <header className="h-14 shrink-0 px-2 py-1.5">
                {header}
            </header>

            {/* Collapsible flow metrics drawer */}
            {flowMetrics && (
                <div className="shrink-0 border-b border-white/5">
                    <button
                        onClick={() => setFlowExpanded(!flowExpanded)}
                        className="w-full flex items-center justify-between px-4 py-2 text-xs text-slate-400 hover:text-slate-300 transition-colors"
                    >
                        <span className="flex items-center gap-2">
                            <Activity size={12} />
                            Flow Metrics
                        </span>
                        {flowExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                    <div
                        className={clsx(
                            'overflow-hidden transition-all duration-200 ease-in-out',
                            flowExpanded ? 'max-h-48' : 'max-h-0'
                        )}
                    >
                        <div className="px-3 pb-3">
                            {flowMetrics}
                        </div>
                    </div>
                </div>
            )}

            {/* Main content area - scrollable */}
            <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-3">
                <div className="space-y-3">
                    {contentMap[activeTab]}
                </div>
            </main>

            {/* Bottom tab bar */}
            <nav className="h-14 shrink-0 bg-card/95 backdrop-blur-sm border-t border-white/10 safe-area-inset-bottom">
                <div className="h-full flex items-center justify-around">
                    {TABS.map((tab) => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={clsx(
                                    'flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors min-w-0 flex-1',
                                    isActive
                                        ? 'text-sky-400'
                                        : 'text-slate-500 hover:text-slate-300'
                                )}
                            >
                                <Icon
                                    size={18}
                                    className={clsx(
                                        'transition-colors',
                                        isActive && 'drop-shadow-[0_0_8px_rgba(56,189,248,0.5)]'
                                    )}
                                />
                                <span className="text-[10px] font-medium truncate">
                                    {tab.label}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </nav>
        </div>
    );
}

/**
 * MobileSection - Wrapper for content within a mobile tab.
 * Provides consistent spacing and optional title.
 */
interface MobileSectionProps {
    title?: string;
    children: ReactNode;
    className?: string;
}

export function MobileSection({ title, children, className }: MobileSectionProps) {
    return (
        <div className={clsx('space-y-2', className)}>
            {title && (
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-1">
                    {title}
                </h3>
            )}
            {children}
        </div>
    );
}

export default MobileDashboard;
