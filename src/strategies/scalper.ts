import { Strategy, StrategyContext } from './types';
import { OrderBookTracker } from '../market/orderBookTracker';
import { StrategyConfig, TradingPair } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { RiskEngine } from '../risk/riskEngine';
import { logger } from '../analytics/logger';

interface PositionState {
    side: 'flat' | 'long' | 'short';
    entryPrice?: number | undefined;
    cooldownUntil?: number | undefined;
}

export class ScalperStrategy implements Strategy {
    name = 'orderbook-scalper';
    private position: PositionState = { side: 'flat' };

    constructor(
        private readonly tracker: OrderBookTracker,
        private readonly config: StrategyConfig,
        private readonly pair: TradingPair,
        private readonly executor: OfferExecutor,
        private readonly risk: RiskEngine
    ) { }

    setPositionSize(size: number): void {
        if (Number.isFinite(size) && size > 0) {
            this.config.positionSize = size;
        }
    }

    async tick(_ctx: StrategyContext): Promise<void> {
        const state = this.tracker.getState();
        if (!state.bids.length || !state.asks.length) return;

        // Use configurable staleness threshold (default: 5000ms)
        const stalenessMs = this.config.orderBookStaleMs ?? 5_000;
        const bookAge = Date.now() - state.lastUpdated;
        if (bookAge > stalenessMs) {
            logger.debug({ bookAge, stalenessMs }, 'Scalper: order book stale, skipping tick');
            return; // stale book
        }

        if (Date.now() < (this.position.cooldownUntil ?? 0)) return;
        const issuer = this.pair.quoteIssuer || this.pair.baseIssuer || this.pair.issuer;
        if (!issuer) return;
        if (this.risk.approveIntent({ issuer, size: this.config.positionSize, potentialLoss: this.config.positionSize * (this.config.stopLossBps / 10_000) }, this.pair) === false) return;

        const bestBid = state.bids[0]?.price ?? 0;
        const bestAsk = state.asks[0]?.price ?? 0;
        const spreadBps = state.spread;

        if (spreadBps < this.config.minSpreadBps) return;
        if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return;

        if (this.position.side === 'flat') {
            const price = bestBid * 1.0001;
            const res = await this.executor.placeOffer({ side: 'buy', price, amount: this.config.positionSize, flags: { immediateOrCancel: true } });
            if (res.accepted) {
                this.position = { side: 'long', entryPrice: price };
                logger.info({ price, spreadBps }, 'Entered long');
            }
            return;
        }

        if (this.position.side === 'long' && this.position.entryPrice) {
            const targetExit = bestAsk * 0.9999;
            const takeProfit = targetExit > this.position.entryPrice;
            const stopLossLevel = this.position.entryPrice * (1 - this.config.stopLossBps / 10_000);

            if (takeProfit || bestBid < stopLossLevel) {
                const res = await this.executor.placeOffer({ side: 'sell', price: targetExit, amount: this.config.positionSize, flags: { immediateOrCancel: true } });
                if (res.accepted) {
                    this.position = { side: 'flat', cooldownUntil: bestBid < stopLossLevel ? Date.now() + this.config.cooldownMs : undefined };
                    logger.info({ targetExit, stopLoss: bestBid < stopLossLevel }, 'Exited long');
                }
            }
        }
    }
}
