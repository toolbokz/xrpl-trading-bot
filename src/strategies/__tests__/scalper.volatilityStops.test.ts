import { describe, it, expect, vi } from 'vitest';
import { ScalperStrategy, resolveScalperStopLossBps } from '../scalper';
import type { StrategyConfig, TradingPair } from '../../config';
import type { OrderBookTracker } from '../../market/orderBookTracker';
import type { OfferExecutor } from '../../execution/offerExecutor';
import type { RiskEngine } from '../../risk/riskEngine';
import type { StrategyContext, StrategyVolatilityStopContext } from '../types';

interface BookState {
    bids: Array<{ price: number; quantity: number }>;
    asks: Array<{ price: number; quantity: number }>;
    spread: number;
    lastUpdated: number;
}

const pair: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    issuer: 'rHDEadbeefDeadbeefDeadbeefDeadbeefDead',
};

function makeConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
    return {
        minSpreadBps: 1,
        positionSize: 1,
        stopLossBps: 100,
        cooldownMs: 1_000,
        ammArbMinProfitBps: 15,
        pathArbMinProfitBps: 20,
        maxSlippageBps: 50,
        orderBookStaleMs: 5_000,
        entryCrossBps: 0,
        exitCrossBps: 0,
        volatilityStop: {
            enabled: false,
            warmupMs: 60_000,
            minSamples: 50,
            alpha: 0.2,
            multiplier: 2.0,
            minBps: 50,
            maxBps: 250,
            useForEnhanced: true,
        },
        ...overrides,
    };
}

function makeBookState(bestBid: number, bestAsk: number): BookState {
    const mid = (bestBid + bestAsk) / 2;
    const spread = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;
    return {
        bids: [{ price: bestBid, quantity: 100 }],
        asks: [{ price: bestAsk, quantity: 100 }],
        spread,
        lastUpdated: Date.now(),
    };
}

function makeContext(orderBook: BookState, volatilityStop?: StrategyVolatilityStopContext): StrategyContext {
    return {
        orderBook: orderBook as any,
        ledgerIndex: 1,
        volatilityStop,
    };
}

describe('resolveScalperStopLossBps', () => {
    it('uses fixed STOP_LOSS_BPS when volatility stops are disabled', () => {
        const resolved = resolveScalperStopLossBps({
            fixedStopLossBps: 100,
            volatilityStopConfig: {
                enabled: false,
                warmupMs: 60_000,
                minSamples: 50,
                alpha: 0.2,
                multiplier: 2,
                minBps: 50,
                maxBps: 250,
                useForEnhanced: true,
            },
            volatilityStopContext: {
                enabled: true,
                volBps: 200,
                volReady: true,
                stopLossBpsUsed: 250,
                enhancedStopBpsUsed: 125,
                source: 'adaptive',
            },
        });
        expect(resolved.stopLossBpsUsed).toBe(100);
        expect(resolved.enhancedStopBpsUsed).toBe(50);
        expect(resolved.source).toBe('fixed-disabled');
    });

    it('uses fixed STOP_LOSS_BPS during warmup (not ready)', () => {
        const resolved = resolveScalperStopLossBps({
            fixedStopLossBps: 100,
            volatilityStopConfig: {
                enabled: true,
                warmupMs: 60_000,
                minSamples: 50,
                alpha: 0.2,
                multiplier: 2,
                minBps: 50,
                maxBps: 250,
                useForEnhanced: true,
            },
            volatilityStopContext: {
                enabled: true,
                volBps: 200,
                volReady: false,
                stopLossBpsUsed: 100,
                enhancedStopBpsUsed: 50,
                source: 'fixed-warmup',
            },
        });
        expect(resolved.stopLossBpsUsed).toBe(100);
        expect(resolved.enhancedStopBpsUsed).toBe(50);
        expect(resolved.source).toBe('fixed-warmup');
    });

    it('uses clamped adaptive stop when enabled and ready', () => {
        const resolved = resolveScalperStopLossBps({
            fixedStopLossBps: 100,
            volatilityStopConfig: {
                enabled: true,
                warmupMs: 60_000,
                minSamples: 50,
                alpha: 0.2,
                multiplier: 2,
                minBps: 50,
                maxBps: 250,
                useForEnhanced: true,
            },
            volatilityStopContext: {
                enabled: true,
                volBps: 200,
                volReady: true,
                stopLossBpsUsed: 250,
                enhancedStopBpsUsed: 125,
                source: 'adaptive',
            },
        });
        expect(resolved.stopLossBpsUsed).toBe(250); // 200*2=400 -> clamp 250
        expect(resolved.enhancedStopBpsUsed).toBe(125); // half of adaptive stop
        expect(resolved.source).toBe('adaptive');
    });

    it('keeps enhanced stop fixed-half when VOL_STOP_USE_FOR_ENHANCED=false', () => {
        const resolved = resolveScalperStopLossBps({
            fixedStopLossBps: 100,
            volatilityStopConfig: {
                enabled: true,
                warmupMs: 60_000,
                minSamples: 50,
                alpha: 0.2,
                multiplier: 2,
                minBps: 50,
                maxBps: 250,
                useForEnhanced: false,
            },
            volatilityStopContext: {
                enabled: true,
                volBps: 200,
                volReady: true,
                stopLossBpsUsed: 250,
                enhancedStopBpsUsed: 50,
                source: 'adaptive',
            },
        });
        expect(resolved.stopLossBpsUsed).toBe(250);
        expect(resolved.enhancedStopBpsUsed).toBe(50);
        expect(resolved.source).toBe('adaptive');
    });
});

describe('ScalperStrategy volatility stop behavior', () => {
    function setup(config: StrategyConfig) {
        const bookRef: { current: BookState } = {
            current: makeBookState(1.0, 1.001),
        };

        const tracker = {
            getState: () => bookRef.current,
        } as unknown as OrderBookTracker;

        const executor = {
            placeOffer: vi.fn(async () => ({ accepted: true })),
        } as unknown as OfferExecutor;

        const risk = {
            approveIntent: vi.fn(() => true),
        } as unknown as RiskEngine;

        const strategy = new ScalperStrategy(tracker, config, pair, executor, risk, {
            enableRegimeFilter: false,
            enableAdverseSelectionProtection: false,
            maxQuoteSkewBps: 10,
        });

        return { strategy, bookRef, executor };
    }

    it('uses fixed stop-loss when VOL_STOP_ENABLED=false (legacy behavior)', async () => {
        const { strategy, bookRef, executor } = setup(makeConfig({
            stopLossBps: 100,
            volatilityStop: { ...makeConfig().volatilityStop!, enabled: false },
        }));

        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: true,
            stopLossBpsUsed: 250,
            enhancedStopBpsUsed: 125,
            source: 'adaptive',
        }));

        // Fixed 100 bps stop should trigger here.
        bookRef.current = makeBookState(0.987, 0.988);
        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: true,
            stopLossBpsUsed: 250,
            enhancedStopBpsUsed: 125,
            source: 'adaptive',
        }));

        const calls = (executor as any).placeOffer.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0]?.[0]?.side).toBe('buy');
        expect(calls[1]?.[0]?.side).toBe('sell');
    });

    it('uses fixed stop-loss when enabled but volatility is not ready', async () => {
        const { strategy, bookRef, executor } = setup(makeConfig({
            stopLossBps: 100,
            volatilityStop: { ...makeConfig().volatilityStop!, enabled: true },
        }));

        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: false,
            stopLossBpsUsed: 100,
            enhancedStopBpsUsed: 50,
            source: 'fixed-warmup',
        }));

        bookRef.current = makeBookState(0.987, 0.988);
        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: false,
            stopLossBpsUsed: 100,
            enhancedStopBpsUsed: 50,
            source: 'fixed-warmup',
        }));

        const calls = (executor as any).placeOffer.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[1]?.[0]?.side).toBe('sell');
    });

    it('uses adaptive stop-loss when enabled and ready', async () => {
        const { strategy, bookRef, executor } = setup(makeConfig({
            stopLossBps: 100,
            volatilityStop: {
                ...makeConfig().volatilityStop!,
                enabled: true,
                multiplier: 2,
                minBps: 50,
                maxBps: 250,
                useForEnhanced: true,
            },
        }));

        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: true,
            stopLossBpsUsed: 250,
            enhancedStopBpsUsed: 125,
            source: 'adaptive',
        }));

        // With adaptive 250 bps stop, this should NOT trigger stop-loss.
        bookRef.current = makeBookState(0.987, 0.988);
        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: true,
            stopLossBpsUsed: 250,
            enhancedStopBpsUsed: 125,
            source: 'adaptive',
        }));

        const calls = (executor as any).placeOffer.mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[0]?.side).toBe('buy');
    });

    it('keeps take-profit exit behavior unchanged', async () => {
        const { strategy, bookRef, executor } = setup(makeConfig({
            stopLossBps: 100,
            volatilityStop: { ...makeConfig().volatilityStop!, enabled: true },
        }));

        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: true,
            stopLossBpsUsed: 250,
            enhancedStopBpsUsed: 125,
            source: 'adaptive',
        }));

        // Profit-taking path should still trigger regardless of stop configuration.
        bookRef.current = makeBookState(1.003, 1.004);
        await strategy.tick(makeContext(bookRef.current, {
            enabled: true,
            volBps: 200,
            volReady: true,
            stopLossBpsUsed: 250,
            enhancedStopBpsUsed: 125,
            source: 'adaptive',
        }));

        const calls = (executor as any).placeOffer.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[1]?.[0]?.side).toBe('sell');
    });
});
