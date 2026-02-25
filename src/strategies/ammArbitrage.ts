import { Strategy, StrategyContext } from './types';
import { AMMService } from '../market/amm';
import { StrategyConfig, TradingPair, FlowConfig } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { RiskEngine } from '../risk/riskEngine';
import { logger } from '../analytics/logger';
import { isRegimeSafeForArb, getRegimeDescription, getRegimeSizeMultiplier } from '../market/flowMetrics';
import { resolveIssuerForRisk, resolveLegsForApi } from '../market/executionPairResolver';
import { getExecutionOrderFlags, getExecutionOrderType } from '../execution/orderType';
import { computeFinalOrderSizeXrp, loadOrderSizingConfig, type CpMode } from '../execution/orderSizing';

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
    private lastExecutionMs = 0;

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
        const reject = (reasonCode: string, detail?: Record<string, unknown>) => {
            ctx.strategyFunnel?.markRejected(reasonCode, detail);
        };
        const markCandidateBuilt = () => {
            ctx.strategyFunnel?.markCandidateBuilt();
        };
        const markApproved = (side: 'buy' | 'sell', sizeBase: number, expectedPriceSource: string) => {
            ctx.strategyFunnel?.markApproved({ side, sizeBase, expectedPriceSource });
        };

        if (ctx.ledgerIndex === this.lastLedger) {
            reject('cooldown', { reason: 'duplicate-ledger', ledgerIndex: ctx.ledgerIndex });
            return;
        }
        this.lastLedger = ctx.ledgerIndex;

        // ─────────────────────────────────────────────────────────────────────
        // Cooldown gate (AMM_ARB_COOLDOWN_MS, falls back to shared COOLDOWN_MS)
        // ─────────────────────────────────────────────────────────────────────
        const cooldownMs = this.config.ammArbCooldownMs > 0
            ? this.config.ammArbCooldownMs
            : this.config.cooldownMs;
        const elapsed = Date.now() - this.lastExecutionMs;
        if (cooldownMs > 0 && this.lastExecutionMs > 0 && elapsed < cooldownMs) {
            reject('cooldown', {
                reason: 'amm-arb-cooldown',
                cooldownMs,
                elapsedMs: elapsed,
            });
            return;
        }

        const { orderBook, flow } = ctx;
        if (!orderBook.bids.length || !orderBook.asks.length) {
            reject('routeUnavailable', {
                reason: 'book-empty',
                bids: orderBook.bids.length,
                asks: orderBook.asks.length,
            });
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
                }, 'AMM Arb: 🌊 Flow regime changed');
                this.lastLoggedRegime = flow.regime;
            }

            if (!isRegimeSafeForArb(flow.regime)) {
                logger.debug({
                    regime: flow.regime,
                    reason: getRegimeDescription(flow.regime),
                }, 'AMM Arb: ⚠️ Skipping tick - regime unsafe for arbitrage');
                reject('regimeNotAllowed', { regime: flow.regime });
                return;
            }
        }

        if (ctx.entryGate) {
            const decision = ctx.entryGate.shouldEnter();
            if (!decision.allowed) {
                ctx.entryGate.logDecision(this.name, decision);
                reject('healthNotOk', {
                    reason: 'entry-gate-blocked',
                    gateReasons: decision.reasons,
                });
                return;
            }
        }

        const firstBid = orderBook.bids[0];
        const firstAsk = orderBook.asks[0];
        if (!firstBid || !firstAsk) {
            reject('routeUnavailable', { reason: 'missing-bbo' });
            return;
        }

        const bestBid = firstBid.price;
        const bestAsk = firstAsk.price;

        // ─────────────────────────────────────────────────────────────────────
        // Spread gate (AMM_ARB_MAX_SPREAD_BPS)
        // ─────────────────────────────────────────────────────────────────────
        if (this.config.ammArbMaxSpreadBps > 0 && bestAsk > 0 && bestBid > 0) {
            const mid = (bestBid + bestAsk) / 2;
            const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
            if (spreadBps > this.config.ammArbMaxSpreadBps) {
                logger.debug({
                    spreadBps: spreadBps.toFixed(2),
                    maxSpreadBps: this.config.ammArbMaxSpreadBps,
                }, 'AMM Arb: ⚠️ Spread too wide');
                reject('spreadTooWide', {
                    spreadBps,
                    maxSpreadBps: this.config.ammArbMaxSpreadBps,
                });
                return;
            }
        }

        // Resolve legs via ExecutionPairResolver (replaces legacy issuer cascade)
        const resolvedLegs = resolveLegsForApi(this.pair);

        const ammInfo = await this.amm.fetchAMMInfo(
            resolvedLegs.base,
            resolvedLegs.quote,
        );
        if (!ammInfo || !ammInfo.tradingFee || !Number.isFinite(ammInfo.tradingFee)) {
            reject('poolStale', { reason: 'amm-info-unavailable' });
            return;
        }
        if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
            reject('routeUnavailable', { reason: 'invalid-bbo', bestBid, bestAsk });
            return;
        }

        const ammPrice = ammInfo.price ?? (bestBid + bestAsk) / 2;
        const bookMid = (bestBid + bestAsk) / 2;
        const diffBps = ((bookMid - ammPrice) / ammPrice) * 10_000;

        if (Math.abs(diffBps) < this.config.ammArbMinProfitBps) {
            reject('minProfitBps', {
                diffBps,
                minProfitBps: this.config.ammArbMinProfitBps,
            });
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
        // If AMM has its own base position size, override in the config copy
        const ammSizingCfg = this.config.ammArbPositionSize > 0
            ? { ...sizingCfg, baseOrderSizeXrp: this.config.ammArbPositionSize }
            : sizingCfg;
        const sizingResult = computeFinalOrderSizeXrp({
            cpMode,
            cpSizeMult: ctx.globalSizeMultiplier ?? 1.0,
            regimeSizeMult: combinedRegimeMult,
            adaptiveSizeMult: ctx.adaptiveSizeMultiplier ?? 1.0,
            strategy: this.name,
        }, ammSizingCfg);

        if (sizingResult.skip) {
            reject('cooldown', {
                reason: 'size-skip',
                detail: sizingResult.reason,
                finalSize: sizingResult.finalSize,
                minSize: sizingResult.minSize,
            });
            return;
        }
        const adjustedPositionSize = sizingResult.finalSize;

        // ─────────────────────────────────────────────────────────────────────
        // Risk Engine Approval
        // ─────────────────────────────────────────────────────────────────────
        const effectiveStopLossBps = this.config.ammArbStopLossBps > 0
            ? this.config.ammArbStopLossBps
            : this.config.stopLossBps;
        const issuer = resolveIssuerForRisk(this.pair);
        if (issuer) {
            const riskIntent = {
                issuer,
                size: adjustedPositionSize,
                potentialLoss: adjustedPositionSize * (effectiveStopLossBps / 10_000)
            };
            if (this.risk.approveIntent(riskIntent, this.pair) === false) {
                logger.info({
                    positionSize: adjustedPositionSize.toFixed(4),
                    potentialLoss: riskIntent.potentialLoss.toFixed(4)
                }, 'AMM Arb: ❌ Risk engine rejected trade intent');
                reject('healthNotOk', {
                    reason: 'risk-intent-rejected',
                    positionSize: adjustedPositionSize,
                });
                return;
            }
        }

        const side: 'buy' | 'sell' = diffBps > 0 ? 'buy' : 'sell';

        // ─────────────────────────────────────────────────────────────────────
        // Entry cross (AMM_ARB_ENTRY_CROSS_BPS, falls back to shared SCALPER_ENTRY_CROSS_BPS)
        // Crosses toward the opposite side for better fill probability.
        // ─────────────────────────────────────────────────────────────────────
        const entryCrossBps = this.config.ammArbEntryCrossBps > 0
            ? this.config.ammArbEntryCrossBps
            : this.config.entryCrossBps;
        const entryCrossFactor = 1 + (entryCrossBps / 10_000);
        const price = side === 'buy'
            ? Math.min(bestAsk, bestBid * entryCrossFactor)   // cross up from bid, cap at ask
            : Math.max(bestBid, bestAsk / entryCrossFactor);  // cross down from ask, floor at bid

        logger.info({
            side,
            price: price.toFixed(6),
            diffBps: diffBps.toFixed(2),
            positionSize: adjustedPositionSize.toFixed(4),
            orderType: getExecutionOrderType(),
            entryCrossBps,
            sizingResult: {
                base: sizingResult.baseSize,
                cp: sizingResult.cpMult,
                regime: sizingResult.regimeMult,
                adaptive: sizingResult.adaptiveMult,
            },
            regime: flow?.regime ?? 'unknown',
        }, 'AMM Arb: 🎯 Executing arbitrage opportunity');
        markCandidateBuilt();
        markApproved(side, adjustedPositionSize, side === 'buy' ? 'bestBid' : 'bestAsk');

        const res = await this.executor.placeOffer({
            side,
            price,
            amount: adjustedPositionSize,
            strategy: this.name,
            flags: getExecutionOrderFlags(),
            sizePreComposed: true,
        });
        this.lastExecutionMs = Date.now();
        if (res.accepted) {
            logger.info({
                side,
                price: price.toFixed(6),
                diffBps: diffBps.toFixed(2),
                regime: flow?.regime ?? 'unknown',
            }, 'AMM Arb: ✅ Executed AMM arbitrage leg');
        } else {
            logger.info({ side, result: res }, 'AMM Arb: ❌ Order not accepted');
            reject('unknown', {
                reason: 'offer-rejected',
                executorReason: res.reason ?? null,
            });
        }
    }
}
