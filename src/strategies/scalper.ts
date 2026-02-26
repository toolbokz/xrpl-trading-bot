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
import { getExecutionOrderFlags, getExecutionOrderType } from '../execution/orderType';
import { resolveAdaptiveStopLossBps, type VolatilityStopResolution } from '../market/volatilityEstimator';
import { computeFinalOrderSizeXrp, loadOrderSizingConfig, type CpMode } from '../execution/orderSizing';

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

export function resolveScalperStopLossBps(input: {
    fixedStopLossBps: number;
    volatilityStopConfig: StrategyConfig['volatilityStop'] | undefined;
    volatilityStopContext: StrategyContext['volatilityStop'] | undefined;
}): VolatilityStopResolution {
    return resolveAdaptiveStopLossBps({
        fixedStopLossBps: input.fixedStopLossBps,
        volBps: input.volatilityStopContext?.volBps ?? 0,
        volReady: input.volatilityStopContext?.volReady ?? false,
        config: input.volatilityStopConfig,
    });
}

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
        const reject = (reasonCode: string, detail?: Record<string, unknown>) => {
            ctx.strategyFunnel?.markRejected(reasonCode, detail);
        };
        const markCandidateBuilt = () => {
            ctx.strategyFunnel?.markCandidateBuilt();
        };
        const markApproved = (side: 'buy' | 'sell', sizeBase: number, expectedPriceSource: string) => {
            ctx.strategyFunnel?.markApproved({ side, sizeBase, expectedPriceSource });
        };

        // Log order book state
        if (!state.bids.length || !state.asks.length) {
            logger.info({ bids: state.bids.length, asks: state.asks.length }, 'Scalper: ❌ No bids or asks in order book');
            reject('bookStale', { bids: state.bids.length, asks: state.asks.length });
            return;
        }

        // Use configurable staleness threshold (default: 5000ms)
        const stalenessMs = this.config.orderBookStaleMs ?? 5_000;
        const bookAge = Date.now() - state.lastUpdated;
        if (bookAge > stalenessMs) {
            logger.info({ bookAge, stalenessMs }, 'Scalper: ❌ Order book stale, skipping tick');
            reject('bookStale', { bookAge, stalenessMs });
            return; // stale book
        }

        const cooldownRemaining = (this.position.cooldownUntil ?? 0) - Date.now();
        if (cooldownRemaining > 0) {
            logger.info({ cooldownRemaining: Math.round(cooldownRemaining / 1000) }, 'Scalper: ⏳ In cooldown period (seconds remaining)');
            reject('cooldown', { cooldownRemaining });
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
                reject('regimeNotAllowed', { regime: flow.regime });
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
                reject('adverseSelection', {
                    signalStrength: flow.signalStrength,
                    vwapDeviationBps: flow.vwapDeviationBps,
                    regime: flow.regime,
                });
                return;
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // Mid-Price Trend Filter (block BUY entry during confirmed downtrend)
        // Only gates new entries (flat → long); exits are unaffected.
        // ─────────────────────────────────────────────────────────────────────
        if (this.position.side === 'flat' && ctx.trend?.ready) {
            const trendBlockBps = this.flowConfig.trendEntryBlockBps ?? 8;
            if (ctx.trend.direction === 'down' && Math.abs(ctx.trend.trendBps) >= trendBlockBps) {
                logger.info({
                    trendDirection: ctx.trend.direction,
                    trendBps: ctx.trend.trendBps.toFixed(2),
                    velocityBpsPerMin: ctx.trend.velocityBpsPerMin?.toFixed(2) ?? 'N/A',
                    trendBlockBps,
                }, 'Scalper: 📉 Trend down — blocking BUY entry');
                reject('trendDown', {
                    direction: ctx.trend.direction,
                    trendBps: ctx.trend.trendBps,
                    trendBlockBps,
                });
                return;
            }
        }

        const issuer = resolveIssuerForRisk(this.pair);
        if (!issuer) {
            logger.info({ pair: this.pair }, 'Scalper: ❌ No issuer resolved for trading pair');
            reject('unknown', { reason: 'issuer-unresolved' });
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Unified Position Sizing (one-knob sizing pipeline)
        // ─────────────────────────────────────────────────────────────────────
        const flowRegimeMult = flow ? getRegimeSizeMultiplier(flow) : 1.0;
        const regimePolicyMult = ctx.regimePolicy?.regimeSizeMultiplier ?? 1.0;
        const combinedRegimeMult = Math.min(flowRegimeMult, regimePolicyMult);
        const cpMode: CpMode = (ctx.governance?.mode === 'THROTTLE'
            ? 'THROTTLE' : ctx.governance?.mode === 'PAUSE'
                ? 'PAUSE' : ctx.governance?.mode === 'SHUTDOWN'
                    ? 'SHUTDOWN' : 'NORMAL') as CpMode;
        const sizingCfg = ctx.orderSizingConfig ?? loadOrderSizingConfig();
        const sizingResult = computeFinalOrderSizeXrp({
            cpMode,
            cpSizeMult: ctx.globalSizeMultiplier ?? 1.0,
            regimeSizeMult: combinedRegimeMult,
            adaptiveSizeMult: ctx.adaptiveSizeMultiplier ?? 1.0,
            strategy: this.name,
        }, sizingCfg);

        if (sizingResult.skip) {
            reject('unknown', {
                reason: 'size-skip',
                detail: sizingResult.reason,
                finalSize: sizingResult.finalSize,
                minSize: sizingResult.minSize,
            });
            return;
        }
        const adjustedPositionSize = sizingResult.finalSize;

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
            reject('healthNotOk', {
                reason: 'risk-intent-rejected',
                positionSize: adjustedPositionSize,
            });
            return;
        }

        const bestBid = state.bids[0]?.price ?? 0;
        const bestAsk = state.asks[0]?.price ?? 0;
        const spreadBps = state.spread;

        // ─────────────────────────────────────────────────────────────────────
        // Entry Gate (updated to support max-spread gating for IOC taker scalper)
        // ─────────────────────────────────────────────────────────────────────
        if (ctx.entryGate) {
            const decision = ctx.entryGate.shouldEnter({
                maxSpreadBps: this.config.maxSpreadBps,
                // Legacy options left out intentionally; max-spread gate is preferred for IOC instant fills.
            });
            if (!decision.allowed) {
                ctx.entryGate.logDecision(this.name, decision);
                reject('healthNotOk', {
                    reason: 'entry-gate-blocked',
                    gateReasons: decision.reasons,
                });
                return;
            }
        }

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
            maxSpreadBps: this.config.maxSpreadBps,
            position: this.position.side,
            positionSize: adjustedPositionSize.toFixed(4),
            sizingBase: sizingResult.baseSize,
            sizingCp: sizingResult.cpMult,
            sizingRegime: sizingResult.regimeMult,
            sizingAdaptive: sizingResult.adaptiveMult,
            skewBps: skewBps.toFixed(2),
            regime: flow?.regime ?? 'unknown',
            imbalance: flow?.imbalance?.toFixed(3) ?? 'N/A',
        }, 'Scalper: 📊 Market conditions');

        // ─────────────────────────────────────────────────────────────────────
        // IOC taker scalper spread gate:
        // Enter only when spread is tight enough to cross cheaply.
        // ─────────────────────────────────────────────────────────────────────
        if (Number.isFinite(this.config.maxSpreadBps) && this.config.maxSpreadBps > 0) {
            if (spreadBps > this.config.maxSpreadBps) {
                logger.info({
                    spreadBps: spreadBps.toFixed(2),
                    maxSpreadBps: this.config.maxSpreadBps,
                }, 'Scalper: ❌ Spread too wide (too expensive to cross for IOC scalper)');
                reject('spreadTooWide', { spreadBps, maxSpreadBps: this.config.maxSpreadBps });
                return;
            }
        } else {
            // Fallback legacy behavior if maxSpreadBps is not configured
            if (spreadBps < this.config.minSpreadBps) {
                logger.info({
                    spreadBps: spreadBps.toFixed(2),
                    minSpreadBps: this.config.minSpreadBps
                }, 'Scalper: ❌ Spread too narrow (legacy min-spread gate)');
                reject('minEdge', { spreadBps, minSpreadBps: this.config.minSpreadBps });
                return;
            }
        }

        if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
            logger.info({ bestBid, bestAsk }, 'Scalper: ❌ Invalid prices (bid >= ask or zero prices)');
            reject('invalidPrices', { bestBid, bestAsk });
            return;
        }

        logger.info({
            spreadBps: spreadBps.toFixed(2),
            maxSpreadBps: this.config.maxSpreadBps,
        }, 'Scalper: ✅ Spread acceptable, evaluating trade');

        if (this.position.side === 'flat') {
            // ─────────────────────────────────────────────────────────────────
            // Flow-Alpha Directional Entry Filter
            // Only enter long when order flow confirms buy-side pressure.
            // This prevents random entries that statistically lose the spread.
            // ─────────────────────────────────────────────────────────────────
            if (this.config.flowAlphaEnabled && flow) {
                const minImbalance = this.config.flowAlphaMinImbalance ?? 0.15;
                const minCombined = this.config.flowAlphaMinCombinedSignal ?? 0.10;
                const maxVwapDevBps = this.config.flowAlphaMaxVwapDeviationBps ?? 0;

                const imbalanceOk = flow.imbalance >= minImbalance;
                const combinedOk = flow.combinedSignal >= minCombined;
                const vwapOk = maxVwapDevBps === 0 || flow.vwapDeviationBps <= maxVwapDevBps;

                if (!imbalanceOk || !combinedOk || !vwapOk) {
                    logger.info({
                        imbalance: flow.imbalance.toFixed(3),
                        minImbalance,
                        imbalanceOk,
                        combinedSignal: flow.combinedSignal.toFixed(3),
                        minCombined,
                        combinedOk,
                        vwapDeviationBps: flow.vwapDeviationBps.toFixed(2),
                        maxVwapDevBps,
                        vwapOk,
                    }, 'Scalper: 🔬 Flow-alpha filter BLOCKED entry — no directional edge');
                    reject('flowAlpha', {
                        imbalance: flow.imbalance,
                        combinedSignal: flow.combinedSignal,
                        vwapDeviationBps: flow.vwapDeviationBps,
                    });
                    return;
                }

                logger.info({
                    imbalance: flow.imbalance.toFixed(3),
                    combinedSignal: flow.combinedSignal.toFixed(3),
                    vwapDeviationBps: flow.vwapDeviationBps.toFixed(2),
                    depthImbalance: flow.depthImbalance.toFixed(3),
                    buyAggressionRatio: flow.buyAggressionRatio.toFixed(3),
                }, 'Scalper: 🔬 Flow-alpha filter PASSED — directional edge confirmed');
            }

            // Apply skew to entry price: positive imbalance → bid less aggressively
            const entryBasePrice = bestBid * (1.0001 - skewFactor);
            const entryCrossFactor = 1 + ((this.config.entryCrossBps ?? 0) / 10_000);
            const price = Math.min(bestAsk, entryBasePrice * entryCrossFactor);

            logger.info({
                side: 'BUY',
                price: price.toFixed(6),
                amount: adjustedPositionSize.toFixed(4),
                flags: `${getExecutionOrderType()} (${getExecutionOrderType() === 'FOK' ? 'Fill-Or-Kill' : 'Immediate-Or-Cancel'})`,
                skewApplied: skewBps.toFixed(2),
                entryCrossBps: this.config.entryCrossBps ?? 0,
            }, 'Scalper: 🚀 Placing BUY order');
            markCandidateBuilt();
            markApproved('buy', adjustedPositionSize, 'bestBid');

            const res = await this.executor.placeOffer({
                side: 'buy',
                price,
                amount: adjustedPositionSize,
                strategy: this.name,
                flags: getExecutionOrderFlags(),
                sizePreComposed: true,
            });
            if (res.accepted) {
                // Use actual fill price from executor (post depth-reprice), not the intended price.
                // The depth reprice system may silently move the price 10-20 bps higher;
                // using the intended price causes false take-profit exits.
                const actualEntryPrice = res.fillResult?.effectivePrice ?? price;
                this.position = { side: 'long', entryPrice: actualEntryPrice };
                logger.info({
                    intendedPrice: price.toFixed(6),
                    actualEntryPrice: actualEntryPrice.toFixed(6),
                    repricedBps: actualEntryPrice !== price
                        ? (((actualEntryPrice - price) / price) * 10_000).toFixed(2)
                        : '0.00',
                    spreadBps: spreadBps.toFixed(2),
                    regime: flow?.regime ?? 'unknown',
                }, 'Scalper: ✅ Entered LONG position');
            } else {
                logger.info({ result: res }, 'Scalper: ❌ BUY order not accepted');
                reject('unknown', {
                    reason: 'offer-rejected',
                    executorReason: res.reason ?? null,
                });
            }
            return;
        }

        if (this.position.side === 'long' && this.position.entryPrice) {
            // Apply skew to exit price: positive imbalance → ask more aggressively
            const targetExitBase = bestAsk * (0.9999 + skewFactor);
            const exitCrossFactor = 1 - ((this.config.exitCrossBps ?? 0) / 10_000);
            const targetExit = Math.max(bestBid, targetExitBase * exitCrossFactor);
            // Require exit price to exceed entry by at least minTakeProfitBps to
            // avoid exiting at a microscopic "profit" that doesn't cover fees/spread.
            const minTakeProfitBps = this.config.minTakeProfitBps ?? 0;
            const minProfitThreshold = this.position.entryPrice * (1 + minTakeProfitBps / 10_000);
            const takeProfit = targetExit > minProfitThreshold;
            const stopLossResolution = resolveScalperStopLossBps({
                fixedStopLossBps: this.config.stopLossBps,
                volatilityStopConfig: this.config.volatilityStop,
                volatilityStopContext: ctx.volatilityStop,
            });
            const stopLossLevel = this.position.entryPrice * (1 - stopLossResolution.stopLossBpsUsed / 10_000);
            const isStopLoss = bestBid < stopLossLevel;

            // Enhanced stop-loss during trending down regime
            const enhancedStopLoss = flow?.regime === 'trendingDown' &&
                bestBid < this.position.entryPrice * (1 - stopLossResolution.enhancedStopBpsUsed / 10_000);

            logger.info({
                entryPrice: this.position.entryPrice.toFixed(6),
                targetExit: targetExit.toFixed(6),
                minProfitThreshold: minProfitThreshold.toFixed(6),
                minTakeProfitBps,
                stopLossLevel: stopLossLevel.toFixed(6),
                stopLossBpsUsed: stopLossResolution.stopLossBpsUsed.toFixed(2),
                enhancedStopBpsUsed: stopLossResolution.enhancedStopBpsUsed.toFixed(2),
                stopLossSource: stopLossResolution.source,
                currentBid: bestBid.toFixed(6),
                takeProfit,
                isStopLoss,
                enhancedStopLoss,
                regime: flow?.regime ?? 'unknown',
            }, 'Scalper: 📈 Evaluating exit for LONG position');

            if (takeProfit || isStopLoss || enhancedStopLoss) {
                // Optional: prevent profit-taking exits when spread is too wide (stop-loss still allowed)
                if (takeProfit && !isStopLoss && !enhancedStopLoss) {
                    if (Number.isFinite(this.config.maxExitSpreadBps) && this.config.maxExitSpreadBps > 0) {
                        if (spreadBps > this.config.maxExitSpreadBps) {
                            logger.info({
                                spreadBps: spreadBps.toFixed(2),
                                maxExitSpreadBps: this.config.maxExitSpreadBps,
                            }, 'Scalper: ❌ Exit spread too wide for take-profit IOC exit (skipping)');
                            reject('spreadTooWideExit', { spreadBps, maxExitSpreadBps: this.config.maxExitSpreadBps });
                            return;
                        }
                    }
                }

                const exitReason = enhancedStopLoss
                    ? 'ENHANCED STOP (trending down)'
                    : (isStopLoss ? 'STOP LOSS' : 'TAKE PROFIT');

                logger.info({
                    side: 'SELL',
                    price: targetExit.toFixed(6),
                    amount: adjustedPositionSize.toFixed(4),
                    reason: exitReason,
                    exitCrossBps: this.config.exitCrossBps ?? 0,
                }, 'Scalper: 🚀 Placing SELL order');
                markCandidateBuilt();
                markApproved('sell', adjustedPositionSize, 'bestAsk');

                const res = await this.executor.placeOffer({
                    side: 'sell',
                    price: targetExit,
                    amount: adjustedPositionSize,
                    strategy: this.name,
                    flags: getExecutionOrderFlags(),
                    sizePreComposed: true,
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
                    reject('unknown', {
                        reason: 'offer-rejected',
                        executorReason: res.reason ?? null,
                    });
                }
            } else {
                logger.info('Scalper: ⏳ Holding LONG - waiting for take profit or stop loss');
            }
        }
    }
}