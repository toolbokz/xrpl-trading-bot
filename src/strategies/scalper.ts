import { Strategy, StrategyContext } from './types';
import { OrderBookTracker } from '../market/orderBookTracker';
import { StrategyConfig, TradingPair, FlowConfig } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { RiskEngine } from '../risk/riskEngine';
import { strategyLog as logger } from '../analytics/logger';
import {
    isRegimeSafeForMM,
    getRegimeSizeMultiplier,
    calculateQuoteSkew,
    hasAdverseSelectionRisk,
    getRegimeDescription,
} from '../market/flowMetrics';
import { resolveIssuerForRisk } from '../market/executionPairResolver';

interface PositionState {
    side: 'flat' | 'long' | 'short';
    entryPrice?: number | undefined;
    cooldownUntil?: number | undefined;
}

/**
 * Default flow config when not provided (should be passed from TradingRuntime)
 */
const DEFAULT_FLOW_CONFIG: Partial<FlowConfig> = {
    enableRegimeFilter: true,
    enableAdverseSelectionProtection: true,
    maxQuoteSkewBps: 10,
};

export class ScalperStrategy implements Strategy {
    name = 'orderbook-scalper';
    private position: PositionState = { side: 'flat' };
    private flowConfig: Partial<FlowConfig>;
    private lastLoggedRegime: string | null = null;

    constructor(
        private readonly tracker: OrderBookTracker,
        private readonly config: StrategyConfig,
        private pair: TradingPair,
        private readonly executor: OfferExecutor,
        private readonly risk: RiskEngine,
        flowConfig?: Partial<FlowConfig>
    ) {
        this.flowConfig = flowConfig ?? DEFAULT_FLOW_CONFIG;
    }

    setPair(pair: TradingPair): void {
        this.pair = pair;
    }

    setPositionSize(size: number): void {
        if (Number.isFinite(size) && size > 0) {
            this.config.positionSize = size;
        }
    }

    /**
     * Update flow configuration at runtime (e.g., from API).
     */
    setFlowConfig(config: Partial<FlowConfig>): void {
        this.flowConfig = { ...this.flowConfig, ...config };
    }

    async tick(ctx: StrategyContext): Promise<void> {
        const state = this.tracker.getState();
        const flow = ctx.flow;

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

        // ─────────────────────────────────────────────────────────────────────
        // Flow Regime Filter (skip dangerous regimes)
        // ─────────────────────────────────────────────────────────────────────
        if (flow && this.flowConfig.enableRegimeFilter !== false) {
            // Log regime changes
            if (flow.regime !== this.lastLoggedRegime) {
                logger.info({
                    regime: flow.regime,
                    description: getRegimeDescription(flow.regime),
                    imbalance: flow.imbalance.toFixed(3),
                    signalStrength: flow.signalStrength.toFixed(3),
                }, 'Scalper: 🌊 Flow regime changed');
                this.lastLoggedRegime = flow.regime;
            }

            if (!isRegimeSafeForMM(flow.regime)) {
                logger.debug({
                    regime: flow.regime,
                    reason: getRegimeDescription(flow.regime),
                }, 'Scalper: ⚠️ Skipping tick - regime unsafe for market-making');
                return;
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // Adverse Selection Protection (retreat from informed flow)
        // ─────────────────────────────────────────────────────────────────────
        if (flow && this.flowConfig.enableAdverseSelectionProtection !== false) {
            if (hasAdverseSelectionRisk(flow)) {
                logger.info({
                    signalStrength: flow.signalStrength.toFixed(3),
                    vwapDeviationBps: flow.vwapDeviationBps.toFixed(1),
                    regime: flow.regime,
                }, 'Scalper: 🛑 Adverse selection risk detected - retreating');
                return;
            }
        }

        const issuer = resolveIssuerForRisk(this.pair);
        if (!issuer) {
            logger.info({ pair: this.pair }, 'Scalper: ❌ No issuer resolved for trading pair');
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Position Sizing (scale based on regime)
        // ─────────────────────────────────────────────────────────────────────
        const basePositionSize = this.config.positionSize;
        const sizeMultiplier = flow ? getRegimeSizeMultiplier(flow) : 1.0;
        const adjustedPositionSize = basePositionSize * sizeMultiplier;

        if (adjustedPositionSize <= 0) {
            logger.debug({ sizeMultiplier, regime: flow?.regime }, 'Scalper: ⚠️ Position size zero after regime adjustment');
            return;
        }

        const riskIntent = {
            issuer,
            size: adjustedPositionSize,
            potentialLoss: adjustedPositionSize * (this.config.stopLossBps / 10_000)
        };
        if (this.risk.approveIntent(riskIntent, this.pair) === false) {
            logger.info({
                positionSize: adjustedPositionSize.toFixed(4),
                potentialLoss: riskIntent.potentialLoss.toFixed(4)
            }, 'Scalper: ❌ Risk engine rejected trade intent');
            return;
        }

        const bestBid = state.bids[0]?.price ?? 0;
        const bestAsk = state.asks[0]?.price ?? 0;
        const spreadBps = state.spread;

        // ─────────────────────────────────────────────────────────────────────
        // Quote Skew (adjust prices based on flow imbalance)
        // ─────────────────────────────────────────────────────────────────────
        const maxSkewBps = this.flowConfig.maxQuoteSkewBps ?? 10;
        const skewBps = flow ? calculateQuoteSkew(flow, maxSkewBps) : 0;

        // Positive imbalance (more buys) → raise our bid less, raise our ask more
        // Negative imbalance (more sells) → raise our bid more, lower our ask more
        const skewFactor = skewBps / 10_000;

        // Log market conditions every tick (with flow data)
        logger.info({
            bestBid: bestBid.toFixed(6),
            bestAsk: bestAsk.toFixed(6),
            spreadBps: spreadBps.toFixed(2),
            minSpreadBps: this.config.minSpreadBps,
            position: this.position.side,
            positionSize: adjustedPositionSize.toFixed(4),
            sizeMultiplier: sizeMultiplier.toFixed(2),
            skewBps: skewBps.toFixed(2),
            regime: flow?.regime ?? 'unknown',
            imbalance: flow?.imbalance?.toFixed(3) ?? 'N/A',
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
            // Apply skew to entry price: positive imbalance → bid less aggressively
            const price = bestBid * (1.0001 - skewFactor);

            logger.info({
                side: 'BUY',
                price: price.toFixed(6),
                amount: adjustedPositionSize.toFixed(4),
                flags: 'IOC (Immediate-Or-Cancel)',
                skewApplied: skewBps.toFixed(2),
            }, 'Scalper: 🚀 Placing BUY order');

            const res = await this.executor.placeOffer({
                side: 'buy',
                price,
                amount: adjustedPositionSize,
                flags: { immediateOrCancel: true }
            });
            if (res.accepted) {
                this.position = { side: 'long', entryPrice: price };
                logger.info({
                    price: price.toFixed(6),
                    spreadBps: spreadBps.toFixed(2),
                    regime: flow?.regime ?? 'unknown',
                }, 'Scalper: ✅ Entered LONG position');
            } else {
                logger.info({ result: res }, 'Scalper: ❌ BUY order not accepted');
            }
            return;
        }

        if (this.position.side === 'long' && this.position.entryPrice) {
            // Apply skew to exit price: positive imbalance → ask more aggressively
            const targetExit = bestAsk * (0.9999 + skewFactor);
            const takeProfit = targetExit > this.position.entryPrice;
            const stopLossLevel = this.position.entryPrice * (1 - this.config.stopLossBps / 10_000);
            const isStopLoss = bestBid < stopLossLevel;

            // Enhanced stop-loss during trending down regime
            const enhancedStopLoss = flow?.regime === 'trendingDown' &&
                bestBid < this.position.entryPrice * (1 - this.config.stopLossBps / 20_000);

            logger.info({
                entryPrice: this.position.entryPrice.toFixed(6),
                targetExit: targetExit.toFixed(6),
                stopLossLevel: stopLossLevel.toFixed(6),
                currentBid: bestBid.toFixed(6),
                takeProfit,
                isStopLoss,
                enhancedStopLoss,
                regime: flow?.regime ?? 'unknown',
            }, 'Scalper: 📈 Evaluating exit for LONG position');

            if (takeProfit || isStopLoss || enhancedStopLoss) {
                const exitReason = enhancedStopLoss
                    ? 'ENHANCED STOP (trending down)'
                    : (isStopLoss ? 'STOP LOSS' : 'TAKE PROFIT');

                logger.info({
                    side: 'SELL',
                    price: targetExit.toFixed(6),
                    amount: adjustedPositionSize.toFixed(4),
                    reason: exitReason,
                }, 'Scalper: 🚀 Placing SELL order');

                const res = await this.executor.placeOffer({
                    side: 'sell',
                    price: targetExit,
                    amount: adjustedPositionSize,
                    flags: { immediateOrCancel: true }
                });
                if (res.accepted) {
                    const shouldCooldown = isStopLoss || enhancedStopLoss;
                    this.position = {
                        side: 'flat',
                        cooldownUntil: shouldCooldown ? Date.now() + this.config.cooldownMs : undefined
                    };
                    logger.info({
                        exitPrice: targetExit.toFixed(6),
                        reason: exitReason,
                        cooldown: shouldCooldown ? `${this.config.cooldownMs}ms` : 'none',
                        regime: flow?.regime ?? 'unknown',
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
