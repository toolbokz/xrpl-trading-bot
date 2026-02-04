'use client';

import { ReactNode, useState } from 'react';
import clsx from 'clsx';
import { BarChart3, BookOpen, Activity, Settings, ScrollText, Waves, TrendingUp } from 'lucide-react';

interface DashboardLayoutProps {
    header: ReactNode;
    /** Optional flow metrics sidebar (far left on desktop, drawer on mobile) */
    flowSidebar?: ReactNode;
    /** Optional analytics panel (below flow on desktop, separate tab on mobile) */
    analyticsSidebar?: ReactNode;
    /** Left column content (Order Book, Stats) */
    leftTop: ReactNode;
    leftBottom: ReactNode;
    /** Center column content (Chart, Controls) */
    centerTop: ReactNode;
    centerBottom: ReactNode;
    /** Right column content (Trade Tape, Logs) */
    rightTop: ReactNode;
    rightBottom: ReactNode;
}

// Mobile tab definitions
const TABS = [
    { id: 'chart', label: 'Chart', icon: BarChart3 },
    { id: 'orderbook', label: 'Book', icon: BookOpen },
    { id: 'trades', label: 'Trades', icon: Activity },
    { id: 'controls', label: 'Controls', icon: Settings },
    { id: 'logs', label: 'Logs', icon: ScrollText },
    { id: 'analytics', label: 'Stats', icon: TrendingUp },
] as const;

type TabId = typeof TABS[number]['id'];

export function DashboardLayout({
    header,
    flowSidebar,
    analyticsSidebar,
    leftTop,
    leftBottom,
    centerTop,
    centerBottom,
    rightTop,
    rightBottom,
}: DashboardLayoutProps) {
    const [activeTab, setActiveTab] = useState<TabId>('chart');
    const [flowOpen, setFlowOpen] = useState(false);

    return (
        <div className="h-[100dvh] w-full bg-gradient-to-br from-[#05080f] via-[#0b1221] to-[#090c14] text-slate-100 overflow-hidden">
            {/* Centered shell with margins */}
            <div className="max-w-[1600px] mx-auto h-full p-3 lg:p-5 flex flex-col">
                {/* Header - fixed height */}
                <header className="h-14 lg:h-16 shrink-0 mb-3 lg:mb-4">
                    {header}
                </header>

                {/* Desktop Grid Layout (lg+) */}
                <div className="hidden lg:grid flex-1 min-h-0 grid-cols-12 gap-4">
                    {flowSidebar ? (
                        <>
                            {/* Flow Sidebar (2 cols) */}
                            <aside className="col-span-2 flex flex-col gap-4 min-h-0">
                                <div className={analyticsSidebar ? 'flex-[1.2] min-h-0' : 'flex-1 min-h-0'}>
                                    {flowSidebar}
                                </div>
                                {analyticsSidebar && (
                                    <div className="flex-[0.8] min-h-0 overflow-hidden">
                                        {analyticsSidebar}
                                    </div>
                                )}
                            </aside>

                            {/* Main Content Area (10 cols) */}
                            <section className="col-span-10 grid grid-cols-12 gap-4 min-h-0">
                                {/* Left Column (3 cols) */}
                                <div className="col-span-3 flex flex-col gap-4 min-h-0">
                                    <div className="flex-[1.2] min-h-0">{leftTop}</div>
                                    <div className="flex-[0.8] min-h-0">{leftBottom}</div>
                                </div>

                                {/* Center Column (6 cols) */}
                                <div className="col-span-6 flex flex-col gap-4 min-h-0">
                                    <div className="flex-[1.4] min-h-0">{centerTop}</div>
                                    <div className="flex-[0.6] min-h-0">{centerBottom}</div>
                                </div>

                                {/* Right Column (3 cols) */}
                                <div className="col-span-3 flex flex-col gap-4 min-h-0">
                                    <div className="flex-[1.2] min-h-0">{rightTop}</div>
                                    <div className="flex-[0.8] min-h-0">{rightBottom}</div>
                                </div>
                            </section>
                        </>
                    ) : (
                        <>
                            {/* Left Column (3 cols) */}
                            <div className="col-span-3 flex flex-col gap-4 min-h-0">
                                <div className="flex-[1.2] min-h-0">{leftTop}</div>
                                <div className="flex-[0.8] min-h-0">{leftBottom}</div>
                            </div>

                            {/* Center Column (6 cols) */}
                            <div className="col-span-6 flex flex-col gap-4 min-h-0">
                                <div className="flex-[1.4] min-h-0">{centerTop}</div>
                                <div className="flex-[0.6] min-h-0">{centerBottom}</div>
                            </div>

                            {/* Right Column (3 cols) */}
                            <div className="col-span-3 flex flex-col gap-4 min-h-0">
                                <div className="flex-[1.2] min-h-0">{rightTop}</div>
                                <div className="flex-[0.8] min-h-0">{rightBottom}</div>
                            </div>
                        </>
                    )}
                </div>

                {/* Mobile/Tablet Tab Layout (below lg) */}
                <div className="flex lg:hidden flex-col flex-1 min-h-0">
                    {/* Flow toggle button (only if flowSidebar exists) */}
                    {flowSidebar && (
                        <button
                            onClick={() => setFlowOpen(true)}
                            className="self-end mb-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card/80 border border-white/10 text-slate-300 hover:text-white hover:bg-card transition-colors"
                        >
                            <Waves size={14} />
                            <span className="text-xs font-medium">Flow</span>
                        </button>
                    )}

                    {/* Tab content */}
                    <div className="flex-1 min-h-0 mb-3">
                        {activeTab === 'chart' && (
                            <div className="h-full flex flex-col gap-3">
                                <div className="flex-1 min-h-0">{centerTop}</div>
                            </div>
                        )}
                        {activeTab === 'orderbook' && (
                            <div className="h-full flex flex-col gap-3">
                                <div className="flex-1 min-h-0">{leftTop}</div>
                                <div className="h-32 shrink-0">{leftBottom}</div>
                            </div>
                        )}
                        {activeTab === 'trades' && (
                            <div className="h-full">{rightTop}</div>
                        )}
                        {activeTab === 'controls' && (
                            <div className="h-full overflow-y-auto">{centerBottom}</div>
                        )}
                        {activeTab === 'logs' && (
                            <div className="h-full">{rightBottom}</div>
                        )}
                        {activeTab === 'analytics' && analyticsSidebar && (
                            <div className="h-full overflow-y-auto">{analyticsSidebar}</div>
                        )}
                    </div>

                    {/* Tab bar */}
                    <nav className="shrink-0 flex items-center justify-around bg-card/80 backdrop-blur-sm rounded-2xl border border-white/5 p-1.5">
                        {TABS.map((tab) => {
                            const Icon = tab.icon;
                            const isActive = activeTab === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={clsx(
                                        'flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors min-w-[60px]',
                                        isActive
                                            ? 'bg-sky-500/20 text-sky-400'
                                            : 'text-slate-400 hover:text-slate-200'
                                    )}
                                >
                                    <Icon size={18} />
                                    <span className="text-[10px] font-medium">{tab.label}</span>
                                </button>
                            );
                        })}
                    </nav>
                </div>
            </div>

            {/* Mobile Flow Drawer Overlay */}
            {flowSidebar && flowOpen && (
                <div className="lg:hidden fixed inset-0 z-50">
                    <button
                        className="absolute inset-0 bg-black/50"
                        onClick={() => setFlowOpen(false)}
                        aria-label="Close flow overlay"
                    />
                    <div className="absolute left-0 top-0 bottom-0 w-[280px] p-3 bg-[#0b1221] border-r border-white/10 flex flex-col">
                        <div className="flex items-center justify-between mb-2">
                            <div className="text-sm font-semibold text-slate-200">Flow Metrics</div>
                            <button
                                onClick={() => setFlowOpen(false)}
                                className="text-slate-400 hover:text-white transition-colors"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="flex-1 min-h-0 overflow-hidden">
                            {flowSidebar}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
