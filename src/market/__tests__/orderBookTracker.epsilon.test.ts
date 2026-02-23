import { describe, expect, it, vi } from 'vitest';
import type { TradingPair } from '../../config';
import type { XRPLWebSocket } from '../../xrpl/client';
import { normalizeOrderBookSnapshot } from '../models';
import { OrderBookTracker } from '../orderBookTracker';
import { SnapshotValidator } from '../snapshotValidator';
import { BOOK_CROSS_EPS_ABS } from '../bookValidationEpsilon';
import { DEFAULT_HEALTH_CONFIG, scoreBookSignal } from '../marketDataHealth';

const TEST_PAIR: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
};

const NOW = 1_700_000_000_000;

function makeClient(bestBid: number, bestAsk: number): XRPLWebSocket {
    return {
        getOrderBook: vi.fn(async () => ({
            bids: [
                {
                    TakerGets: { value: String(bestBid) }, // quote amount
                    TakerPays: { value: '1' }, // base amount
                    quality: String(bestBid),
                },
            ],
            asks: [
                {
                    TakerGets: { value: '1' }, // base amount
                    TakerPays: { value: String(bestAsk) }, // quote amount
                    quality: String(bestAsk),
                },
            ],
        })),
    } as unknown as XRPLWebSocket;
}

describe('OrderBook epsilon handling', () => {
    it('clamps epsilon crossing spread to zero and preserves top levels in normalized snapshot', async () => {
        const bestAsk = 1;
        const bestBid = bestAsk + (BOOK_CROSS_EPS_ABS / 2);
        const tracker = new OrderBookTracker(makeClient(bestBid, bestAsk), TEST_PAIR);

        const refreshed = await tracker.refresh();
        expect(refreshed).toBe(true);

        const state = tracker.getState();
        expect(state.spread).toBe(0);
        expect(state.bids[0]?.price).toBeCloseTo(bestBid, 12);
        expect(state.asks[0]?.price).toBeCloseTo(bestAsk, 12);

        const snapshot = normalizeOrderBookSnapshot('XRP/RLUSD', state, NOW, 1);
        expect(snapshot.spreadBps).toBe(0);
        expect(snapshot.bestBid).toBeCloseTo(bestBid, 12);
        expect(snapshot.bestAsk).toBeCloseTo(bestAsk, 12);
    });

    it('keeps real crossed books detectable by validator and health scorer', async () => {
        const bestBid = 1.0001;
        const bestAsk = 1;
        const tracker = new OrderBookTracker(makeClient(bestBid, bestAsk), TEST_PAIR);

        const refreshed = await tracker.refresh();
        expect(refreshed).toBe(true);

        const state = tracker.getState();
        expect(state.spread).toBeLessThan(0);

        const snapshot = normalizeOrderBookSnapshot('XRP/RLUSD', state, NOW, 2);
        expect(snapshot.spreadBps).toBe(0);

        const validator = new SnapshotValidator();
        const validation = validator.validate(snapshot);
        expect(validation.valid).toBe(false);
        expect(validation.reasons.some((reason) => reason.includes('crossed-book'))).toBe(true);

        const bookSignal = scoreBookSignal({
            bestBid: snapshot.bestBid,
            bestAsk: snapshot.bestAsk,
            spreadBps: snapshot.spreadBps,
            bidDepthLevels: snapshot.bids.length,
            askDepthLevels: snapshot.asks.length,
            lastUpdatedMs: snapshot.eventTimeMs,
        }, NOW, DEFAULT_HEALTH_CONFIG);

        expect(bookSignal.score).toBe(0);
        expect(bookSignal.reasons).toContain('bid-not-less-than-ask');
    });

    it('returns false and preserves prior snapshot when refresh fails', async () => {
        const client = makeClient(1.1, 1.2);
        const tracker = new OrderBookTracker(client, TEST_PAIR);

        const firstOk = await tracker.refresh();
        expect(firstOk).toBe(true);
        const prev = tracker.getState();

        const failErr = new Error('book_offers failed');
        (client.getOrderBook as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failErr);

        const updateSpy = vi.fn();
        tracker.on('update', updateSpy);
        const secondOk = await tracker.refresh();
        expect(secondOk).toBe(false);
        expect(updateSpy).not.toHaveBeenCalled();

        const after = tracker.getState();
        expect(after.lastUpdated).toBe(prev.lastUpdated);
        expect(after.bids[0]?.price).toBeCloseTo(prev.bids[0]!.price, 12);
        expect(after.asks[0]?.price).toBeCloseTo(prev.asks[0]!.price, 12);
    });

    it('returns false when source ledger index is stalled beyond threshold', async () => {
        const OLD_ENV = process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS;
        process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS = '1000';
        vi.useFakeTimers();

        try {
            vi.setSystemTime(1_000);
            const client = {
                getOrderBook: vi.fn(async () => ({
                    bids: [
                        {
                            TakerGets: { value: '1.2' },
                            TakerPays: { value: '1' },
                            quality: '1.2',
                        },
                    ],
                    asks: [
                        {
                            TakerGets: { value: '1' },
                            TakerPays: { value: '1.3' },
                            quality: '1.3',
                        },
                    ],
                    sourceLedgerIndex: 500_000,
                })),
            } as unknown as XRPLWebSocket;
            const tracker = new OrderBookTracker(client, TEST_PAIR);

            expect(await tracker.refresh()).toBe(true);
            const first = tracker.getState();
            expect(first.sourceLedgerIndex).toBe(500_000);

            // Same source ledger for > threshold => considered stale response stream.
            vi.setSystemTime(2_500);
            expect(await tracker.refresh()).toBe(false);

            const after = tracker.getState();
            expect(after.lastUpdated).toBe(first.lastUpdated);
            expect(after.sourceLedgerIndex).toBe(500_000);
        } finally {
            vi.useRealTimers();
            if (OLD_ENV === undefined) {
                delete process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS;
            } else {
                process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS = OLD_ENV;
            }
        }
    });

    it('uses ORDERBOOK_STALE_MS when ORDERBOOK_SOURCE_LEDGER_STALE_MS is unset', async () => {
        const oldSourceStale = process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS;
        const oldBookStale = process.env.ORDERBOOK_STALE_MS;
        delete process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS;
        process.env.ORDERBOOK_STALE_MS = '1200';
        vi.useFakeTimers();

        try {
            vi.setSystemTime(1_000);
            const client = {
                getOrderBook: vi.fn(async () => ({
                    bids: [
                        {
                            TakerGets: { value: '1.2' },
                            TakerPays: { value: '1' },
                            quality: '1.2',
                        },
                    ],
                    asks: [
                        {
                            TakerGets: { value: '1' },
                            TakerPays: { value: '1.3' },
                            quality: '1.3',
                        },
                    ],
                    sourceLedgerIndex: 700_000,
                })),
            } as unknown as XRPLWebSocket;
            const tracker = new OrderBookTracker(client, TEST_PAIR);

            expect(await tracker.refresh()).toBe(true);

            vi.setSystemTime(2_100);
            expect(await tracker.refresh()).toBe(true);

            vi.setSystemTime(2_400);
            expect(await tracker.refresh()).toBe(false);
        } finally {
            vi.useRealTimers();
            if (oldSourceStale === undefined) {
                delete process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS;
            } else {
                process.env.ORDERBOOK_SOURCE_LEDGER_STALE_MS = oldSourceStale;
            }
            if (oldBookStale === undefined) {
                delete process.env.ORDERBOOK_STALE_MS;
            } else {
                process.env.ORDERBOOK_STALE_MS = oldBookStale;
            }
        }
    });
});
