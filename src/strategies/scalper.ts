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

        // Log order book state
        if (!state.bids.length || !state.asks.length) {
            logger.info({ bids: state.bids.length, asks: state.asks.length }, 'Scalper: ❌ No bids or asks in order book');
            return;
        }

        // Use configurable staleness threshold (default: 5000ms)
        const stalenessMs = this.config.orderBookStaleMs ?? 5_000;
        const bookAge = Date.now() - state.lastUpdated;
        if (bookAge > stalenessMs) {
            logger.info({ bookAge, stalenessMs }, 'Scalper: ❌ Order book stale, skipping tick');
            return; // stale book
        }

        const cooldownRemaining = (this.position.cooldownUntil ?? 0) - Date.now();
        if (cooldownRemaining > 0) {
            logger.info({ cooldownRemaining: Math.round(cooldownRemaining / 1000) }, 'Scalper: ⏳ In cooldown period (seconds remaining)');
            return;
        }

        const issuer = this.pair.quoteIssuer || this.pair.baseIssuer || this.pair.issuer;
        if (!issuer) {
            logger.info({ pair: this.pair }, 'Scalper: ❌ No issuer configured for trading pair');
            return;
        }

        const riskIntent = {
            issuer,
            size: this.config.positionSize,
            potentialLoss: this.config.positionSize * (this.config.stopLossBps / 10_000)
        };
        if (this.risk.approveIntent(riskIntent, this.pair) === false) {
            logger.info({
                positionSize: this.config.positionSize,
                potentialLoss: riskIntent.potentialLoss.toFixed(4)
            }, 'Scalper: ❌ Risk engine rejected trade intent');
            return;
        }

        const bestBid = state.bids[0]?.price ?? 0;
        const bestAsk = state.asks[0]?.price ?? 0;
        const spreadBps = state.spread;

        // Log market conditions every tick
        logger.info({
            bestBid: bestBid.toFixed(6),
            bestAsk: bestAsk.toFixed(6),
            spreadBps: spreadBps.toFixed(2),
            minSpreadBps: this.config.minSpreadBps,
            position: this.position.side,
            positionSize: this.config.positionSize
        }, 'Scalper: 📊 Market conditions');

        if (spreadBps < this.config.minSpreadBps) {
            logger.info({
                spreadBps: spreadBps.toFixed(2),
                minSpreadBps: this.config.minSpreadBps
            }, 'Scalper: ❌ Spread too narrow (need higher spread to profit)');
            return;
        }

        if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
            logger.info({ bestBid, bestAsk }, 'Scalper: ❌ Invalid prices (bid >= ask or zero prices)');
            return;
        }

        logger.info({ spreadBps: spreadBps.toFixed(2), minSpreadBps: this.config.minSpreadBps },
            'Scalper: ✅ Spread profitable, evaluating trade');

        if (this.position.side === 'flat') {
            const price = bestBid * 1.0001;
            logger.info({
                side: 'BUY',
                price: price.toFixed(6),
                amount: this.config.positionSize,
                flags: 'IOC (Immediate-Or-Cancel)'
            }, 'Scalper: 🚀 Placing BUY order');

            const res = await this.executor.placeOffer({ side: 'buy', price, amount: this.config.positionSize, flags: { immediateOrCancel: true } });
            if (res.accepted) {
                this.position = { side: 'long', entryPrice: price };
                logger.info({ price: price.toFixed(6), spreadBps: spreadBps.toFixed(2) }, 'Scalper: ✅ Entered LONG position');
            } else {
                logger.info({ result: res }, 'Scalper: ❌ BUY order not accepted');
            }
            return;
        }

        if (this.position.side === 'long' && this.position.entryPrice) {
            const targetExit = bestAsk * 0.9999;
            const takeProfit = targetExit > this.position.entryPrice;
            const stopLossLevel = this.position.entryPrice * (1 - this.config.stopLossBps / 10_000);
            const isStopLoss = bestBid < stopLossLevel;

            logger.info({
                entryPrice: this.position.entryPrice.toFixed(6),
                targetExit: targetExit.toFixed(6),
                stopLossLevel: stopLossLevel.toFixed(6),
                currentBid: bestBid.toFixed(6),
                takeProfit,
                isStopLoss
            }, 'Scalper: 📈 Evaluating exit for LONG position');

            if (takeProfit || isStopLoss) {
                logger.info({
                    side: 'SELL',
                    price: targetExit.toFixed(6),
                    amount: this.config.positionSize,
                    reason: isStopLoss ? 'STOP LOSS' : 'TAKE PROFIT'
                }, 'Scalper: 🚀 Placing SELL order');

                const res = await this.executor.placeOffer({ side: 'sell', price: targetExit, amount: this.config.positionSize, flags: { immediateOrCancel: true } });
                if (res.accepted) {
                    this.position = { side: 'flat', cooldownUntil: isStopLoss ? Date.now() + this.config.cooldownMs : undefined };
                    logger.info({
                        exitPrice: targetExit.toFixed(6),
                        reason: isStopLoss ? 'STOP LOSS' : 'TAKE PROFIT',
                        cooldown: isStopLoss ? `${this.config.cooldownMs}ms` : 'none'
                    }, 'Scalper: ✅ Exited LONG position');
                } else {
                    logger.info({ result: res }, 'Scalper: ❌ SELL order not accepted');
                }
            } else {
                logger.info('Scalper: ⏳ Holding LONG - waiting for take profit or stop loss');
            }
        }
    }
}
