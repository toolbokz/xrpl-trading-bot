import type { TradeToastEvent } from '../../observability/tradeToastEvents';

type TradeToastHandler = (event: TradeToastEvent) => void;

const handlers = new Set<TradeToastHandler>();

export function emitTradeToast(event: TradeToastEvent): void {
    if (handlers.size === 0) return;
    for (const handler of handlers) {
        try {
            handler(event);
        } catch {
            // no-op; bus must never throw
        }
    }
}

export function subscribeTradeToasts(handler: TradeToastHandler): () => void {
    handlers.add(handler);
    return () => {
        handlers.delete(handler);
    };
}

