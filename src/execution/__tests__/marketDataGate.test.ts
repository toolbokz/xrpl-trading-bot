import { describe, expect, it } from 'vitest';
import { assertMarketDataReady } from '../marketDataGate';

describe('marketDataGate', () => {
    it('returns NO_MARKET_DATA when live mode has missing BBO/mid', () => {
        const result = assertMarketDataReady({
            paper: false,
            bestBid: null,
            bestAsk: null,
            mid: null,
            spreadBps: null,
            snapshotAgeMs: null,
            bookMaxAgeMs: 1500,
        });

        expect(result).toEqual({
            ok: false,
            reason: 'NO_MARKET_DATA',
        });
    });

    it('returns STALE_MARKET_DATA when live snapshot age exceeds max', () => {
        const result = assertMarketDataReady({
            paper: false,
            bestBid: 0.99,
            bestAsk: 1.01,
            mid: 1.0,
            spreadBps: 200,
            snapshotAgeMs: 2_000,
            bookMaxAgeMs: 1_500,
        });

        expect(result).toEqual({
            ok: false,
            reason: 'STALE_MARKET_DATA',
        });
    });

    it('allows paper mode with warning when market data is missing', () => {
        const result = assertMarketDataReady({
            paper: true,
            bestBid: null,
            bestAsk: null,
            mid: null,
            spreadBps: null,
            snapshotAgeMs: null,
            bookMaxAgeMs: 1500,
        });

        expect(result).toEqual({
            ok: true,
            warning: 'NO_MARKET_DATA',
        });
    });
});
