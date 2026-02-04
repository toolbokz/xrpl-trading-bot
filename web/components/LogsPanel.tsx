'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ScrollText, Trash2, ArrowDown } from 'lucide-react';
import { Panel, PanelAction, PanelBadge } from './Panel';

interface LogEntry {
    id: string;
    ts: number;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    source?: string;
}

interface LogsPanelProps {
    maxRows?: number;
}

export function LogsPanel({ maxRows = 100 }: LogsPanelProps) {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [autoScroll, setAutoScroll] = useState(true);
    const [filter, setFilter] = useState<'all' | 'warn' | 'error'>('all');
    const containerRef = useRef<HTMLDivElement>(null);

    // Mock some initial logs - in production, connect to backend log stream
    useEffect(() => {
        const mockLogs: LogEntry[] = [
            { id: '1', ts: Date.now() - 5000, level: 'info', message: 'Bot initialized', source: 'runtime' },
            { id: '2', ts: Date.now() - 4000, level: 'info', message: 'Connected to XRPL', source: 'xrpl' },
            { id: '3', ts: Date.now() - 3000, level: 'debug', message: 'Order book subscribed', source: 'market' },
        ];
        setLogs(mockLogs);
    }, []);

    const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'ts'>) => {
        setLogs((prev) => [
            { ...entry, id: crypto.randomUUID(), ts: Date.now() },
            ...prev,
        ].slice(0, maxRows));
    }, [maxRows]);

    const clearLogs = useCallback(() => {
        setLogs([]);
    }, []);

    useEffect(() => {
        if (autoScroll && containerRef.current) {
            containerRef.current.scrollTop = 0;
        }
    }, [logs.length, autoScroll]);

    const filteredLogs = filter === 'all'
        ? logs
        : logs.filter((l) => l.level === filter || (filter === 'warn' && l.level === 'error'));

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });

    const levelColors = {
        info: 'text-sky-400',
        warn: 'text-amber-400',
        error: 'text-red-400',
        debug: 'text-slate-500',
    };

    const levelBg = {
        info: 'bg-sky-500/10',
        warn: 'bg-amber-500/10',
        error: 'bg-red-500/10',
        debug: 'bg-slate-500/10',
    };

    const errorCount = logs.filter((l) => l.level === 'error').length;
    const warnCount = logs.filter((l) => l.level === 'warn').length;

    return (
        <Panel
            title="Bot Logs"
            icon={ScrollText}
            fillHeight
            compact
            actions={
                <>
                    {errorCount > 0 && <PanelBadge tone="danger">{errorCount} errors</PanelBadge>}
                    {warnCount > 0 && <PanelBadge tone="warning">{warnCount} warns</PanelBadge>}
                    <div className="flex rounded-md bg-white/5 p-0.5">
                        {(['all', 'warn', 'error'] as const).map((f) => (
                            <button
                                key={f}
                                onClick={() => setFilter(f)}
                                className={clsx(
                                    'px-2 py-0.5 text-[10px] rounded capitalize transition-colors',
                                    filter === f
                                        ? 'bg-sky-500/30 text-sky-300'
                                        : 'text-slate-500 hover:text-slate-300'
                                )}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                    <PanelAction
                        icon={ArrowDown}
                        onClick={() => setAutoScroll(!autoScroll)}
                        label="Auto-scroll"
                        active={autoScroll}
                    />
                    <PanelAction
                        icon={Trash2}
                        onClick={clearLogs}
                        label="Clear logs"
                    />
                </>
            }
            bodyClassName="p-0"
        >
            <div
                ref={containerRef}
                className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
            >
                {filteredLogs.length === 0 ? (
                    <div className="text-center text-slate-500 text-xs py-8">No logs</div>
                ) : (
                    filteredLogs.map((log) => (
                        <div
                            key={log.id}
                            className={clsx(
                                'flex items-start gap-2 px-3 py-1.5 border-b border-white/5 text-xs',
                                levelBg[log.level]
                            )}
                        >
                            <span className="text-slate-500 font-mono text-[10px] shrink-0">
                                {formatTime(log.ts)}
                            </span>
                            <span className={clsx('font-semibold uppercase text-[10px] w-10 shrink-0', levelColors[log.level])}>
                                {log.level}
                            </span>
                            <span className="text-slate-300 break-all flex-1">{log.message}</span>
                            {log.source && (
                                <span className="text-slate-600 text-[10px] shrink-0">[{log.source}]</span>
                            )}
                        </div>
                    ))
                )}
            </div>
        </Panel>
    );
}
