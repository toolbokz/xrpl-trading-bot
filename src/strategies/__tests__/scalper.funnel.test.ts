import { describe, it, expect, vi } from 'vitest';
import { ScalperStrategy } from '../scalper';
import type { StrategyConfig, TradingPair } from '../../config';
import type { OrderBookTracker } from '../../market/orderBookTracker';
import type { OfferExecutor } from '../../execution/offerExecutor';
import type { RiskEngine } from '../../risk/riskEngine';

describe('ScalperStrategy strategy funnel telemetry', () => {
    it('records regimeNotAllowed when regime filter rejects the tick', async () => {
        const tracker = {
            getState: () => ({
                bids: [{ price: 1.0, quantity: 100 }],
                asks: [{ price: 1.01, quantity: 100 }],
                spread: 100,
                lastUpdated: Date.now(),
            }),
        } as unknown as OrderBookTracker;

        const executor = {
            placeOffer: vi.fn(),
        } as unknown as OfferExecutor;

        const risk = {
            approveIntent: vi.fn(() => true),
        } as unknown as RiskEngine;

        const config: StrategyConfig = {
            minSpreadBps: 10,
            positionSize: 5,
            stopLossBps: 50,
            cooldownMs: 1_000,
            ammArbMinProfitBps: 15,
            pathArbMinProfitBps: 20,
            maxSlippageBps: 50,
            orderBookStaleMs: 5_000,
            entryCrossBps: 0,
            exitCrossBps: 0,
        };

        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            issuer: 'rHDEadbeefDeadbeefDeadbeefDeadbeefDead',
        };

        const strategy = new ScalperStrategy(
            tracker,
            config,
            pair,
            executor,
            risk,
            { enableRegimeFilter: true },
        );

        const markRejected = vi.fn();
        const markApproved = vi.fn();
        const markCandidateBuilt = vi.fn();

        await strategy.tick({
            orderBook: tracker.getState() as any,
            ledgerIndex: 1,
            flow: {
                regime: 'chaotic',
                imbalance: 0.8,
                vwap: 1.0,
                vwapDeviationBps: 20,
                tradeCount: 12,
                totalVolumeBase: 1000,
                buyAggressionRatio: 0.9,
                volumeVelocity: 12,
                bestBid: 1.0,
                bestAsk: 1.01,
                midPrice: 1.005,
                spreadBps: 100,
                depthImbalance: 0.7,
                bidDepthBase: 1200,
                askDepthBase: 600,
                depthRatio: 2,
                combinedSignal: 0.7,
                signalStrength: 0.8,
                isSignalStrong: true,
            },
            strategyFunnel: {
                markRejected,
                markApproved,
                markCandidateBuilt,
            },
        } as any);

        expect(markRejected).toHaveBeenCalledWith('regimeNotAllowed', expect.objectContaining({
            regime: 'chaotic',
        }));
        expect(markApproved).not.toHaveBeenCalled();
        expect(markCandidateBuilt).not.toHaveBeenCalled();
        expect((executor as any).placeOffer).not.toHaveBeenCalled();
    });
});
