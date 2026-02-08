'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ScrollText, Trash2, ArrowDown, RefreshCw } from 'lucide-react';
import { Panel, PanelAction, PanelBadge } from './Panel';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
    id: string;
    ts: number;
    level: LogLevel;
    message: string;
    source?: string;
    data?: Record<string, unknown>;
}

interface LogsResponse {
    logs: LogEntry[];
    counts: Record<LogLevel, number>;
    total: number;
}

interface LogsPanelProps {
    maxRows?: number;
    pollInterval?: number;
}

export function LogsPanel({ maxRows = 100, pollInterval = 2000 }: LogsPanelProps) {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [counts, setCounts] = useState<Record<LogLevel, number>>({
        trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0
    });
    const [autoScroll, setAutoScroll] = useState(true);
    const [filter, setFilter] = useState<'all' | 'warn' | 'error'>('all');
    const [isPolling, setIsPolling] = useState(true);
    const [lastFetch, setLastFetch] = useState<number>(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const lastLogIdRef = useRef<string | null>(null);

    // Fetch logs from API
    const fetchLogs = useCallback(async (since?: number) => {
        try {
            const params = new URLSearchParams({ limit: String(maxRows) });
            if (since) {
                params.set('since', String(since));
            }

            const res = await fetch(`/api/bot/logs?${params}`);
            if (!res.ok) return;

            const data: LogsResponse = await res.json();

            if (since && data.logs.length > 0) {
                // Incremental update - prepend new logs
                setLogs((prev) => {
                    const newLogs = data.logs.filter(
                        (log) => !prev.some((p) => p.id === log.id)
                    );
                    return [...newLogs, ...prev].slice(0, maxRows);
                });
            } else if (!since) {
                // Full fetch
                setLogs(data.logs);
            }

            setCounts(data.counts);
            setLastFetch(Date.now());

            if (data.logs.length > 0 && data.logs[0]) {
                lastLogIdRef.current = data.logs[0].id;
            }
        } catch (err) {
            console.error('Failed to fetch logs:', err);
        }
    }, [maxRows]);

    // Initial fetch
    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    // Polling for new logs
    useEffect(() => {
        if (!isPolling) return;

        const interval = setInterval(() => {
            // Fetch logs newer than our last fetch timestamp
            fetchLogs(lastFetch || undefined);
        }, pollInterval);

        return () => clearInterval(interval);
    }, [isPolling, pollInterval, lastFetch, fetchLogs]);

    const clearLogs = useCallback(() => {
        setLogs([]);
        lastLogIdRef.current = null;
    }, []);

    useEffect(() => {
        if (autoScroll && containerRef.current) {
            containerRef.current.scrollTop = 0;
        }
    }, [logs.length, autoScroll]);

    const filteredLogs = filter === 'all'
        ? logs
        : logs.filter((l) => {
            if (filter === 'error') return l.level === 'error' || l.level === 'fatal';
            if (filter === 'warn') return l.level === 'warn' || l.level === 'error' || l.level === 'fatal';
            return true;
        });

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });

    const levelColors: Record<LogLevel, string> = {
        trace: 'text-slate-600',
        debug: 'text-slate-500',
        info: 'text-sky-400',
        warn: 'text-amber-400',
        error: 'text-red-400',
        fatal: 'text-red-500',
    };

    const levelBg: Record<LogLevel, string> = {
        trace: 'bg-slate-500/5',
        debug: 'bg-slate-500/10',
        info: 'bg-sky-500/10',
        warn: 'bg-amber-500/10',
        error: 'bg-red-500/10',
        fatal: 'bg-red-500/20',
    };

    const errorCount = counts.error + counts.fatal;
    const warnCount = counts.warn;

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
                        icon={RefreshCw}
                        onClick={() => setIsPolling(!isPolling)}
                        label={isPolling ? 'Pause updates' : 'Resume updates'}
                        active={isPolling}
                    />
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
                className="h-full overflow-y-auto scrollbar-thin"
            >
                {filteredLogs.length === 0 ? (
                    <div className="text-center text-slate-500 text-[10px] py-4">
                        {isPolling ? 'Waiting for logs…' : 'No logs'}
                    </div>
                ) : (
                    filteredLogs.map((log) => (
                        <div
                            key={log.id}
                            className={clsx(
                                'flex items-start gap-1.5 px-2.5 py-1 border-b border-white/5 text-[11px]',
                                levelBg[log.level] || levelBg.info
                            )}
                        >
                            <span className="text-slate-500 font-mono text-[9px] shrink-0">
                                {formatTime(log.ts)}
                            </span>
                            <span className={clsx(
                                'font-semibold uppercase text-[9px] w-8 shrink-0',
                                levelColors[log.level] || levelColors.info
                            )}>
                                {log.level}
                            </span>
                            <span className="text-slate-300 break-all flex-1">{log.message}</span>
                            {log.source && (
                                <span className="text-slate-600 text-[9px] shrink-0">[{log.source}]</span>
                            )}
                        </div>
                    ))
                )}
            </div>
        </Panel>
    );
}
