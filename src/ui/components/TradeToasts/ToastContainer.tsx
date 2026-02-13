'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ObservabilityEvent } from '../../../observability/eventBus';
import type { TradeToastEvent } from '../../../observability/tradeToastEvents';
import { emitTradeToast, subscribeTradeToasts } from '../../services/tradeToastBus';
import type { RuntimeEventsResponse } from '../../lib/hooks/useRuntimeEvents';
import {
    dismissToast,
    enqueueToast,
    newToastItem,
    pauseToast,
    resumeToast,
    sweepExpired,
    type TradeToastState,
} from './toastModel';
import { Toast } from './Toast';

interface ToastContainerProps {
    enabled?: boolean;
    runtimeEvents?: RuntimeEventsResponse | null;
}

const EMPTY_STATE: TradeToastState = { visible: [], queued: [] };

export function ToastContainer({ enabled = false, runtimeEvents = null }: ToastContainerProps) {
    const [state, setState] = useState<TradeToastState>(EMPTY_STATE);

    useEffect(() => {
        if (!enabled) return;
        const unsubscribe = subscribeTradeToasts((event) => {
            setState((prev) => enqueueToast(prev, newToastItem(event, Date.now())));
        });
        return unsubscribe;
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;
        const interval = setInterval(() => {
            setState((prev) => sweepExpired(prev, Date.now()));
        }, 200);
        return () => clearInterval(interval);
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;
        const events = runtimeEvents?.events;
        if (!Array.isArray(events) || events.length === 0) return;
        for (const event of events as ObservabilityEvent[]) {
            const mapped = mapRuntimeEventToToast(event);
            if (mapped) emitTradeToast(mapped);
        }
    }, [enabled, runtimeEvents?.seq, runtimeEvents?.events]);

    const visible = useMemo(() => state.visible, [state.visible]);
    if (!enabled || visible.length === 0) return null;

    return (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex w-full -translate-x-1/2 flex-col items-center gap-2 px-3 sm:left-auto sm:right-4 sm:w-auto sm:translate-x-0 sm:items-end">
            {visible.map((toast) => (
                <Toast
                    key={toast.id}
                    toast={toast}
                    onClose={(id) => setState((prev) => dismissToast(prev, id, Date.now()))}
                    onPause={(id) => setState((prev) => pauseToast(prev, id, Date.now()))}
                    onResume={(id) => setState((prev) => resumeToast(prev, id, Date.now()))}
                />
            ))}
        </div>
    );
}

function mapRuntimeEventToToast(event: ObservabilityEvent): TradeToastEvent | null {
    if (event.eventType !== 'ORDER_PLACED' && event.eventType !== 'ORDER_FILLED') {
        return null;
    }
    const detail = event.detail as Partial<TradeToastEvent> | undefined;
    if (!detail) return null;
    if (!detail.pair || !detail.baseCurrency || !detail.quoteCurrency) return null;
    return {
        type: event.eventType,
        side: detail.side,
        pair: detail.pair,
        baseCurrency: detail.baseCurrency,
        quoteCurrency: detail.quoteCurrency,
        baseAmount: detail.baseAmount,
        quoteAmount: detail.quoteAmount,
        price: detail.price,
        feeQuote: detail.feeQuote,
        pnlQuote: detail.pnlQuote,
        timestamp: detail.timestamp || new Date(event.timestampMs).toISOString(),
    };
}

export default ToastContainer;
