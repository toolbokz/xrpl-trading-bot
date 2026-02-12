'use client';

import type { TradeToastEvent } from '../../../observability/tradeToastEvents';

export type ToastBadge = 'BUY' | 'SELL' | 'PROFIT' | 'LOSS' | undefined;

export interface TradeToastItem {
    id: string;
    title: string;
    message: string;
    badge?: ToastBadge;
    event: TradeToastEvent;
    expiresAtMs: number;
    remainingMs: number;
    paused: boolean;
}

export interface TradeToastState {
    visible: TradeToastItem[];
    queued: TradeToastItem[];
}

export const MAX_VISIBLE_TOASTS = 50;
export const AUTO_DISMISS_MS = Number.POSITIVE_INFINITY;

export function formatTradeToast(event: TradeToastEvent): Omit<TradeToastItem, 'id' | 'expiresAtMs' | 'remainingMs' | 'paused'> {
    if (event.type === 'ORDER_PLACED') {
        if (event.side === 'SELL') {
            return {
                title: 'Sell order placed',
                message: `You just sold ${fmt(event.baseAmount)} ${event.baseCurrency} for ${fmt(event.quoteAmount)} ${event.quoteCurrency} (${event.pair}).`,
                badge: 'SELL',
                event,
            };
        }
        return {
            title: 'Buy order placed',
            message: `You just bought ${fmt(event.baseAmount)} ${event.baseCurrency} for ${fmt(event.quoteAmount)} ${event.quoteCurrency} (${event.pair}).`,
            badge: 'BUY',
            event,
        };
    }

    if (typeof event.pnlQuote === 'number') {
        if (event.pnlQuote > 0) {
            return {
                title: 'Filled ✅',
                message: `Congratulations — you just profited ${fmt(event.pnlQuote)} ${event.quoteCurrency} on ${event.pair}.`,
                badge: 'PROFIT',
                event,
            };
        }
        if (event.pnlQuote < 0) {
            return {
                title: 'Filled ⚠️',
                message: `You just lost ${fmt(Math.abs(event.pnlQuote))} ${event.quoteCurrency} on ${event.pair}.`,
                badge: 'LOSS',
                event,
            };
        }
    }

    return {
        title: 'Filled',
        message: `Order filled on ${event.pair}.`,
        event,
    };
}

export function enqueueToast(state: TradeToastState, toast: TradeToastItem): TradeToastState {
    if (state.visible.length < MAX_VISIBLE_TOASTS) {
        return {
            visible: [toast, ...state.visible],
            queued: state.queued,
        };
    }
    return {
        visible: state.visible,
        queued: [...state.queued, toast],
    };
}

export function dismissToast(state: TradeToastState, id: string, nowMs: number): TradeToastState {
    const visible = state.visible.filter((t) => t.id !== id);
    if (visible.length === state.visible.length) return state;

    if (state.queued.length > 0) {
        const [next, ...rest] = state.queued;
        return {
            visible: [withNewExpiry(next!, nowMs), ...visible],
            queued: rest,
        };
    }
    return { visible, queued: state.queued };
}

export function pauseToast(state: TradeToastState, id: string, nowMs: number): TradeToastState {
    return {
        ...state,
        visible: state.visible.map((toast) => {
            if (toast.id !== id || toast.paused) return toast;
            return {
                ...toast,
                paused: true,
                remainingMs: Math.max(0, toast.expiresAtMs - nowMs),
            };
        }),
    };
}

export function resumeToast(state: TradeToastState, id: string, nowMs: number): TradeToastState {
    return {
        ...state,
        visible: state.visible.map((toast) => {
            if (toast.id !== id || !toast.paused) return toast;
            return {
                ...toast,
                paused: false,
                expiresAtMs: nowMs + Math.max(0, toast.remainingMs),
            };
        }),
    };
}

export function sweepExpired(state: TradeToastState, nowMs: number): TradeToastState {
    let nextState = state;
    for (const toast of state.visible) {
        if (!toast.paused && Number.isFinite(toast.expiresAtMs) && toast.expiresAtMs <= nowMs) {
            nextState = dismissToast(nextState, toast.id, nowMs);
        }
    }
    return nextState;
}

export function newToastItem(event: TradeToastEvent, nowMs: number): TradeToastItem {
    const formatted = formatTradeToast(event);
    return {
        id: `${event.type}-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
        ...formatted,
        expiresAtMs: nowMs + AUTO_DISMISS_MS,
        remainingMs: AUTO_DISMISS_MS,
        paused: false,
    };
}

function withNewExpiry(toast: TradeToastItem, nowMs: number): TradeToastItem {
    return {
        ...toast,
        paused: false,
        remainingMs: AUTO_DISMISS_MS,
        expiresAtMs: nowMs + AUTO_DISMISS_MS,
    };
}

function fmt(value: number | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const s = value.toFixed(6);
    return s.replace(/\.?0+$/, '');
}
