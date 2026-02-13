import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathArbitrageStrategy } from '../pathArbitrage';
import type { StrategyConfig, TradingPair } from '../../config';
import type { OfferExecutor } from '../../execution/offerExecutor';
import type { RiskEngine } from '../../risk/riskEngine';

describe('PathArbitrageStrategy strategy funnel telemetry', () => {
    const originalPathArbEnabled = process.env.PATH_ARB_ENABLED;

    beforeEach(() => {
        process.env.PATH_ARB_ENABLED = 'false';
    });

    afterEach(() => {
        process.env.PATH_ARB_ENABLED = originalPathArbEnabled;
    });

    it('records pathArbDisabled when PATH_ARB_ENABLED is false', async () => {
        const client = {
            request: vi.fn(),
        } as any;

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

        const strategy = new PathArbitrageStrategy(
            client,
            config,
            pair,
            executor,
            false,
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
            strategyFunnel: {
                markRejected,
                markApproved,
                markCandidateBuilt,
            },
        } as any);

        expect(markRejected).toHaveBeenCalledWith('pathArbDisabled', undefined);
        expect(markApproved).not.toHaveBeenCalled();
        expect(markCandidateBuilt).not.toHaveBeenCalled();
        expect(client.request).not.toHaveBeenCalled();
        expect((executor as any).placeOffer).not.toHaveBeenCalled();
    });
});
