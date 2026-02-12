import { describe, expect, it } from 'vitest';
import type { TradeToastEvent } from '../../../../observability/tradeToastEvents';
import {
    AUTO_DISMISS_MS,
    dismissToast,
    enqueueToast,
    formatTradeToast,
    newToastItem,
    pauseToast,
    resumeToast,
    sweepExpired,
    type TradeToastState,
} from '../toastModel';

const baseEvent: TradeToastEvent = {
    type: 'ORDER_PLACED',
    side: 'BUY',
    pair: 'XRP/RLUSD',
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    baseAmount: 100,
    quoteAmount: 52,
    price: 0.52,
    timestamp: '2026-01-01T00:00:00.000Z',
};

describe('toastModel format mapping', () => {
    it('formats BUY/SELL/FILLED PROFIT/FILLED LOSS messages', () => {
        expect(formatTradeToast(baseEvent).title).toBe('Buy order placed');
        expect(formatTradeToast(baseEvent).message).toBe('You just bought 100 XRP for 52 RLUSD (XRP/RLUSD).');

        const sell = { ...baseEvent, side: 'SELL' as const };
        expect(formatTradeToast(sell).title).toBe('Sell order placed');
        expect(formatTradeToast(sell).message).toBe('You just sold 100 XRP for 52 RLUSD (XRP/RLUSD).');

        const profit: TradeToastEvent = { ...baseEvent, type: 'ORDER_FILLED', pnlQuote: 5.25 };
        expect(formatTradeToast(profit).title).toBe('Filled ✅');
        expect(formatTradeToast(profit).message).toBe('Congratulations — you just profited 5.25 RLUSD on XRP/RLUSD.');

        const loss: TradeToastEvent = { ...baseEvent, type: 'ORDER_FILLED', pnlQuote: -2.5 };
        expect(formatTradeToast(loss).title).toBe('Filled ⚠️');
        expect(formatTradeToast(loss).message).toBe('You just lost 2.5 RLUSD on XRP/RLUSD.');
    });
});

describe('toastModel dismiss and timers', () => {
    it('does not auto-dismiss and supports manual dismiss', () => {
        const now = 1_000;
        let state: TradeToastState = { visible: [], queued: [] };
        const t1 = newToastItem(baseEvent, now);
        state = enqueueToast(state, t1);
        expect(state.visible).toHaveLength(1);

        state = sweepExpired(state, now + AUTO_DISMISS_MS + 1);
        expect(state.visible).toHaveLength(1);

        const t2 = newToastItem(baseEvent, now);
        state = enqueueToast(state, t2);
        state = dismissToast(state, t2.id, now + 100);
        expect(state.visible).toHaveLength(1);
    });

    it('pauses and resumes toast timer on hover', () => {
        const now = 5_000;
        let state: TradeToastState = { visible: [newToastItem(baseEvent, now)], queued: [] };
        const id = state.visible[0]!.id;

        state = pauseToast(state, id, now + 1_000);
        expect(state.visible[0]!.paused).toBe(true);

        state = sweepExpired(state, now + AUTO_DISMISS_MS + 100);
        expect(state.visible).toHaveLength(1);

        state = resumeToast(state, id, now + AUTO_DISMISS_MS + 200);
        expect(state.visible[0]!.paused).toBe(false);
    });
});

describe('toastModel queue max visible', () => {
    it('shows newest toast on top', () => {
        const now = 1_000;
        let state: TradeToastState = { visible: [], queued: [] };
        const items = Array.from({ length: 3 }, (_, idx) =>
            newToastItem({ ...baseEvent, timestamp: `2026-01-01T00:00:0${idx}.000Z` }, now + idx + 1),
        );

        for (const item of items) {
            state = enqueueToast(state, item);
        }

        expect(state.visible).toHaveLength(3);
        expect(state.visible[0]!.id).toBe(items[2]!.id);
        expect(state.visible[1]!.id).toBe(items[1]!.id);
        expect(state.visible[2]!.id).toBe(items[0]!.id);
    });
});
