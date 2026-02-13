import { describe, it, expect, vi } from 'vitest';
import { AMMArbitrageStrategy } from '../ammArbitrage';
import type { StrategyConfig, TradingPair } from '../../config';
import type { AMMService } from '../../market/amm';
import type { OfferExecutor } from '../../execution/offerExecutor';
import type { RiskEngine } from '../../risk/riskEngine';

describe('AMMArbitrageStrategy strategy funnel telemetry', () => {
    it('records regimeNotAllowed when arb regime gate blocks the tick', async () => {
        const amm = {
            fetchAMMInfo: vi.fn(),
        } as unknown as AMMService;

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

        const strategy = new AMMArbitrageStrategy(
            amm,
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
            ledgerIndex: 1,
            orderBook: {
                bids: [{ price: 1.0, quantity: 100 }],
                asks: [{ price: 1.01, quantity: 100 }],
                spread: 100,
                lastUpdated: Date.now(),
            } as any,
            flow: {
                regime: 'chaotic',
                signalStrength: 0.8,
            } as any,
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
        expect((amm as any).fetchAMMInfo).not.toHaveBeenCalled();
        expect((executor as any).placeOffer).not.toHaveBeenCalled();
    });
});
