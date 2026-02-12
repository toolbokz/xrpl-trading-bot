import { Strategy, StrategyContext } from './types';
import { AMMService } from '../market/amm';
import { StrategyConfig, TradingPair, FlowConfig } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { RiskEngine } from '../risk/riskEngine';
import { logger } from '../analytics/logger';
import { isRegimeSafeForArb, getRegimeDescription, getRegimeSizeMultiplier } from '../market/flowMetrics';
import { resolveIssuerForRisk, resolveLegsForApi } from '../market/executionPairResolver';
import { getExecutionOrderFlags, getExecutionOrderType } from '../execution/orderType';

/**
 * Default flow config when not provided (should be passed from TradingRuntime)
 */
const DEFAULT_FLOW_CONFIG: Partial<FlowConfig> = {
    enableRegimeFilter: true,
};

export class AMMArbitrageStrategy implements Strategy {
    name = 'amm-arbitrage';
    private lastLedger = 0;
    private flowConfig: Partial<FlowConfig>;
    private lastLoggedRegime: string | null = null;

    constructor(
        private readonly amm: AMMService,
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

    async tick(ctx: StrategyContext): Promise<void> {
        if (ctx.ledgerIndex === this.lastLedger) return;
        this.lastLedger = ctx.ledgerIndex;
        const { orderBook, flow } = ctx;
        if (!orderBook.bids.length || !orderBook.asks.length) return;

        // ─────────────────────────────────────────────────────────────────────
        // Flow Regime Filter (skip dangerous regimes)
        // ─────────────────────────────────────────────────────────────────────
        if (flow && this.flowConfig.enableRegimeFilter !== false) {
            // Log regime changes
            if (flow.regime !== this.lastLoggedRegime) {
                logger.info({
                    regime: flow.regime,
                    description: getRegimeDescription(flow.regime),
                }, 'AMM Arb: 🌊 Flow regime changed');
                this.lastLoggedRegime = flow.regime;
            }

            if (!isRegimeSafeForArb(flow.regime)) {
                logger.debug({
                    regime: flow.regime,
                    reason: getRegimeDescription(flow.regime),
                }, 'AMM Arb: ⚠️ Skipping tick - regime unsafe for arbitrage');
                return;
            }
        }

        if (ctx.entryGate) {
            const decision = ctx.entryGate.shouldEnter();
            if (!decision.allowed) {
                ctx.entryGate.logDecision(this.name, decision);
                return;
            }
        }

        const firstBid = orderBook.bids[0];
        const firstAsk = orderBook.asks[0];
        if (!firstBid || !firstAsk) return;

        const bestBid = firstBid.price;
        const bestAsk = firstAsk.price;

        // Resolve legs via ExecutionPairResolver (replaces legacy issuer cascade)
        const resolvedLegs = resolveLegsForApi(this.pair);

        const ammInfo = await this.amm.fetchAMMInfo(
            resolvedLegs.base,
            resolvedLegs.quote,
        );
        if (!ammInfo || !ammInfo.tradingFee || !Number.isFinite(ammInfo.tradingFee)) return;
        if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return;

        const ammPrice = ammInfo.price ?? (bestBid + bestAsk) / 2;
        const bookMid = (bestBid + bestAsk) / 2;
        const diffBps = ((bookMid - ammPrice) / ammPrice) * 10_000;

        if (Math.abs(diffBps) < this.config.ammArbMinProfitBps) return;

        // ─────────────────────────────────────────────────────────────────────
        // Position Sizing (scale based on regime)
        // ─────────────────────────────────────────────────────────────────────
        const sizeMultiplier = flow ? getRegimeSizeMultiplier(flow) : 1.0;
        const adjustedPositionSize = this.config.positionSize * sizeMultiplier;

        if (adjustedPositionSize <= 0) {
            logger.debug({ sizeMultiplier, regime: flow?.regime }, 'AMM Arb: ⚠️ Position size zero after regime adjustment');
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Risk Engine Approval
        // ─────────────────────────────────────────────────────────────────────
        const issuer = resolveIssuerForRisk(this.pair);
        if (issuer) {
            const riskIntent = {
                issuer,
                size: adjustedPositionSize,
                potentialLoss: adjustedPositionSize * (this.config.stopLossBps / 10_000)
            };
            if (this.risk.approveIntent(riskIntent, this.pair) === false) {
                logger.info({
                    positionSize: adjustedPositionSize.toFixed(4),
                    potentialLoss: riskIntent.potentialLoss.toFixed(4)
                }, 'AMM Arb: ❌ Risk engine rejected trade intent');
                return;
            }
        }

        const side: 'buy' | 'sell' = diffBps > 0 ? 'buy' : 'sell';
        const price = side === 'buy' ? bestBid : bestAsk;

        logger.info({
            side,
            price: price.toFixed(6),
            diffBps: diffBps.toFixed(2),
            positionSize: adjustedPositionSize.toFixed(4),
            orderType: getExecutionOrderType(),
            sizeMultiplier: sizeMultiplier.toFixed(2),
            regime: flow?.regime ?? 'unknown',
        }, 'AMM Arb: 🎯 Executing arbitrage opportunity');

        const res = await this.executor.placeOffer({
            side,
            price,
            amount: adjustedPositionSize,
            strategy: this.name,
            flags: getExecutionOrderFlags(),
        });
        if (res.accepted) {
            logger.info({
                side,
                price: price.toFixed(6),
                diffBps: diffBps.toFixed(2),
                regime: flow?.regime ?? 'unknown',
            }, 'AMM Arb: ✅ Executed AMM arbitrage leg');
        }
    }
}
