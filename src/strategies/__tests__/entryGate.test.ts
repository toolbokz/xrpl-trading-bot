import { describe, it, expect, beforeEach } from 'vitest';
import { EntryGate } from '../entryGate';
import { FlowMetrics } from '../../market/flowMetrics';
import { OrderBookState } from '../../utils/types';

function buildOrderBook(overrides: Partial<OrderBookState> = {}): OrderBookState {
    return {
        bids: [{ price: 1, quantity: 100, quality: 1, isBuy: true, raw: {} }],
        asks: [{ price: 1.01, quantity: 100, quality: 1, isBuy: false, raw: {} }],
        spread: 10,
        lastUpdated: Date.now(),
        ...overrides,
    };
}

function buildFlow(overrides: Partial<FlowMetrics> = {}): FlowMetrics {
    return {
        regime: 'normal',
        imbalance: 0,
        vwap: 1,
        vwapDeviationBps: 0,
        tradeCount: 10,
        totalVolumeBase: 100,
        buyAggressionRatio: 0.5,
        volumeVelocity: 10,
        bestBid: 1,
        bestAsk: 1.01,
        midPrice: 1.005,
        spreadBps: 10,
        depthImbalance: 0,
        bidDepthBase: 100,
        askDepthBase: 100,
        weightedBid: 1,
        weightedAsk: 1.01,
        combinedSignal: 0,
        signalStrength: 0.2,
        computedAt: Date.now(),
        ...overrides,
    };
}

describe('EntryGate', () => {
    let gate: EntryGate;

    beforeEach(() => {
        gate = new EntryGate({
            enabled: true,
            minSpreadBps: 15,
            minSignalStrength: 0.4,
            requireFlow: true,
            blockLocalExtreme: true,
            localExtremeThreshold: 0.6,
            localExtremeDecay: 0.5,
            maxBookStaleMs: 2000,
        });
    });

    it('blocks on stale order book', () => {
        const orderBook = buildOrderBook({ lastUpdated: Date.now() - 5000 });
        gate.ingestTick(orderBook, buildFlow());
        const decision = gate.shouldEnter();
        expect(decision.allowed).toBe(false);
        expect(decision.reasons).toContain('stale-book');
    });

    it('blocks on weak signal and narrow spread', () => {
        const orderBook = buildOrderBook({ spread: 5 });
        const flow = buildFlow({ signalStrength: 0.2 });
        gate.ingestTick(orderBook, flow);
        const decision = gate.shouldEnter();
        expect(decision.allowed).toBe(false);
        expect(decision.reasons).toContain('spread-too-narrow');
        expect(decision.reasons).toContain('signal-too-weak');
    });

    it('blocks local extreme after EMA crosses threshold', () => {
        const orderBook = buildOrderBook({
            bids: [{ price: 1, quantity: 1000, quality: 1, isBuy: true, raw: {} }],
            asks: [{ price: 1.01, quantity: 1, quality: 1, isBuy: false, raw: {} }],
        });
        gate.ingestTick(orderBook, buildFlow({ signalStrength: 0.5 }));
        const decision = gate.shouldEnter();
        expect(decision.allowed).toBe(false);
        expect(decision.reasons).toContain('local-extreme');
    });
});
