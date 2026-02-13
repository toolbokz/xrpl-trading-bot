'use client';

import React from 'react';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import type { ObservabilityEvent } from '../../../observability/eventBus';

export interface RuntimeEventsResponse {
    seq: number;
    count: number;
    events: ObservabilityEvent[];
    summary: Record<string, number>;
}

export interface UseRuntimeEventsOptions {
    pollInterval?: number;
    enabled?: boolean;
}

export interface UseRuntimeEventsState {
    data: RuntimeEventsResponse | null;
    loading: boolean;
    error: string | null;
}

const RuntimeEventsContext = createContext<UseRuntimeEventsState | null>(null);

export function useRuntimeEvents(options: UseRuntimeEventsOptions = {}): UseRuntimeEventsState {
    const ctx = useContext(RuntimeEventsContext);
    const local = useRuntimeEventsPolling({
        ...options,
        enabled: (options.enabled ?? true) && !ctx,
    });
    return ctx ?? local;
}

export function RuntimeEventsProvider({
    children,
    pollInterval = 1200,
    enabled = true,
}: {
    children: ReactNode;
    pollInterval?: number;
    enabled?: boolean;
}) {
    const state = useRuntimeEventsPolling({ pollInterval, enabled });
    return <RuntimeEventsContext.Provider value={state}>{children}</RuntimeEventsContext.Provider>;
}

function useRuntimeEventsPolling({
    pollInterval = 1200,
    enabled = true,
}: UseRuntimeEventsOptions): UseRuntimeEventsState {
    const [data, setData] = useState<RuntimeEventsResponse | null>(null);
    const [loading, setLoading] = useState<boolean>(enabled);
    const [error, setError] = useState<string | null>(null);

    const lastSeqRef = useRef<number | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    const poll = useCallback(async () => {
        if (!enabled) {
            setLoading(false);
            return;
        }

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const afterSeq = lastSeqRef.current;
            const query = afterSeq == null
                ? '/api/runtime/events?limit=1'
                : `/api/runtime/events?afterSeq=${afterSeq}&limit=100`;
            const res = await fetch(query, {
                method: 'GET',
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const payload = await res.json() as Partial<RuntimeEventsResponse>;
            const nextSeq = typeof payload.seq === 'number' && Number.isFinite(payload.seq)
                ? payload.seq
                : (afterSeq ?? 0);
            const isBootstrap = afterSeq == null;
            const nextEvents = isBootstrap
                ? []
                : (Array.isArray(payload.events) ? payload.events as ObservabilityEvent[] : []);

            setData({
                seq: nextSeq,
                count: nextEvents.length,
                events: nextEvents,
                summary: payload.summary && typeof payload.summary === 'object'
                    ? payload.summary as Record<string, number>
                    : {},
            });
            lastSeqRef.current = nextSeq;
            setError(null);
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            setError(err instanceof Error ? err.message : 'Failed to poll runtime events');
        } finally {
            setLoading(false);
        }
    }, [enabled]);

    useEffect(() => {
        void poll();
        if (!enabled) return () => undefined;

        const interval = setInterval(() => {
            void poll();
        }, Math.max(500, pollInterval));

        return () => {
            clearInterval(interval);
            abortRef.current?.abort();
        };
    }, [poll, pollInterval, enabled]);

    return useMemo(() => ({ data, loading, error }), [data, loading, error]);
}
