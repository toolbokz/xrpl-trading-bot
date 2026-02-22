import { Client, Wallet, TransactionMetadata, Amount, IssuedCurrencyAmount, dropsToXrp } from 'xrpl';
import { ExecutionResult, OrderBookState, PartialFillResult } from '../utils/types';
import { RiskEngine } from '../risk/riskEngine';
import { StrategyConfig, TradingPair } from '../config';
import { executionLog as logger } from '../analytics/logger';
import {
    tradeHistory,
    TradeBaselineSource,
    TradeExpectedRule,
    TradePriceConvention,
} from '../analytics/tradeHistory';
import { feedbackEngine } from '../analytics/feedbackEngine';
import { tradeMarkoutScheduler } from '../analytics/tradeMarkoutScheduler';
import { computeCostRealism } from '../analytics/costRealism';
import { isAdaptiveEnabled } from '../analytics/adaptiveConfig';
import { buildOfferCreate, TradeIntent, TradeSide, normalizeIntent } from './offerBuilder';
import { ExecutionQualityCollector, InFlightTrace } from '../analytics/executionQuality';
import { ExposureTracker } from '../risk/exposureTracker';
import { FlowRegime } from '../market/flowMetrics';
import { canonicalizePairKey, decodeXrplCurrencyCode, toXrplCurrency } from '../xrpl/currency';
import { quarantineTradeRecord, validateTradeIntegrity, warnSuspiciousSlippage } from '../analytics/tradeIntegrity';
import { computeCanonicalSlippageBps, ExpectedPriceSource } from '../analytics/slippageMath';
import { buildExecutionQualityMetrics, computeLatencyMetrics } from '../analytics/executionQualityMetrics';
import type { TradeToastEvent } from '../observability/tradeToastEvents';
import type { StrategySubmitTelemetryEvent } from '../observability/strategyDecisionFunnel';

export interface OfferParams {
    side: 'buy' | 'sell';
    price: number;
    amount: number;
    /** Explicit strategy attribution override for this order. */
    strategy?: string;
    expectedPrice?: number; // For slippage calculation
    flags?: {
        immediateOrCancel?: boolean;
        fillOrKill?: boolean;
        passive?: boolean;
    };
}

export interface SlippageCheckResult {
    allowed: boolean;
    actualSlippageBps: number;
    maxSlippageBps: number;
    reason?: string | undefined;
}

export interface PostFillSnapshot {
    mid: number | null;
    spreadBps: number | null;
    flowCombined: number | null;
    flowStrength: number | null;
    flowRegime: FlowRegime | null;
}

type SlippageBaselineUsed = 'best_bid' | 'best_ask' | 'mid' | 'vwap' | 'intent' | 'unknown';

interface ExpectedBaselineContext {
    baselineTsMs: number;
    baselineBestBid: number | null;
    baselineBestAsk: number | null;
    baselineMid: number | null;
    baselineSpreadBps: number | null;
    baselineSource: TradeBaselineSource;
    expectedPrice: number | null;
    expectedRule: TradeExpectedRule;
    expectedPriceSource: ExpectedPriceSource;
    slippageBaselineUsed: SlippageBaselineUsed;
    priceConvention: TradePriceConvention;
    baselineBookAgeMs: number | null;
    orderingValid: boolean;
}

export function schedulePostFillSnapshots(opts: {
    eventId: string;
    getSnapshot: () => PostFillSnapshot;
    record1s: (snapshot: PostFillSnapshot) => void;
    record3s: (snapshot: PostFillSnapshot) => void;
    setTimeoutFn?: typeof setTimeout;
}): void {
    const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    logger.info({ eventId: opts.eventId }, 'Scheduled post-fill snapshots');
    const capture = (delayMs: number, record: (snapshot: PostFillSnapshot) => void) => {
        setTimeoutFn(() => {
            logger.info({ eventId: opts.eventId, delayMs }, 'Post-fill snapshot callback fired');
            record(opts.getSnapshot());
        }, delayMs);
    };

    capture(1000, opts.record1s);
    capture(3000, opts.record3s);
}

export class OfferExecutor {
    private currentStrategy: string = 'unknown';
    private currentMidPrice: number | null = null;
    private currentBestBid: number | null = null;
    private currentBestAsk: number | null = null;
    private currentSpreadBps: number | null = null;
    private currentBookAgeMs: number | null = null;
    private currentFlowCombined: number | null = null;
    private currentFlowStrength: number | null = null;
    private currentFlowRegime: FlowRegime | null = null;
    private currentLocalExtreme: boolean | null = null;

    // Execution quality analytics collector (injected by TradingRuntime)
    private executionQualityCollector: ExecutionQualityCollector | null = null;

    // Exposure tracker for position/inventory tracking (injected by TradingRuntime)
    private exposureTracker: ExposureTracker | null = null;

    // Adaptive learning overrides (set per-tick by TradingRuntime)
    private adaptiveMaxSlippageBps: number | null = null;
    private adaptiveSizeMultiplier: number | null = null;
    private adaptiveMinEdgeBps: number | null = null;

    // Governance layer overrides (Capital Protection - defense in depth)
    private governanceSizeMultiplier: number = 1.0;
    private governanceMode: 'ALLOW' | 'THROTTLE' | 'PAUSE' | 'SHUTDOWN' = 'ALLOW';

    // Regime policy layer overrides (regime-based sizing)
    private regimePolicySizeMultiplier: number = 1.0;
    private tradeToastEmitter: ((event: TradeToastEvent) => void) | null = null;
    private botTxHashSink: ((hash: string) => void) | null = null;
    private submitTelemetrySink: ((event: StrategySubmitTelemetryEvent) => void) | null = null;

    constructor(
        private readonly client: Client,
        private readonly wallet: Wallet | null,
        private readonly risk: RiskEngine,
        private readonly paper: boolean,
        private pair: TradingPair,
        private readonly strategyConfig?: StrategyConfig
    ) { }

    private readonly depthCheckLevels: number = Math.max(1, Math.min(20, parseInt(process.env.EXECUTION_DEPTH_LEVELS ?? '5', 10) || 5));
    private readonly iocMinFillRatio: number = (() => {
        const parsed = Number(process.env.EXECUTION_IOC_MIN_FILL_RATIO ?? '1');
        if (!Number.isFinite(parsed)) return 1;
        return Math.max(0.05, Math.min(1, parsed));
    })();

    /**
     * Update the trading pair (called by TradingRuntime on pair switch).
     */
    setPair(pair: TradingPair): void {
        this.pair = pair;
    }

    /**
     * Set the current strategy name for feedback tracking.
     * Called by strategies before executing trades.
     */
    setCurrentStrategy(strategy: string): void {
        this.currentStrategy = strategy;
    }

    /**
     * Set the current mid-price for slippage/edge calculations.
     * Called by strategies before executing trades.
     */
    setCurrentMidPrice(midPrice: number | null): void {
        this.currentMidPrice = midPrice;
    }

    /**
     * Set current market context for entry/post-fill attribution.
     * Called each tick by TradingRuntime.
     */
    setCurrentMarketContext(input: {
        midPrice: number | null;
        bestBid?: number | null;
        bestAsk?: number | null;
        spreadBps: number | null;
        bookAgeMs?: number | null;
        flowCombined: number | null;
        flowStrength: number | null;
        flowRegime: FlowRegime | null;
        localExtreme?: boolean | null;
    }): void {
        this.currentMidPrice = input.midPrice;
        this.currentBestBid = input.bestBid ?? null;
        this.currentBestAsk = input.bestAsk ?? null;
        this.currentSpreadBps = input.spreadBps;
        this.currentBookAgeMs = input.bookAgeMs ?? null;
        this.currentFlowCombined = input.flowCombined;
        this.currentFlowStrength = input.flowStrength;
        this.currentFlowRegime = input.flowRegime;
        this.currentLocalExtreme = input.localExtreme ?? null;
    }

    /**
     * Inject the execution quality collector for trace lifecycle.
     * Called once by TradingRuntime during initialization.
     */
    setExecutionQualityCollector(collector: ExecutionQualityCollector): void {
        this.executionQualityCollector = collector;
    }

    /**
     * Inject the exposure tracker for position tracking.
     * Called once by TradingRuntime during initialization.
     */
    setExposureTracker(tracker: ExposureTracker): void {
        this.exposureTracker = tracker;
    }

    /**
     * Optional non-blocking emitter for toast-friendly trade events.
     */
    setTradeToastEmitter(emitter: (event: TradeToastEvent) => void): void {
        this.tradeToastEmitter = emitter;
    }

    /**
     * Optional callback sink for submitted bot tx hashes.
     * Used by account-level ingestion to classify source=bot|manual.
     */
    setBotTxHashSink(sink: ((hash: string) => void) | null): void {
        this.botTxHashSink = sink;
    }

    /**
     * Optional sink for strategy submit telemetry.
     */
    setSubmitTelemetrySink(sink: ((event: StrategySubmitTelemetryEvent) => void) | null): void {
        this.submitTelemetrySink = sink;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Adaptive Learning Setters
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Set adaptive max slippage override.
     * Called by TradingRuntime based on current regime tuning.
     */
    setAdaptiveMaxSlippageBps(value: number | null): void {
        this.adaptiveMaxSlippageBps = value;
    }

    /**
     * Set adaptive size multiplier override.
     * Called by TradingRuntime based on current regime tuning.
     */
    setAdaptiveSizeMultiplier(value: number | null): void {
        this.adaptiveSizeMultiplier = value;
    }

    /**
     * Set adaptive min edge threshold override.
     * Called by TradingRuntime based on current regime tuning.
     */
    setAdaptiveMinEdgeBps(value: number | null): void {
        this.adaptiveMinEdgeBps = value;
    }

    /**
     * Clear all adaptive overrides (called between strategy ticks).
     */
    clearAdaptiveOverrides(): void {
        this.adaptiveMaxSlippageBps = null;
        this.adaptiveSizeMultiplier = null;
        this.adaptiveMinEdgeBps = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Governance Layer (Capital Protection - Defense in Depth)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Set governance size multiplier (Capital Protection throttling).
     * Applied AFTER adaptive multiplier as a hard cap.
     */
    setGovernanceSizeMultiplier(value: number): void {
        this.governanceSizeMultiplier = Math.max(0, Math.min(1, value));
    }

    /**
     * Set governance mode for defense-in-depth gating.
     * PAUSE/SHUTDOWN modes will reject all orders at executor level.
     */
    setGovernanceMode(mode: 'ALLOW' | 'THROTTLE' | 'PAUSE' | 'SHUTDOWN'): void {
        this.governanceMode = mode;
    }

    /**
     * Clear all governance overrides (reset to normal operation).
     */
    clearGovernanceOverrides(): void {
        this.governanceSizeMultiplier = 1.0;
        this.governanceMode = 'ALLOW';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Regime Policy Layer
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Set regime policy size multiplier.
     * Applied in combination with adaptive and governance multipliers.
     */
    setRegimePolicySizeMultiplier(value: number): void {
        this.regimePolicySizeMultiplier = Math.max(0, Math.min(1.2, value));
    }

    /**
     * Clear regime policy overrides (called between strategy ticks).
     */
    clearRegimePolicyOverrides(): void {
        this.regimePolicySizeMultiplier = 1.0;
    }

    /**
     * Get current governance state for diagnostics.
     */
    getGovernanceState(): { mode: string; sizeMultiplier: number } {
        return {
            mode: this.governanceMode,
            sizeMultiplier: this.governanceSizeMultiplier,
        };
    }

    /**
     * Get the effective max slippage (adaptive override → config → default).
     */
    private getEffectiveMaxSlippageBps(): number {
        return this.adaptiveMaxSlippageBps ?? this.strategyConfig?.maxSlippageBps ?? 50;
    }

    /**
     * Get the effective size multiplier (adaptive override → 1.0).
     * This is then further modified by governance and regime policy multipliers.
     */
    private getEffectiveSizeMultiplier(): number {
        const adaptive = this.adaptiveSizeMultiplier ?? 1.0;
        // Combine with governance and regime policy multipliers
        return adaptive * this.governanceSizeMultiplier * this.regimePolicySizeMultiplier;
    }

    /**
     * Get the effective min edge threshold (adaptive override → 0).
     */
    private getEffectiveMinEdgeBps(): number {
        return this.adaptiveMinEdgeBps ?? 0;
    }

    /**
     * Check if the actual price vs expected price is within slippage tolerance
     */
    checkSlippage(expectedPrice: number, actualPrice: number, side: 'buy' | 'sell'): SlippageCheckResult {
        const maxSlippageBps = this.getEffectiveMaxSlippageBps();

        if (!expectedPrice || expectedPrice <= 0) {
            return { allowed: true, actualSlippageBps: 0, maxSlippageBps };
        }

        // For buy: slippage is bad if actual > expected (paying more)
        // For sell: slippage is bad if actual < expected (receiving less)
        let slippageBps: number;
        if (side === 'buy') {
            slippageBps = ((actualPrice - expectedPrice) / expectedPrice) * 10000;
        } else {
            slippageBps = ((expectedPrice - actualPrice) / expectedPrice) * 10000;
        }

        const allowed = slippageBps <= maxSlippageBps;

        return {
            allowed,
            actualSlippageBps: Math.round(slippageBps * 100) / 100,
            maxSlippageBps,
            reason: allowed ? undefined : `Slippage ${slippageBps.toFixed(2)} bps exceeds max ${maxSlippageBps} bps`,
        };
    }

    /**
     * Check if trade meets adaptive min edge requirement.
     * Returns rejection result if edge is insufficient.
     */
    private checkAdaptiveMinEdge(side: 'buy' | 'sell', intentPrice: number): { allowed: boolean; reason?: string } {
        if (!isAdaptiveEnabled()) {
            return { allowed: true };
        }

        const minEdgeBps = this.getEffectiveMinEdgeBps();
        if (minEdgeBps <= 0 || !this.currentMidPrice || this.currentMidPrice <= 0) {
            return { allowed: true };
        }

        // Compute edge: intent vs mid (same sign convention as costRealism)
        // For buys: lower intent = better (negative raw edge = positive)
        // For sells: higher intent = better (positive raw edge = positive)
        const rawEdge = ((intentPrice - this.currentMidPrice) / this.currentMidPrice) * 10000;
        const edgeBps = side === 'buy' ? -rawEdge : rawEdge;

        if (edgeBps < minEdgeBps) {
            return {
                allowed: false,
                reason: `adaptive-min-edge: edge ${edgeBps.toFixed(1)} bps < min ${minEdgeBps} bps`,
            };
        }

        return { allowed: true };
    }

    /**
     * Apply adaptive size multiplier to amount.
     * Returns adjusted amount and rejection status if multiplier is 0.
     */
    private applyAdaptiveSizeMultiplier(amount: number): { adjustedAmount: number; rejected: boolean; reason?: string } {
        if (!isAdaptiveEnabled()) {
            return { adjustedAmount: amount, rejected: false };
        }

        const multiplier = this.getEffectiveSizeMultiplier();

        // If multiplier is 0, reject the trade entirely
        if (multiplier <= 0) {
            return {
                adjustedAmount: 0,
                rejected: true,
                reason: 'adaptive-disabled: size multiplier is 0',
            };
        }

        // Apply multiplier, clamped to [0, 1.5]
        const clampedMultiplier = Math.max(0, Math.min(1.5, multiplier));
        const adjustedAmount = amount * clampedMultiplier;

        return { adjustedAmount, rejected: false };
    }

    async placeOffer(params: OfferParams): Promise<ExecutionResult> {
        if (params.strategy && params.strategy.trim().length > 0) {
            this.currentStrategy = params.strategy.trim();
        }
        const pairSymbol = canonicalizePairKey(`${this.pair.baseCurrency}/${this.pair.quoteCurrency}`);

        // ─────────────────────────────────────────────────────────────────────
        // Defense-in-depth: Governance layer gate (Capital Protection)
        // This is a HARD STOP that cannot be bypassed by strategies
        // ─────────────────────────────────────────────────────────────────────
        if (this.governanceMode === 'SHUTDOWN' || this.governanceMode === 'PAUSE') {
            const reason = `governance-blocked: mode=${this.governanceMode}`;
            logger.warn({
                strategy: this.currentStrategy,
                side: params.side,
                price: params.price,
                amount: params.amount,
                governanceMode: this.governanceMode,
            }, 'Order REJECTED by governance layer (defense-in-depth)');

            try {
                feedbackEngine.recordTradeEvent({
                    pairKey: pairSymbol,
                    strategy: this.currentStrategy,
                    action: 'reject',
                    side: params.side,
                    intentPrice: params.price,
                    intentSizeBase: params.amount,
                    error: reason,
                    midPriceAtDecision: this.currentMidPrice ?? undefined,
                    isBotTrade: true,
                });
            } catch { /* feedback should never crash trading */ }

            return { accepted: false, reason };
        }

        // Check adaptive min edge requirement
        const edgeCheck = this.checkAdaptiveMinEdge(params.side, params.price);
        if (!edgeCheck.allowed) {
            logger.info({
                strategy: this.currentStrategy,
                side: params.side,
                price: params.price,
                midPrice: this.currentMidPrice,
                reason: edgeCheck.reason,
            }, 'Order rejected by adaptive min edge gate');

            // Record feedback for adaptive rejection
            try {
                feedbackEngine.recordTradeEvent({
                    pairKey: pairSymbol,
                    strategy: this.currentStrategy,
                    action: 'reject',
                    side: params.side,
                    intentPrice: params.price,
                    intentSizeBase: params.amount,
                    error: edgeCheck.reason,
                    midPriceAtDecision: this.currentMidPrice ?? undefined,
                    isBotTrade: true,
                });
            } catch { /* feedback should never crash trading */ }

            return { accepted: false, reason: edgeCheck.reason };
        }

        // Apply adaptive size multiplier
        const sizeResult = this.applyAdaptiveSizeMultiplier(params.amount);
        if (sizeResult.rejected) {
            logger.info({
                strategy: this.currentStrategy,
                side: params.side,
                originalAmount: params.amount,
                reason: sizeResult.reason,
            }, 'Order rejected by adaptive size gate');

            try {
                feedbackEngine.recordTradeEvent({
                    pairKey: pairSymbol,
                    strategy: this.currentStrategy,
                    action: 'reject',
                    side: params.side,
                    intentPrice: params.price,
                    intentSizeBase: params.amount,
                    error: sizeResult.reason,
                    midPriceAtDecision: this.currentMidPrice ?? undefined,
                    isBotTrade: true,
                });
            } catch { /* feedback should never crash trading */ }

            return { accepted: false, reason: sizeResult.reason };
        }

        // Apply governance size multiplier (Capital Protection throttling)
        // This is applied AFTER adaptive multiplier as an additional hard cap
        let governanceAdjustedAmount = sizeResult.adjustedAmount;
        if (this.governanceMode === 'THROTTLE' && this.governanceSizeMultiplier < 1.0) {
            governanceAdjustedAmount = sizeResult.adjustedAmount * this.governanceSizeMultiplier;
            logger.debug({
                strategy: this.currentStrategy,
                originalAmount: sizeResult.adjustedAmount,
                governanceMultiplier: this.governanceSizeMultiplier,
                adjustedAmount: governanceAdjustedAmount,
            }, 'Order size reduced by governance throttle');
        }

        // Use adjusted amount
        const adjustedParams = { ...params, amount: governanceAdjustedAmount };

        // Check slippage if expected price provided
        if (adjustedParams.expectedPrice) {
            const slippageCheck = this.checkSlippage(adjustedParams.expectedPrice, adjustedParams.price, adjustedParams.side);
            if (!slippageCheck.allowed) {
                logger.warn({
                    expectedPrice: adjustedParams.expectedPrice,
                    actualPrice: adjustedParams.price,
                    slippageBps: slippageCheck.actualSlippageBps,
                    maxSlippageBps: slippageCheck.maxSlippageBps,
                }, 'Order rejected due to slippage');

                // Record rejected trade
                tradeHistory.recordTrade({
                    pair: pairSymbol,
                    side: adjustedParams.side.toUpperCase() as 'BUY' | 'SELL',
                    price: adjustedParams.price,
                    amount: adjustedParams.amount,
                    filled: 0,
                    fee: 0,
                    pnl: 0,
                    paper: this.paper,
                    status: 'REJECTED',
                });

                // Record feedback event for analytics
                try {
                    feedbackEngine.recordTradeEvent({
                        pairKey: pairSymbol,
                        strategy: this.currentStrategy,
                        action: 'reject',
                        side: adjustedParams.side,
                        intentPrice: adjustedParams.price,
                        intentSizeBase: adjustedParams.amount,
                        error: slippageCheck.reason,
                        midPriceAtDecision: this.currentMidPrice ?? undefined,
                        isBotTrade: true,
                    });
                } catch { /* feedback should never crash trading */ }

                return { accepted: false, reason: slippageCheck.reason };
            }
        }

        const intent: TradeIntent = {
            pair: this.pair,
            side: adjustedParams.side.toUpperCase() as TradeSide,
            amount: adjustedParams.amount,
            price: adjustedParams.price,
            expectedPrice: adjustedParams.expectedPrice ?? adjustedParams.price,
        };
        return this.placeOfferIntent(intent, adjustedParams.flags, adjustedParams.expectedPrice);
    }

    async placeOfferIntent(intent: TradeIntent, flags?: OfferParams['flags'], expectedPriceOverride?: number): Promise<ExecutionResult> {
        const pairSymbol = canonicalizePairKey(`${this.pair.baseCurrency}/${this.pair.quoteCurrency}`);
        const effectiveExpectedPrice = expectedPriceOverride ?? intent.expectedPrice ?? intent.price;
        const normalizedIntent: TradeIntent = { ...intent, expectedPrice: effectiveExpectedPrice };
        const normalizedSide = normalizedIntent.side.toLowerCase() as 'buy' | 'sell';
        const baselineDecisionTs = Date.now();
        const expectedBaseline = this.resolveExpectedBaseline({
            side: normalizedSide,
            intentPrice: normalizedIntent.price,
            expectedPrice: normalizedIntent.expectedPrice,
            decisionTsMs: baselineDecisionTs,
        });
        const bboBaseline = this.getBboBaseline(normalizedSide);

        if (this.paper) {
            logger.info({ intent: normalizedIntent }, 'Paper trade: simulated OfferCreate');

            // Record paper trade
            tradeHistory.recordTrade({
                pair: pairSymbol,
                side: normalizedIntent.side as 'BUY' | 'SELL',
                price: normalizedIntent.price,
                priceQuotePerBase: normalizedIntent.price,
                amount: normalizedIntent.amount,
                amountBase: normalizedIntent.amount,
                filled: normalizedIntent.amount,
                filledBase: normalizedIntent.amount,
                filledQuote: normalizedIntent.amount * normalizedIntent.price,
                fee: 0,
                pnl: 0, // P&L calculated by strategy
                paper: true,
                status: 'FILLED',
            });

            // Compute cost realism for paper trades
            const side = normalizedIntent.side.toLowerCase() as 'buy' | 'sell';
            const costMetrics = computeCostRealism({
                side,
                intentPrice: expectedBaseline.expectedPrice ?? normalizedIntent.price,
                fillPrice: normalizedIntent.price, // Paper assumes perfect fill
                midPriceAtDecision: this.currentMidPrice,
                ammFeeBps: null, // No AMM fee in paper mode
            });
            const slippageBpsVsBbo =
                bboBaseline != null
                    ? computeCanonicalSlippageBps(side, bboBaseline, normalizedIntent.price)
                    : null;

            // Record feedback event for paper trades
                try {
                    feedbackEngine.recordTradeEvent({
                        pairKey: pairSymbol,
                        strategy: this.currentStrategy,
                        action: 'fill',
                        side,
                        intentPrice: normalizedIntent.expectedPrice ?? normalizedIntent.price,
                        intentSizeBase: normalizedIntent.amount,
                        fillPrice: normalizedIntent.price,
                    fillSizeBase: normalizedIntent.amount,
                    resultCode: 'paper-mode',
                    isBotTrade: true,
                    midPriceAtDecision: this.currentMidPrice ?? undefined,
                    // Cost realism fields
                        slippageBpsVsIntent: costMetrics.slippageBpsVsIntent,
                        slippageBpsVsMid: costMetrics.slippageBpsVsMid,
                        slippageBpsVsBbo,
                        expectedPriceSource: expectedBaseline.expectedPriceSource,
                    decisionMidPrice: this.currentMidPrice,
                    decisionBestBid: this.currentBestBid,
                    decisionBestAsk: this.currentBestAsk,
                    spreadPaidBps: costMetrics.spreadPaidBps,
                    edgeBpsVsMid: costMetrics.edgeBpsVsMid,
                    netEdgeBpsVsMid: costMetrics.netEdgeBpsVsMid,
                    txFeeXrp: 0,
                    ammFeeBps: null,
                    fillRatio: 1,
                    isPartial: false,
                    entrySpreadBps: this.currentSpreadBps,
                    entryFlowCombined: this.currentFlowCombined,
                    entryFlowStrength: this.currentFlowStrength,
                    entryFlowRegime: this.currentFlowRegime,
                    entryMid: this.currentMidPrice,
                    entrySignalStrength: this.currentFlowStrength,
                    entryLocalExtreme: this.currentLocalExtreme == null ? null : (this.currentLocalExtreme ? 1 : 0),
                });
            } catch { /* feedback should never crash trading */ }

            // ── Execution quality trace: paper trade (perfect fill, zero latency)
            if (this.executionQualityCollector) {
                try {
                    const now = Date.now();
                    const paperTrace = this.executionQualityCollector.createTrace({
                        pairKey: pairSymbol,
                        strategy: this.currentStrategy,
                        side,
                        arrivalMid: this.currentMidPrice ?? normalizedIntent.price,
                        expectedPrice: expectedBaseline.expectedPrice ?? normalizedIntent.price,
                        isMaker: false,
                    });
                    this.executionQualityCollector.recordFill(paperTrace, {
                        submitTimeMs: now,
                        ledgerAcceptedTimeMs: now,
                        fillPrice: normalizedIntent.price,
                        postFillMid: this.currentMidPrice ?? normalizedIntent.price,
                        fillRatio: 1,
                        txHash: null,
                        ledgerIndex: 0,
                    });
                } catch { /* analytics should never crash trading */ }
            }

            // Record fill in exposure tracker
            if (this.exposureTracker) {
                this.exposureTracker.recordFill(side, normalizedIntent.amount, pairSymbol);
            }

            this.emitTradeToastSafe({
                type: 'ORDER_PLACED',
                side: normalizedIntent.side as 'BUY' | 'SELL',
                pair: pairSymbol,
                baseCurrency: this.pair.baseCurrency,
                quoteCurrency: this.pair.quoteCurrency,
                baseAmount: normalizedIntent.amount,
                quoteAmount: normalizedIntent.amount * normalizedIntent.price,
                price: normalizedIntent.price,
                timestamp: new Date().toISOString(),
            });
            this.emitTradeToastSafe({
                type: 'ORDER_FILLED',
                side: normalizedIntent.side as 'BUY' | 'SELL',
                pair: pairSymbol,
                baseCurrency: this.pair.baseCurrency,
                quoteCurrency: this.pair.quoteCurrency,
                baseAmount: normalizedIntent.amount,
                quoteAmount: normalizedIntent.amount * normalizedIntent.price,
                price: normalizedIntent.price,
                timestamp: new Date().toISOString(),
            });

            return { accepted: true, reason: 'paper-mode' };
        }
        if (!this.wallet) return { accepted: false, reason: 'wallet-missing' };

        if (!Number.isFinite(normalizedIntent.price) || normalizedIntent.price <= 0 || !Number.isFinite(normalizedIntent.amount) || normalizedIntent.amount <= 0) {
            return { accepted: false, reason: 'invalid-params' };
        }

        const depth = await this.hasSufficientDepthAtPrice(normalizedIntent.side, normalizedIntent.price, normalizedIntent.amount, flags);
        if (!depth.hasDepth) {
            logger.warn({
                side: normalizedIntent.side,
                price: normalizedIntent.price,
                amount: normalizedIntent.amount,
                levels: this.depthCheckLevels,
                pair: pairSymbol,
                orderType: depth.orderType,
                fillableBase: depth.fillableBase,
                minRequiredBase: depth.minRequiredBase,
                iocMinFillRatio: this.iocMinFillRatio,
            }, 'Skipped order: insufficient depth at price');
            return { accepted: false, reason: 'insufficient-depth-at-price' };
        }

        const normalized = normalizeIntent(normalizedIntent);
        const txCore = buildOfferCreate(normalized);

        const tx: any = {
            ...txCore,
            TransactionType: 'OfferCreate',
            Account: this.wallet.classicAddress,
            Flags: this.mapFlags(flags),
            LastLedgerSequence: await this.computeLastLedgerSequence(),
        };
        return this.submitWithGuards(tx, normalized.pair.symbol, normalizedIntent, flags);
    }

    async executeIntents(intents: TradeIntent[]): Promise<ExecutionResult[]> {
        const results: ExecutionResult[] = [];
        for (const intent of intents) {
            try {
                const res = await this.placeOfferIntent(intent);
                results.push(res);
            } catch (err: any) {
                logger.error({ err, pair: `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}` }, 'Failed to execute intent');
                results.push({ accepted: false, reason: err?.message || 'intent-failed' });
            }
        }
        return results;
    }

    async cancelOffer(offerSequence: number): Promise<ExecutionResult> {
        const pairSymbol = canonicalizePairKey(`${this.pair.baseCurrency}/${this.pair.quoteCurrency}`);

        if (this.paper) {
            logger.info({ offerSequence }, 'Paper trade: simulated cancel');

            // Record feedback for paper cancel
            try {
                feedbackEngine.recordTradeEvent({
                    pairKey: pairSymbol,
                    strategy: this.currentStrategy,
                    action: 'offer_cancel',
                    resultCode: 'paper-mode',
                    isBotTrade: true,
                });
            } catch { /* feedback should never crash trading */ }

            return { accepted: true };
        }
        if (!this.wallet) return { accepted: false, reason: 'wallet-missing' };
        const tx: any = {
            TransactionType: 'OfferCancel',
            Account: this.wallet.classicAddress,
            OfferSequence: offerSequence,
        };
        return this.submitWithGuards(tx);
    }

    evaluatePartialFill(state: OrderBookState, offerPrice: number, side: 'buy' | 'sell'): boolean {
        // Cancels if book moved through our price -> likely filled
        const bestBid = state.bids[0]?.price ?? 0;
        const bestAsk = state.asks[0]?.price ?? 0;
        if (side === 'buy' && offerPrice >= bestAsk) return true;
        if (side === 'sell' && offerPrice <= bestBid) return true;
        return false;
    }

    private mapFlags(flags?: OfferParams['flags']): number {
        let f = 0;
        if (flags?.immediateOrCancel) f |= 0x00020000;
        if (flags?.fillOrKill) f |= 0x00040000;
        if (flags?.passive) f |= 0x00010000;
        return f;
    }

    private buildExecutionFlags(flags?: OfferParams['flags']): string[] {
        const values: string[] = [];
        if (flags?.immediateOrCancel) values.push('IOC');
        if (flags?.fillOrKill) values.push('FOK');
        if (flags?.passive) values.push('PASSIVE');
        return values;
    }

    private toBookCurrency(currency: string, issuer?: string): { currency: 'XRP' } | { currency: string; issuer: string } {
        if (currency.toUpperCase() === 'XRP') {
            return { currency: 'XRP' };
        }
        if (!issuer) {
            throw new Error(`Issuer is required for non-XRP currency: ${currency}`);
        }
        return toXrplCurrency({ currency, issuer });
    }

    private async hasSufficientDepthAtPrice(
        side: TradeSide,
        intendedPrice: number,
        requiredBaseAmount: number,
        flags?: OfferParams['flags']
    ): Promise<{
        hasDepth: boolean;
        fillableBase: number;
        requiredBaseAmount: number;
        minRequiredBase: number;
        orderType: 'IOC' | 'FOK';
    }> {
        const orderType: 'IOC' | 'FOK' = flags?.fillOrKill ? 'FOK' : 'IOC';
        const minRequiredBase = orderType === 'FOK'
            ? requiredBaseAmount
            : requiredBaseAmount * this.iocMinFillRatio;

        if (!Number.isFinite(intendedPrice) || intendedPrice <= 0 || !Number.isFinite(requiredBaseAmount) || requiredBaseAmount <= 0) {
            return {
                hasDepth: false,
                fillableBase: 0,
                requiredBaseAmount,
                minRequiredBase,
                orderType,
            };
        }

        try {
            const baseIssuerRaw = this.pair.baseIssuer ?? this.pair.issuer;
            const quoteIssuerRaw = this.pair.quoteIssuer ?? this.pair.issuer;
            const base = this.toBookCurrency(this.pair.baseCurrency, baseIssuerRaw);
            const quote = this.toBookCurrency(this.pair.quoteCurrency, quoteIssuerRaw);

            const req = side === 'BUY'
                ? {
                    command: 'book_offers' as const,
                    ledger_index: 'validated' as const,
                    limit: this.depthCheckLevels,
                    // consume asks (makers sell base)
                    taker_gets: base,
                    taker_pays: quote,
                }
                : {
                    command: 'book_offers' as const,
                    ledger_index: 'validated' as const,
                    limit: this.depthCheckLevels,
                    // consume bids (makers buy base)
                    taker_gets: quote,
                    taker_pays: base,
                };

            const res = await this.client.request(req as any);
            const offers = ((res as any).result?.offers ?? []) as Array<{ TakerGets: Amount; TakerPays: Amount }>;

            let fillableBase = 0;
            for (const offer of offers.slice(0, this.depthCheckLevels)) {
                const gets = this.amountToNumber(offer.TakerGets);
                const pays = this.amountToNumber(offer.TakerPays);
                if (gets <= 0 || pays <= 0) continue;

                if (side === 'BUY') {
                    const askPrice = pays / gets; // quote/base
                    if (askPrice <= intendedPrice) {
                        fillableBase += gets;
                    }
                } else {
                    const bidPrice = gets / pays; // quote/base
                    if (bidPrice >= intendedPrice) {
                        fillableBase += pays;
                    }
                }

                if (fillableBase >= minRequiredBase) {
                    return {
                        hasDepth: true,
                        fillableBase,
                        requiredBaseAmount,
                        minRequiredBase,
                        orderType,
                    };
                }
            }

            return {
                hasDepth: false,
                fillableBase,
                requiredBaseAmount,
                minRequiredBase,
                orderType,
            };
        } catch (err) {
            logger.warn({ err, side, intendedPrice, requiredBaseAmount }, 'Depth preflight failed');
            return {
                hasDepth: false,
                fillableBase: 0,
                requiredBaseAmount,
                minRequiredBase,
                orderType,
            };
        }
    }

    private redactAmount(val: any): any {
        if (val === undefined || val === null) return val;
        if (typeof val === 'string') return val; // drops amount is safe
        const copy: any = { ...val };
        if (copy.issuer) copy.issuer = '[redacted]';
        return copy;
    }

    private async computeLastLedgerSequence(): Promise<number | undefined> {
        try {
            const res = await this.client.request({ command: 'ledger_current' });
            const current = res.result?.ledger_current_index;
            if (typeof current === 'number') return current + 4;
        } catch (err) {
            logger.warn({ err }, 'Unable to fetch ledger_current for LastLedgerSequence');
        }
        return undefined;
    }

    private extractTxResult(meta: unknown): string | undefined {
        if (!meta || typeof meta === 'string') return typeof meta === 'string' ? meta : undefined;
        return (meta as TransactionMetadata).TransactionResult;
    }

    /**
     * Convert an XRPL Amount to a numeric value.
     * XRP amounts are in drops (strings), issued currency amounts are objects.
     */
    private amountToNumber(amount: Amount): number {
        if (typeof amount === 'string') {
            // XRP in drops - dropsToXrp returns a number
            return dropsToXrp(amount);
        }
        // IssuedCurrencyAmount has currency, issuer, and value fields
        if (typeof amount === 'object' && 'value' in amount) {
            return parseFloat((amount as IssuedCurrencyAmount).value);
        }
        return 0;
    }

    private parseAmountInfo(amount: Amount | undefined): { value: number; currency: string; issuer?: string } | null {
        if (!amount) return null;
        if (typeof amount === 'string') {
            const value = dropsToXrp(amount);
            if (!Number.isFinite(value) || value <= 0) return null;
            return { value, currency: 'XRP' };
        }

        if (typeof amount !== 'object' || !('value' in amount)) return null;
        const issued = amount as IssuedCurrencyAmount;
        const value = parseFloat(issued.value);
        if (!Number.isFinite(value) || value <= 0) return null;

        return {
            value,
            currency: decodeXrplCurrencyCode(issued.currency).toUpperCase(),
            issuer: issued.issuer,
        };
    }

    private amountMatchesAsset(
        info: { currency: string; issuer?: string },
        targetCurrency: string,
        targetIssuer?: string
    ): boolean {
        const normalizedTarget = decodeXrplCurrencyCode(targetCurrency).toUpperCase();
        if (info.currency !== normalizedTarget) return false;
        if (normalizedTarget === 'XRP') return true;
        if (!targetIssuer) return true;
        return info.issuer === targetIssuer;
    }

    private mapOfferDeltaToPairUnits(
        getsAmount: Amount | undefined,
        getsDelta: number,
        paysAmount: Amount | undefined,
        paysDelta: number
    ): { baseDelta: number; quoteDelta: number } | null {
        if (!Number.isFinite(getsDelta) || getsDelta <= 0 || !Number.isFinite(paysDelta) || paysDelta <= 0) {
            return null;
        }

        const getsInfo = this.parseAmountInfo(getsAmount);
        const paysInfo = this.parseAmountInfo(paysAmount);
        if (!getsInfo || !paysInfo) return null;

        const baseIssuer = this.pair.baseIssuer ?? this.pair.issuer;
        const quoteIssuer = this.pair.quoteIssuer ?? this.pair.issuer;

        const getsIsBase = this.amountMatchesAsset(getsInfo, this.pair.baseCurrency, baseIssuer);
        const paysIsQuote = this.amountMatchesAsset(paysInfo, this.pair.quoteCurrency, quoteIssuer);
        if (getsIsBase && paysIsQuote) {
            return { baseDelta: getsDelta, quoteDelta: paysDelta };
        }

        const getsIsQuote = this.amountMatchesAsset(getsInfo, this.pair.quoteCurrency, quoteIssuer);
        const paysIsBase = this.amountMatchesAsset(paysInfo, this.pair.baseCurrency, baseIssuer);
        if (getsIsQuote && paysIsBase) {
            return { baseDelta: paysDelta, quoteDelta: getsDelta };
        }

        return null;
    }

    private computeDirectionalSlippageBps(
        expectedPrice: number | undefined,
        actualPrice: number,
        side: TradeSide
    ): number {
        if (!expectedPrice || expectedPrice <= 0 || !Number.isFinite(actualPrice) || actualPrice <= 0) {
            return 0;
        }
        const canonicalSide = side.toLowerCase() as 'buy' | 'sell';
        const bps = computeCanonicalSlippageBps(canonicalSide, expectedPrice, actualPrice);
        return bps == null ? 0 : Math.round(bps);
    }

    private getBboBaseline(side: 'buy' | 'sell'): number | null {
        if (side === 'buy' && this.currentBestAsk != null && this.currentBestAsk > 0) {
            return this.currentBestAsk;
        }
        if (side === 'sell' && this.currentBestBid != null && this.currentBestBid > 0) {
            return this.currentBestBid;
        }
        return null;
    }

    private normalizeQuotePerBase(value: number | null | undefined): number | null {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            return null;
        }
        return value;
    }

    private normalizeNonNegative(value: number | null | undefined): number | null {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            return null;
        }
        return value;
    }

    private resolveBaselineSpreadBps(bestBid: number | null, bestAsk: number | null): number | null {
        if (this.currentSpreadBps != null && Number.isFinite(this.currentSpreadBps)) {
            return this.currentSpreadBps;
        }
        if (bestBid == null || bestAsk == null || bestBid <= 0 || bestAsk <= 0) {
            return null;
        }
        const mid = (bestBid + bestAsk) / 2;
        if (!Number.isFinite(mid) || mid <= 0) return null;
        return ((bestAsk - bestBid) / mid) * 10_000;
    }

    private isBaselineOrderingValid(input: {
        baselineTsMs: number | null;
        decisionTsMs: number | null;
        submitTsMs: number | null;
    }): boolean {
        const { baselineTsMs, decisionTsMs, submitTsMs } = input;
        if (
            baselineTsMs != null
            && decisionTsMs != null
            && Number.isFinite(baselineTsMs)
            && Number.isFinite(decisionTsMs)
            && baselineTsMs > decisionTsMs
        ) {
            return false;
        }
        if (
            decisionTsMs != null
            && submitTsMs != null
            && Number.isFinite(decisionTsMs)
            && Number.isFinite(submitTsMs)
            && decisionTsMs > submitTsMs
        ) {
            return false;
        }
        return true;
    }

    private resolveExpectedBaseline(input: {
        side: 'buy' | 'sell';
        intentPrice: number;
        expectedPrice: number | undefined;
        decisionTsMs: number | null;
        submitTsMs?: number | null;
    }): ExpectedBaselineContext {
        const sideUpper = input.side === 'buy' ? 'BUY' : 'SELL';
        const baselineBestBid = this.normalizeQuotePerBase(this.currentBestBid);
        const baselineBestAsk = this.normalizeQuotePerBase(this.currentBestAsk);
        const baselineMid = this.normalizeQuotePerBase(
            this.currentMidPrice
            ?? (
                baselineBestBid != null && baselineBestAsk != null
                    ? (baselineBestBid + baselineBestAsk) / 2
                    : null
            )
        );
        const baselineSpreadBps = this.resolveBaselineSpreadBps(baselineBestBid, baselineBestAsk);
        const baselineBookAgeMs = this.normalizeNonNegative(this.currentBookAgeMs);
        const baselineTsMs = input.decisionTsMs ?? Date.now();
        const hintedExpected = this.normalizeQuotePerBase(input.expectedPrice);
        const intentPrice = this.normalizeQuotePerBase(input.intentPrice);

        let expectedPrice: number | null = null;
        let expectedRule: TradeExpectedRule = 'UNKNOWN';
        let expectedPriceSource: ExpectedPriceSource = 'fallback_intent';
        let slippageBaselineUsed: SlippageBaselineUsed = 'unknown';
        let baselineSource: TradeBaselineSource = 'missing';

        if (input.side === 'buy' && baselineBestAsk != null) {
            expectedPrice = baselineBestAsk;
            expectedRule = 'BUY->best_ask';
            expectedPriceSource = 'bbo';
            slippageBaselineUsed = 'best_ask';
            baselineSource = 'orderbook_snapshot';
        } else if (input.side === 'sell' && baselineBestBid != null) {
            expectedPrice = baselineBestBid;
            expectedRule = 'SELL->best_bid';
            expectedPriceSource = 'bbo';
            slippageBaselineUsed = 'best_bid';
            baselineSource = 'orderbook_snapshot';
        } else if (baselineMid != null) {
            expectedPrice = baselineMid;
            expectedRule = sideUpper === 'BUY' ? 'BUY->mid' : 'SELL->mid';
            expectedPriceSource = 'mid';
            slippageBaselineUsed = 'mid';
            baselineSource = 'fair_value';
        } else if (hintedExpected != null) {
            expectedPrice = hintedExpected;
            expectedRule = sideUpper === 'BUY' ? 'BUY->intent_price' : 'SELL->intent_price';
            expectedPriceSource = 'intent';
            slippageBaselineUsed = 'intent';
            baselineSource = 'intent_fallback';
        } else if (intentPrice != null) {
            expectedPrice = intentPrice;
            expectedRule = sideUpper === 'BUY' ? 'BUY->fallback_intent' : 'SELL->fallback_intent';
            expectedPriceSource = 'fallback_intent';
            slippageBaselineUsed = 'intent';
            baselineSource = 'intent_fallback';
        }

        const orderingValid = this.isBaselineOrderingValid({
            baselineTsMs,
            decisionTsMs: input.decisionTsMs,
            submitTsMs: input.submitTsMs ?? null,
        });

        return {
            baselineTsMs,
            baselineBestBid,
            baselineBestAsk,
            baselineMid,
            baselineSpreadBps,
            baselineSource: orderingValid ? baselineSource : 'invalid',
            expectedPrice,
            expectedRule,
            expectedPriceSource,
            slippageBaselineUsed,
            priceConvention: 'quote_per_base',
            baselineBookAgeMs,
            orderingValid,
        };
    }

    /**
     * Parse transaction metadata to extract actual fill amounts.
     * XRPL OfferCreate transactions may partially fill, and the actual amounts
     * are found in the AffectedNodes of the transaction metadata.
     * 
     * @param meta - Transaction metadata from submitAndWait result
     * @param originalTakerGets - Original TakerGets amount from the transaction
     * @param originalTakerPays - Original TakerPays amount from the transaction
     * @param expectedPrice - Expected execution price for slippage calculation
     * @returns PartialFillResult with actual fill amounts and slippage
     */
    parsePartialFill(
        meta: TransactionMetadata | undefined,
        originalTakerGets: Amount,
        originalTakerPays: Amount,
        side: TradeSide,
        expectedPrice?: number
    ): PartialFillResult {
        const originalGetsNum = this.amountToNumber(originalTakerGets);
        const originalPaysNum = this.amountToNumber(originalTakerPays);

        const intendedBaseAmount = side === 'BUY' ? originalPaysNum : originalGetsNum;
        const fallbackBase = intendedBaseAmount;
        const fallbackQuote = side === 'BUY' ? originalGetsNum : originalPaysNum;

        const buildFallback = (): PartialFillResult => {
            const effectivePrice = fallbackBase > 0 ? fallbackQuote / fallbackBase : 0;
            const slippageBps = this.computeDirectionalSlippageBps(expectedPrice, effectivePrice, side);
            return {
                takerGotAmount: side === 'BUY' ? fallbackBase : fallbackQuote,
                takerPaidAmount: side === 'BUY' ? fallbackQuote : fallbackBase,
                baseFilled: fallbackBase,
                quoteFilled: fallbackQuote,
                fillRatio: 1,
                effectivePrice,
                priceQuotePerBase: effectivePrice,
                slippageBps,
            };
        };

        // Default to full fill assumption if no metadata
        if (!meta || typeof meta === 'string' || !meta.AffectedNodes) {
            return buildFallback();
        }

        let baseFilled = 0;
        let quoteFilled = 0;

        for (const node of meta.AffectedNodes) {
            if ('ModifiedNode' in node && node.ModifiedNode.LedgerEntryType === 'Offer') {
                const modified = node.ModifiedNode;
                const prev = modified.PreviousFields;
                const final = modified.FinalFields;

                if (prev && final) {
                    const prevGetsAmount = prev.TakerGets as Amount | undefined;
                    const finalGetsAmount = final.TakerGets as Amount | undefined;
                    const prevPaysAmount = prev.TakerPays as Amount | undefined;
                    const finalPaysAmount = final.TakerPays as Amount | undefined;

                    const prevGets = prevGetsAmount ? this.amountToNumber(prevGetsAmount) : 0;
                    const finalGets = finalGetsAmount ? this.amountToNumber(finalGetsAmount) : 0;
                    const prevPays = prevPaysAmount ? this.amountToNumber(prevPaysAmount) : 0;
                    const finalPays = finalPaysAmount ? this.amountToNumber(finalPaysAmount) : 0;

                    const deltaGets = Math.max(0, prevGets - finalGets);
                    const deltaPays = Math.max(0, prevPays - finalPays);
                    const pairDelta = this.mapOfferDeltaToPairUnits(prevGetsAmount, deltaGets, prevPaysAmount, deltaPays);
                    if (pairDelta) {
                        baseFilled += pairDelta.baseDelta;
                        quoteFilled += pairDelta.quoteDelta;
                    }
                }
            }

            if ('DeletedNode' in node && node.DeletedNode.LedgerEntryType === 'Offer') {
                const deleted = node.DeletedNode;
                const prev = deleted.PreviousFields;
                const final = deleted.FinalFields;

                if (prev) {
                    const prevGetsAmount = prev.TakerGets as Amount | undefined;
                    const prevPaysAmount = prev.TakerPays as Amount | undefined;
                    const prevGets = prevGetsAmount ? this.amountToNumber(prevGetsAmount) : 0;
                    const prevPays = prevPaysAmount ? this.amountToNumber(prevPaysAmount) : 0;
                    const pairDelta = this.mapOfferDeltaToPairUnits(prevGetsAmount, prevGets, prevPaysAmount, prevPays);
                    if (pairDelta) {
                        baseFilled += pairDelta.baseDelta;
                        quoteFilled += pairDelta.quoteDelta;
                    }
                } else if (final) {
                    const finalGetsAmount = final.TakerGets as Amount | undefined;
                    const finalPaysAmount = final.TakerPays as Amount | undefined;
                    const finalGets = finalGetsAmount ? this.amountToNumber(finalGetsAmount) : 0;
                    const finalPays = finalPaysAmount ? this.amountToNumber(finalPaysAmount) : 0;
                    const pairDelta = this.mapOfferDeltaToPairUnits(finalGetsAmount, finalGets, finalPaysAmount, finalPays);
                    if (pairDelta) {
                        baseFilled += pairDelta.baseDelta;
                        quoteFilled += pairDelta.quoteDelta;
                    }
                }
            }
        }

        if (baseFilled <= 0 || quoteFilled <= 0) {
            return buildFallback();
        }

        const fillRatio = intendedBaseAmount > 0 ? Math.min(1, baseFilled / intendedBaseAmount) : 0;
        const effectivePrice = baseFilled > 0 ? quoteFilled / baseFilled : 0;
        const slippageBps = this.computeDirectionalSlippageBps(expectedPrice, effectivePrice, side);

        logger.debug({
            originalGetsNum,
            originalPaysNum,
            side,
            baseFilled,
            quoteFilled,
            fillRatio,
            effectivePrice,
            expectedPrice,
            slippageBps,
        }, 'Parsed partial fill result');

        return {
            takerGotAmount: side === 'BUY' ? baseFilled : quoteFilled,
            takerPaidAmount: side === 'BUY' ? quoteFilled : baseFilled,
            baseFilled,
            quoteFilled,
            fillRatio,
            effectivePrice,
            priceQuotePerBase: effectivePrice,
            slippageBps,
        };
    }

    /**
     * Wraps a promise with a timeout.
     * Returns the promise result or rejects with timeout error.
     */
    private withTimeout<T>(promise: Promise<T>, ms: number, context: string): Promise<T> {
        return Promise.race([
            promise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Transaction timeout after ${ms}ms (${context})`)), ms)
            ),
        ]);
    }

    private async submitTransaction(txBlob: string, txType: string): Promise<{ result: Record<string, unknown> }> {
        const xrplClient = this.client as unknown as {
            submit?: (blob: string) => Promise<{ result: Record<string, unknown> }>;
            submitAndWait?: (blob: string) => Promise<{ result: Record<string, unknown> }>;
        };

        if (typeof xrplClient.submit === 'function') {
            return this.withTimeout(
                xrplClient.submit(txBlob),
                OfferExecutor.SUBMIT_TIMEOUT_MS,
                `submit for ${txType}`,
            );
        }

        if (typeof xrplClient.submitAndWait === 'function') {
            return this.withTimeout(
                xrplClient.submitAndWait(txBlob),
                OfferExecutor.SUBMIT_TIMEOUT_MS,
                `submitAndWait for ${txType}`,
            );
        }

        throw new Error('xrpl-submit-method-missing');
    }

    // Timeout for submit RPC (12 seconds - ~3 ledger closes)
    private static readonly SUBMIT_TIMEOUT_MS = 12_000;
    private static readonly VALIDATION_LOOKUP_DEADLINE_MS = 10_000;
    private static readonly VALIDATION_POLL_INTERVAL_MS = 1_000;

    /**
     * Detect whether a fill was executed against an AMM pool or the DEX order book.
     *
     * XRPL AMM fills produce `AMM` ledger entries in `AffectedNodes`.
     * - If any AffectedNode has LedgerEntryType === 'AMM', it touched an AMM pool.
     * - If only Offer/AccountRoot/RippleState nodes, it was pure order book.
     * - Mixed fills (AMM + order book) are classified as 'mixed'.
     *
     * Returns 'amm', 'orderbook', 'mixed', or 'unknown'.
     */
    detectExecutionSource(meta: TransactionMetadata | undefined): 'amm' | 'orderbook' | 'mixed' | 'unknown' {
        if (!meta || typeof meta === 'string' || !meta.AffectedNodes) {
            return 'unknown';
        }

        let hasAmm = false;
        let hasOffer = false;

        for (const node of meta.AffectedNodes) {
            const entryType =
                ('ModifiedNode' in node ? node.ModifiedNode.LedgerEntryType : undefined) ??
                ('DeletedNode' in node ? node.DeletedNode.LedgerEntryType : undefined) ??
                ('CreatedNode' in node ? node.CreatedNode.LedgerEntryType : undefined);

            if (entryType === 'AMM') hasAmm = true;
            if (entryType === 'Offer') hasOffer = true;
        }

        if (hasAmm && hasOffer) return 'mixed';
        if (hasAmm) return 'amm';
        if (hasOffer) return 'orderbook';
        return 'unknown';
    }

    private deriveAckStatus(engineResult: string | null | undefined): 'accepted' | 'queued' | 'rejected' | 'unknown' {
        if (!engineResult || typeof engineResult !== 'string') return 'unknown';
        const normalized = engineResult.toLowerCase();
        if (normalized.startsWith('tes')) return 'accepted';
        if (normalized.startsWith('ter')) return 'queued';
        if (normalized.startsWith('tec') || normalized.startsWith('tef') || normalized.startsWith('tel') || normalized.startsWith('tem')) {
            return 'rejected';
        }
        return 'unknown';
    }

    private inferNodeEndpoint(): string | null {
        const dynamicClient = this.client as unknown as {
            connection?: { _url?: string };
            url?: string;
        };
        const fromConnection = dynamicClient.connection?._url;
        if (typeof fromConnection === 'string' && fromConnection.length > 0) {
            return fromConnection;
        }
        if (typeof dynamicClient.url === 'string' && dynamicClient.url.length > 0) {
            return dynamicClient.url;
        }
        return process.env.XRPL_WS_URL ?? null;
    }

    private toUnixMsFromRippleEpochSeconds(value: number | null | undefined): number | null {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        // XRPL "date" fields are seconds since 2000-01-01T00:00:00Z.
        return Math.floor((value + 946_684_800) * 1000);
    }

    private async waitMs(ms: number): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    private async lookupValidationByHash(params: {
        txHash: string;
        fallbackResult?: Record<string, unknown> | null;
    }): Promise<{
        validated: boolean;
        validatedTsMs: number | null;
        validatedLedgerIndex: number | null;
        validatedLedgerTime: number | null;
        transactionResult: string | null;
        meta: TransactionMetadata | undefined;
        tx: Record<string, unknown> | null;
        timeoutReason: string | null;
    }> {
        const fallbackResult = params.fallbackResult ?? null;
        const fallbackMeta = fallbackResult?.meta as TransactionMetadata | undefined;
        const fallbackTxResult = this.extractTxResult(fallbackMeta);
        const fallbackLedgerIndex = typeof fallbackResult?.ledger_index === 'number'
            ? fallbackResult.ledger_index
            : null;
        const fallbackValidated = fallbackMeta != null && fallbackTxResult != null;
        const fallbackLedgerTime = this.toUnixMsFromRippleEpochSeconds(
            typeof fallbackResult?.close_time === 'number'
                ? fallbackResult.close_time
                : (typeof fallbackResult?.date === 'number' ? fallbackResult.date : null),
        );

        if (fallbackValidated) {
            return {
                validated: true,
                validatedTsMs: Date.now(),
                validatedLedgerIndex: fallbackLedgerIndex,
                validatedLedgerTime: fallbackLedgerTime,
                transactionResult: fallbackTxResult,
                meta: fallbackMeta,
                tx: (fallbackResult?.tx_json as Record<string, unknown> | undefined) ?? null,
                timeoutReason: null,
            };
        }

        const deadlineMs = Date.now() + OfferExecutor.VALIDATION_LOOKUP_DEADLINE_MS;
        let lastError: string | null = null;

        while (Date.now() <= deadlineMs) {
            try {
                const response = await this.withTimeout(
                    this.client.request({
                        command: 'tx',
                        transaction: params.txHash,
                        binary: false,
                    } as any),
                    3_000,
                    `tx lookup ${params.txHash}`,
                );
                const txResult = response?.result as Record<string, unknown> | undefined;
                if (txResult?.validated === true) {
                    const meta = txResult.meta as TransactionMetadata | undefined;
                    return {
                        validated: true,
                        validatedTsMs: Date.now(),
                        validatedLedgerIndex: typeof txResult.ledger_index === 'number' ? txResult.ledger_index : null,
                        validatedLedgerTime: this.toUnixMsFromRippleEpochSeconds(
                            typeof txResult.date === 'number' ? txResult.date : null,
                        ),
                        transactionResult: this.extractTxResult(meta) ?? null,
                        meta,
                        tx: (txResult.tx_json as Record<string, unknown> | undefined) ?? null,
                        timeoutReason: null,
                    };
                }
            } catch (err) {
                lastError = err instanceof Error ? err.message : 'tx-lookup-failed';
            }
            await this.waitMs(OfferExecutor.VALIDATION_POLL_INTERVAL_MS);
        }

        return {
            validated: false,
            validatedTsMs: null,
            validatedLedgerIndex: null,
            validatedLedgerTime: null,
            transactionResult: fallbackTxResult ?? null,
            meta: fallbackMeta,
            tx: (fallbackResult?.tx_json as Record<string, unknown> | undefined) ?? null,
            timeoutReason: lastError ?? 'validation-timeout',
        };
    }

    // Unified submit path with logging, validation, and error handling to avoid rippled parameter errors.
    private async submitWithGuards(tx: any, pairSymbol?: string, intent?: TradeIntent, flags?: { passive?: boolean }): Promise<ExecutionResult> {
        const canonicalPair = canonicalizePairKey(
            pairSymbol ?? (intent ? `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}` : `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`)
        );
        const intentBaselinePrice = intent?.expectedPrice ?? intent?.price;
        const executionSide = intent ? (intent.side.toLowerCase() as 'buy' | 'sell') : null;
        const baselineDecisionTsSeed = Date.now();
        const expectedBaseline = (intent && executionSide)
            ? this.resolveExpectedBaseline({
                side: executionSide,
                intentPrice: intent.price,
                expectedPrice: intent.expectedPrice,
                decisionTsMs: baselineDecisionTsSeed,
            })
            : null;
        const selectedExpectedPrice = expectedBaseline?.expectedPrice ?? this.normalizeQuotePerBase(intentBaselinePrice);
        const expectedPriceSource = expectedBaseline?.expectedPriceSource ?? 'fallback_intent';
        const bboBaseline = executionSide ? this.getBboBaseline(executionSide) : null;

        // ── Execution quality trace: start ──────────────────────────────────
        let inflightTrace: InFlightTrace | null = null;
        if (this.executionQualityCollector && intent) {
            const side = intent.side.toLowerCase() as 'buy' | 'sell';
            inflightTrace = this.executionQualityCollector.createTrace({
                pairKey: canonicalPair,
                strategy: this.currentStrategy,
                side,
                arrivalMid: this.currentMidPrice ?? intent.price,
                expectedPrice: selectedExpectedPrice ?? intent.price,
                isMaker: flags?.passive ?? false,
            });
        }
        const decisionTs = inflightTrace?.trace.decisionTimeMs ?? (intent ? baselineDecisionTsSeed : null);
        let eqSubmitTimeMs: number | null = null;
        let submitResponseTsMs: number | null = null;
        let tradeId: string | null = null;
        let txHash: string | null = null;
        let nodeEndpoint: string | null = this.inferNodeEndpoint();
        let feeDrops: string | null = null;
        let sequence: number | null = null;
        let baselineContext: ExpectedBaselineContext | null = expectedBaseline
            ? {
                ...expectedBaseline,
                baselineTsMs: expectedBaseline.baselineTsMs ?? decisionTs ?? baselineDecisionTsSeed,
            }
            : null;
        let expectedPriceForRealism: number | null = baselineContext?.expectedPrice ?? selectedExpectedPrice ?? null;

        try {
            if (!this.wallet) return { accepted: false, reason: 'wallet-missing' };

            // Ensure required fields are present before autofill; Account must be set.
            if (!tx.Account) {
                tx.Account = this.wallet.classicAddress;
            }

            const safeTx = {
                ...tx,
                TakerGets: this.redactAmount(tx.TakerGets),
                TakerPays: this.redactAmount(tx.TakerPays),
            };

            logger.info({ tx: safeTx, pair: pairSymbol }, 'Preparing XRPL transaction');
            const prepared = await this.client.autofill(tx);
            const safePrepared = {
                ...prepared,
                TakerGets: this.redactAmount(prepared.TakerGets),
                TakerPays: this.redactAmount(prepared.TakerPays),
            };
            logger.info({ tx: safePrepared, pair: pairSymbol }, 'Autofilled XRPL transaction');
            const signed = this.wallet.sign(prepared);
            txHash = signed.hash;
            feeDrops = typeof prepared.Fee === 'string' ? prepared.Fee : null;
            sequence = typeof prepared.Sequence === 'number' && Number.isFinite(prepared.Sequence)
                ? prepared.Sequence
                : null;
            this.botTxHashSink?.(signed.hash);

            if (intent) {
                const pendingTrade = tradeHistory.recordTrade({
                    pair: canonicalPair,
                    side: intent.side as 'BUY' | 'SELL',
                    price: intentBaselinePrice ?? intent.price,
                    priceQuotePerBase: intentBaselinePrice ?? intent.price,
                    amount: intent.amount,
                    amountBase: intent.amount,
                    filled: 0,
                    filledBase: 0,
                    filledQuote: 0,
                    fee: 0,
                    pnl: 0,
                    hash: signed.hash,
                    paper: false,
                    status: 'PENDING',
                    source: 'bot',
                });
                tradeId = pendingTrade.id;
                tradeHistory.upsertTradeTrace({
                    hash: signed.hash,
                    tradeId,
                    patch: {
                        decision_ts_ms: decisionTs ?? pendingTrade.timestamp,
                        baseline_ts_ms: baselineContext?.baselineTsMs ?? null,
                        baseline_best_bid: baselineContext?.baselineBestBid ?? null,
                        baseline_best_ask: baselineContext?.baselineBestAsk ?? null,
                        baseline_mid: baselineContext?.baselineMid ?? null,
                        baseline_spread_bps: baselineContext?.baselineSpreadBps ?? null,
                        baseline_source: baselineContext?.baselineSource ?? null,
                        expected_price: baselineContext?.expectedPrice ?? null,
                        expected_rule: baselineContext?.expectedRule ?? null,
                        price_convention: baselineContext?.priceConvention ?? null,
                        baseline_book_age_ms: baselineContext?.baselineBookAgeMs ?? null,
                        tx_hash: signed.hash,
                        node_endpoint: nodeEndpoint,
                        fee_drops: feeDrops,
                        sequence,
                        ack_status: 'unknown',
                        outcome: 'abandoned',
                        outcome_reason: null,
                    },
                });
            }

            // ── Execution quality trace: mark submit ────────────────────────
            eqSubmitTimeMs = Date.now();
            if (baselineContext) {
                const orderingValid = this.isBaselineOrderingValid({
                    baselineTsMs: baselineContext.baselineTsMs,
                    decisionTsMs: decisionTs,
                    submitTsMs: eqSubmitTimeMs,
                });
                if (!orderingValid) {
                    logger.warn({
                        pair: canonicalPair,
                        side: executionSide,
                        baselineTsMs: baselineContext.baselineTsMs,
                        decisionTsMs: decisionTs,
                        submitTsMs: eqSubmitTimeMs,
                    }, 'Invalid baseline ordering detected; slippage realism will be flagged as NO_DATA');
                    baselineContext = {
                        ...baselineContext,
                        orderingValid: false,
                        baselineSource: 'invalid',
                    };
                }
                expectedPriceForRealism = baselineContext.orderingValid
                    ? (baselineContext.expectedPrice ?? null)
                    : null;
            } else {
                expectedPriceForRealism = null;
            }
            if (intent && signed.hash) {
                tradeHistory.upsertTradeTrace({
                    hash: signed.hash,
                    tradeId,
                    patch: {
                        submit_ts_ms: eqSubmitTimeMs,
                        baseline_source: baselineContext?.baselineSource ?? null,
                    },
                });
            }

            this.emitSubmitTelemetry({
                strategy: this.currentStrategy,
                pairKey: canonicalPair,
                stage: 'attempt',
                tradeId,
                submitTsMs: eqSubmitTimeMs,
                nodeEndpoint,
                feeDrops,
                sequence,
                txHash: signed.hash,
                baselineTsMs: baselineContext?.baselineTsMs ?? null,
                baselineBestBid: baselineContext?.baselineBestBid ?? null,
                baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                baselineMid: baselineContext?.baselineMid ?? null,
                baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                baselineSource: baselineContext?.baselineSource ?? null,
                expectedPrice: baselineContext?.expectedPrice ?? null,
                expectedRule: baselineContext?.expectedRule ?? null,
                priceConvention: baselineContext?.priceConvention ?? null,
                baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                ...(executionSide ? { side: executionSide } : {}),
                ...(typeof intent?.amount === 'number' ? { amountBase: intent.amount } : {}),
                ...(() => {
                    const intentPrice = intentBaselinePrice ?? intent?.price;
                    return typeof intentPrice === 'number' ? { intentPrice } : {};
                })(),
            });

            // Wrap submit call with timeout to prevent blocking indefinitely
            let res;
            try {
                res = await this.submitTransaction(signed.tx_blob, tx.TransactionType);
                submitResponseTsMs = Date.now();
            } catch (timeoutErr: any) {
                // Timeout does NOT mean failure - tx may still succeed
                // Log warning and return unknown finality
                logger.warn({
                    err: timeoutErr,
                    txType: tx.TransactionType,
                    pair: pairSymbol,
                    hash: signed.hash,
                }, 'Transaction timeout - finality unknown, requires reconciliation');

                submitResponseTsMs = Date.now();

                if (intent && executionSide) {
                    const latency = computeLatencyMetrics({
                        decisionTs,
                        submitTs: eqSubmitTimeMs,
                        validatedTs: null,
                    });
                    feedbackEngine.recordExecutionQualityEvent({
                        txHash: signed.hash,
                        pairKey: canonicalPair,
                        side: executionSide,
                        strategy: this.currentStrategy,
                        regime: this.currentFlowRegime,
                        source: 'bot',
                        intentPrice: intentBaselinePrice ?? intent.price,
                        expectedPrice: expectedPriceForRealism,
                        expectedPriceSource,
                        venue: 'XRPL',
                        baselineTs: baselineContext?.baselineTsMs ?? null,
                        baselineBestBid: baselineContext?.baselineBestBid ?? null,
                        baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                        baselineMid: baselineContext?.baselineMid ?? null,
                        baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                        baselineSource: baselineContext?.baselineSource ?? null,
                        expectedRule: baselineContext?.expectedRule ?? null,
                        slippageBaselineUsed: baselineContext?.slippageBaselineUsed ?? null,
                        priceConvention: baselineContext?.priceConvention ?? null,
                        baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                        fillTs: null,
                        decisionMid: this.currentMidPrice,
                        decisionBid: this.currentBestBid,
                        decisionAsk: this.currentBestAsk,
                        fillPrice: null,
                        amountBase: intent.amount,
                        filledBase: 0,
                        filledQuote: 0,
                        status: 'REJECTED',
                        rejectReason: 'timeout-unknown-finality',
                        flags: this.buildExecutionFlags(flags),
                        decisionTs,
                        submitTs: eqSubmitTimeMs,
                        submitResponseTs: submitResponseTsMs,
                        validatedTs: null,
                        submitResultEngine: null,
                        submitError: 'timeout-unknown-finality',
                        decisionToSubmitMs: latency.decisionToSubmitMs,
                        submitToValidatedMs: latency.submitToValidatedMs,
                        decisionToValidatedMs: latency.decisionToValidatedMs,
                    });
                }

                const timeoutAckTsMs = submitResponseTsMs;
                if (intent) {
                    tradeHistory.recordTrade({
                        pair: canonicalPair,
                        side: intent.side as 'BUY' | 'SELL',
                        price: intentBaselinePrice ?? intent.price,
                        priceQuotePerBase: intentBaselinePrice ?? intent.price,
                        amount: intent.amount,
                        amountBase: intent.amount,
                        filled: 0,
                        filledBase: 0,
                        filledQuote: 0,
                        fee: 0,
                        pnl: 0,
                        hash: signed.hash,
                        paper: false,
                        status: 'REJECTED',
                        source: 'bot',
                    });
                    tradeHistory.upsertTradeTrace({
                        hash: signed.hash,
                        tradeId,
                        patch: {
                            submit_ts_ms: eqSubmitTimeMs,
                            submit_response_ts_ms: submitResponseTsMs,
                            ack_ts_ms: timeoutAckTsMs,
                            submit_result: {
                                engine_result: null,
                                engine_result_code: null,
                                engine_result_message: 'timeout-unknown-finality',
                            },
                            ack_status: 'unknown',
                            outcome: 'timeout',
                            outcome_reason: 'timeout-unknown-finality',
                        },
                    });
                }

                this.emitSubmitTelemetry({
                    strategy: this.currentStrategy,
                    pairKey: canonicalPair,
                    stage: 'fail',
                    tradeId,
                    submitTsMs: eqSubmitTimeMs,
                    submitResponseTsMs: submitResponseTsMs,
                    ackTsMs: timeoutAckTsMs,
                    nodeEndpoint,
                    feeDrops,
                    sequence,
                    submitResult: {
                        engine_result: null,
                        engine_result_code: null,
                        engine_result_message: 'timeout-unknown-finality',
                    },
                    ackStatus: 'unknown',
                    txHash: signed.hash,
                    errorCode: 'timeout-unknown-finality',
                    baselineTsMs: baselineContext?.baselineTsMs ?? null,
                    baselineBestBid: baselineContext?.baselineBestBid ?? null,
                    baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                    baselineMid: baselineContext?.baselineMid ?? null,
                    baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                    baselineSource: baselineContext?.baselineSource ?? null,
                    expectedPrice: baselineContext?.expectedPrice ?? null,
                    expectedRule: baselineContext?.expectedRule ?? null,
                    priceConvention: baselineContext?.priceConvention ?? null,
                    baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                    ...(executionSide ? { side: executionSide } : {}),
                    ...(typeof intent?.amount === 'number' ? { amountBase: intent.amount } : {}),
                    ...(() => {
                        const intentPrice = intentBaselinePrice ?? intent?.price;
                        return typeof intentPrice === 'number' ? { intentPrice } : {};
                    })(),
                });

                return {
                    accepted: false,
                    reason: 'timeout-unknown-finality',
                    hash: signed.hash,
                };
            }

            logger.info({ result: res.result, pair: pairSymbol }, 'XRPL submit result');

            const submitResultRaw = res.result as unknown as Record<string, unknown>;
            const submitResultTx = submitResultRaw.tx_json as Record<string, unknown> | undefined;
            const responseTxHash = typeof submitResultRaw.hash === 'string' && submitResultRaw.hash.length > 0
                ? submitResultRaw.hash
                : (typeof submitResultTx?.hash === 'string' && submitResultTx.hash.length > 0
                    ? submitResultTx.hash
                    : signed.hash);
            txHash = responseTxHash;
            const submitResult = {
                engine_result: typeof submitResultRaw.engine_result === 'string'
                    ? submitResultRaw.engine_result
                    : (this.extractTxResult(submitResultRaw.meta as TransactionMetadata | undefined) ?? null),
                engine_result_code: typeof submitResultRaw.engine_result_code === 'number'
                    ? submitResultRaw.engine_result_code
                    : null,
                engine_result_message: typeof submitResultRaw.engine_result_message === 'string'
                    ? submitResultRaw.engine_result_message
                    : null,
            };
            const ackStatus = this.deriveAckStatus(submitResult.engine_result);
            const ackTsMs = submitResponseTsMs ?? Date.now();
            submitResponseTsMs = ackTsMs;

            if (intent) {
                tradeHistory.upsertTradeTrace({
                    hash: responseTxHash,
                    tradeId,
                    patch: {
                        tx_hash: responseTxHash,
                        submit_ts_ms: eqSubmitTimeMs,
                        submit_response_ts_ms: submitResponseTsMs,
                        ack_ts_ms: ackTsMs,
                        submit_result: submitResult,
                        ack_status: ackStatus,
                    },
                });
            }

            this.emitSubmitTelemetry({
                strategy: this.currentStrategy,
                pairKey: canonicalPair,
                stage: (ackStatus === 'accepted' || ackStatus === 'queued') ? 'success' : 'fail',
                tradeId,
                submitTsMs: eqSubmitTimeMs,
                submitResponseTsMs: submitResponseTsMs,
                ackTsMs,
                nodeEndpoint,
                feeDrops,
                sequence,
                submitResult,
                ackStatus,
                txHash: responseTxHash,
                baselineTsMs: baselineContext?.baselineTsMs ?? null,
                baselineBestBid: baselineContext?.baselineBestBid ?? null,
                baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                baselineMid: baselineContext?.baselineMid ?? null,
                baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                baselineSource: baselineContext?.baselineSource ?? null,
                expectedPrice: baselineContext?.expectedPrice ?? null,
                expectedRule: baselineContext?.expectedRule ?? null,
                priceConvention: baselineContext?.priceConvention ?? null,
                baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                ...(executionSide ? { side: executionSide } : {}),
                ...(typeof intent?.amount === 'number' ? { amountBase: intent.amount } : {}),
                ...(() => {
                    const intentPrice = intentBaselinePrice ?? intent?.price;
                    return typeof intentPrice === 'number' ? { intentPrice } : {};
                })(),
                ...(ackStatus === 'rejected'
                    ? { errorCode: submitResult.engine_result ?? 'submit-rejected' }
                    : {}),
            });

            if (intent && (ackStatus === 'accepted' || ackStatus === 'queued')) {
                this.emitTradeToastSafe({
                    type: 'ORDER_PLACED',
                    correlationId: tradeId ?? undefined,
                    side: intent.side as 'BUY' | 'SELL',
                    pair: canonicalPair,
                    baseCurrency: this.pair.baseCurrency,
                    quoteCurrency: this.pair.quoteCurrency,
                    baseAmount: intent.amount,
                    quoteAmount: intent.amount * intent.price,
                    price: intent.price,
                    timestamp: new Date().toISOString(),
                });
            }

            const validation = await this.lookupValidationByHash({
                txHash: responseTxHash,
                fallbackResult: submitResultRaw,
            });
            const txResult = validation.transactionResult ?? this.extractTxResult(validation.meta);
            const success = txResult === 'tesSUCCESS';
            const validatedTs = validation.validatedTsMs;
            const validatedLedgerIndex = validation.validatedLedgerIndex;
            const validatedLedgerTime = validation.validatedLedgerTime;
            const traceOutcome = success
                ? null
                : ((!validation.validated && !txResult)
                    ? ('timeout' as const)
                    : ('rejected' as const));
            const traceReason = success
                ? null
                : (txResult ?? validation.timeoutReason ?? 'unknown-error');

            if (intent) {
                tradeHistory.upsertTradeTrace({
                    hash: responseTxHash,
                    tradeId,
                    patch: {
                        tx_hash: responseTxHash,
                        ...(validatedTs != null ? { validated_ts_ms: validatedTs } : {}),
                        ...(validatedLedgerIndex != null ? { validated_ledger_index: validatedLedgerIndex } : {}),
                        ...(validatedLedgerTime != null ? { validated_ledger_time: validatedLedgerTime } : {}),
                        ...(traceOutcome ? { outcome: traceOutcome } : {}),
                        ...(traceReason ? { outcome_reason: traceReason } : {}),
                    },
                });
            }

            if (!success) {
                this.risk.registerFailure();

                // Record failed trade
                if (intent) {
                    tradeHistory.recordTrade({
                        pair: canonicalPair,
                        side: intent.side as 'BUY' | 'SELL',
                        price: intentBaselinePrice ?? intent.price,
                        priceQuotePerBase: intentBaselinePrice ?? intent.price,
                        amount: intent.amount,
                        amountBase: intent.amount,
                        filled: 0,
                        filledBase: 0,
                        filledQuote: 0,
                        fee: 0,
                        pnl: 0,
                        hash: responseTxHash,
                        paper: false,
                        status: 'REJECTED',
                    });

                    // Record feedback for failed trade
                    try {
                        feedbackEngine.recordTradeEvent({
                            pairKey: canonicalPair,
                            strategy: this.currentStrategy,
                            action: 'error',
                            side: intent.side.toLowerCase() as 'buy' | 'sell',
                            intentPrice: intentBaselinePrice ?? intent.price,
                            intentSizeBase: intent.amount,
                            txHash: responseTxHash,
                            resultCode: txResult ?? undefined,
                            error: txResult ?? 'unknown-error',
                            isBotTrade: true,
                            midPriceAtDecision: this.currentMidPrice ?? undefined,
                        });
                    } catch { /* feedback should never crash trading */ }

                    if (executionSide) {
                        const latency = computeLatencyMetrics({
                            decisionTs,
                            submitTs: eqSubmitTimeMs,
                            validatedTs,
                        });
                        feedbackEngine.recordExecutionQualityEvent({
                            txHash: responseTxHash ?? null,
                            pairKey: canonicalPair,
                            side: executionSide,
                            strategy: this.currentStrategy,
                            regime: this.currentFlowRegime,
                            source: 'bot',
                            intentPrice: intentBaselinePrice ?? intent.price,
                            expectedPrice: expectedPriceForRealism,
                            expectedPriceSource,
                            venue: 'XRPL',
                            baselineTs: baselineContext?.baselineTsMs ?? null,
                            baselineBestBid: baselineContext?.baselineBestBid ?? null,
                            baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                            baselineMid: baselineContext?.baselineMid ?? null,
                            baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                            baselineSource: baselineContext?.baselineSource ?? null,
                            expectedRule: baselineContext?.expectedRule ?? null,
                            slippageBaselineUsed: baselineContext?.slippageBaselineUsed ?? null,
                            priceConvention: baselineContext?.priceConvention ?? null,
                            baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                            fillTs: null,
                            decisionMid: this.currentMidPrice,
                            decisionBid: this.currentBestBid,
                            decisionAsk: this.currentBestAsk,
                            fillPrice: null,
                            amountBase: intent.amount,
                            filledBase: 0,
                            filledQuote: 0,
                            status: 'REJECTED',
                            rejectReason: txResult ?? 'unknown-error',
                            flags: this.buildExecutionFlags(flags),
                            decisionTs,
                            submitTs: eqSubmitTimeMs,
                            submitResponseTs: submitResponseTsMs,
                            validatedTs,
                            submitResultEngine: submitResult.engine_result,
                            submitError: txResult ?? 'unknown-error',
                            decisionToSubmitMs: latency.decisionToSubmitMs,
                            submitToValidatedMs: latency.submitToValidatedMs,
                            decisionToValidatedMs: latency.decisionToValidatedMs,
                        });
                    }
                }

                return { accepted: false, reason: txResult ?? validation.timeoutReason ?? 'validation-timeout', hash: responseTxHash };
            }
            this.risk.resetFailures();

            // Parse actual fill amounts from transaction metadata (P2-8: Partial fill handling)
            const meta = validation.meta;
            const fillResult = this.parsePartialFill(
                meta,
                prepared.TakerGets as Amount,
                prepared.TakerPays as Amount,
                intent?.side ?? 'BUY',
                expectedPriceForRealism ?? undefined
            );

            // Log slippage metrics for monitoring
            if (fillResult.slippageBps !== 0) {
                logger.info({
                    pair: pairSymbol,
                    expectedPrice: expectedPriceForRealism,
                    effectivePrice: fillResult.effectivePrice,
                    slippageBps: fillResult.slippageBps,
                    fillRatio: fillResult.fillRatio,
                }, 'Trade execution slippage');
            }

            // Determine trade status based on fill ratio
            let status: 'FILLED' | 'PARTIAL' = 'FILLED';
            if (fillResult.fillRatio < 1) {
                status = 'PARTIAL';
                logger.warn({
                    pair: pairSymbol,
                    fillRatio: fillResult.fillRatio,
                    baseFilled: fillResult.baseFilled,
                    quoteFilled: fillResult.quoteFilled,
                }, 'Partial fill detected');
            }

            // Record trade with actual fill amounts
            if (intent) {
                const side = intent.side.toLowerCase() as 'buy' | 'sell';
                const actualFillPrice = fillResult.effectivePrice || intent.price;
                const filledBase = fillResult.baseFilled || intent.amount;
                const filledQuote = fillResult.quoteFilled || (filledBase * actualFillPrice);
                const integrityInput = {
                    pair: canonicalPair,
                    side: intent.side as 'BUY' | 'SELL',
                    status,
                    amountBase: intent.amount,
                    filledBase,
                    filledQuote,
                    priceQuotePerBase: actualFillPrice,
                    txHash: responseTxHash,
                    source: 'bot',
                } as const;
                const integrity = validateTradeIntegrity(
                    expectedPriceForRealism != null
                        ? { ...integrityInput, expectedPrice: expectedPriceForRealism }
                        : integrityInput
                );

                if (!integrity.ok) {
                    logger.error({
                        txHash: responseTxHash,
                        pair: canonicalPair,
                        side: intent.side,
                        status,
                        amountBase: intent.amount,
                        filledBase,
                        filledQuote,
                        priceQuotePerBase: actualFillPrice,
                        expectedPrice: expectedPriceForRealism,
                        reasons: integrity.reasons,
                    }, 'Blocked corrupted fill persistence');
                    quarantineTradeRecord({
                        type: 'executor-fill-persistence-blocked',
                        txHash: responseTxHash,
                        pair: canonicalPair,
                        side: intent.side,
                        status,
                        amountBase: intent.amount,
                        filledBase,
                        filledQuote,
                        priceQuotePerBase: actualFillPrice,
                        expectedPrice: expectedPriceForRealism,
                        reasons: integrity.reasons,
                    });
                } else {
                    tradeHistory.recordTrade({
                        pair: canonicalPair,
                        side: intent.side as 'BUY' | 'SELL',
                        price: actualFillPrice,
                        priceQuotePerBase: actualFillPrice,
                        amount: intent.amount,
                        amountBase: intent.amount,
                        filled: filledBase,
                        filledBase,
                        filledQuote,
                        fee: 0.000012, // Typical XRPL transaction fee
                        pnl: 0, // P&L calculated separately by strategy
                        hash: responseTxHash,
                        paper: false,
                        status,
                        slippageBps: fillResult.slippageBps,
                    });
                }

                const hasMetaFillTs = typeof validatedLedgerTime === 'number'
                    && Number.isFinite(validatedLedgerTime)
                    && (submitResponseTsMs == null || validatedLedgerTime >= submitResponseTsMs);
                const fillTsMs = hasMetaFillTs
                    ? (validatedLedgerTime as number)
                    : (validatedTs ?? Date.now());
                if (integrity.ok) {
                    tradeHistory.upsertTradeTrace({
                        hash: responseTxHash,
                        tradeId,
                        patch: {
                            tx_hash: responseTxHash,
                            validated_ledger_index: validatedLedgerIndex,
                            validated_ledger_time: validatedLedgerTime,
                            outcome: status === 'FILLED' ? 'filled' : 'partial',
                            outcome_reason: null,
                            fill_snapshot: {
                                fill_ts_ms: fillTsMs,
                                filled_base: filledBase,
                                filled_quote: filledQuote,
                                avg_price: actualFillPrice,
                                fee: 0.000012,
                                partial: status === 'PARTIAL',
                                transaction_result: txResult ?? null,
                            },
                        },
                    });
                    if (tradeId && responseTxHash) {
                        tradeMarkoutScheduler.schedule({
                            trade_id: tradeId,
                            tx_hash: responseTxHash,
                            pair_key: canonicalPair,
                            side,
                            fill_price: actualFillPrice,
                            fill_ts_ms: fillTsMs,
                        });
                    }
                } else {
                    tradeHistory.upsertTradeTrace({
                        hash: responseTxHash,
                        tradeId,
                        patch: {
                            outcome: 'abandoned',
                            outcome_reason: 'integrity-quarantine',
                            fill_snapshot: {
                                fill_ts_ms: fillTsMs,
                                filled_base: filledBase,
                                filled_quote: filledQuote,
                                avg_price: actualFillPrice,
                                fee: 0.000012,
                                partial: status === 'PARTIAL',
                                transaction_result: txResult ?? null,
                            },
                        },
                    });
                }

                // Compute cost realism metrics
                const costMetrics = computeCostRealism({
                    side,
                    intentPrice: expectedPriceForRealism ?? intentBaselinePrice ?? intent.price,
                    fillPrice: actualFillPrice,
                    midPriceAtDecision: this.currentMidPrice,
                    ammFeeBps: null, // Populated below if AMM fill detected
                });
                const slippageBpsVsIntent = computeCanonicalSlippageBps(
                    side,
                    expectedPriceForRealism ?? NaN,
                    actualFillPrice
                );
                const slippageBpsVsMid =
                    this.currentMidPrice != null
                        ? computeCanonicalSlippageBps(side, this.currentMidPrice, actualFillPrice)
                        : null;
                const slippageBpsVsBbo =
                    bboBaseline != null
                        ? computeCanonicalSlippageBps(side, bboBaseline, actualFillPrice)
                        : null;

                warnSuspiciousSlippage({
                    slippageBps: slippageBpsVsIntent,
                    baseline: expectedPriceSource,
                    pair: canonicalPair,
                    side: intent.side,
                    txHash: responseTxHash,
                    expectedPrice: expectedPriceForRealism,
                    fillPrice: actualFillPrice,
                    bestBid: this.currentBestBid,
                    bestAsk: this.currentBestAsk,
                });
                warnSuspiciousSlippage({
                    slippageBps: slippageBpsVsMid,
                    baseline: 'mid',
                    pair: canonicalPair,
                    side: intent.side,
                    txHash: responseTxHash,
                    expectedPrice: this.currentMidPrice,
                    fillPrice: actualFillPrice,
                    bestBid: this.currentBestBid,
                    bestAsk: this.currentBestAsk,
                });
                warnSuspiciousSlippage({
                    slippageBps: slippageBpsVsBbo,
                    baseline: 'bbo',
                    pair: canonicalPair,
                    side: intent.side,
                    txHash: responseTxHash,
                    expectedPrice: bboBaseline,
                    fillPrice: actualFillPrice,
                    bestBid: this.currentBestBid,
                    bestAsk: this.currentBestAsk,
                });

                // Detect execution source (AMM vs order book)
                const fillExecutionSource = this.detectExecutionSource(meta);

                // Standard XRPL transaction fee in XRP
                const txFeeXrp = 0.000012;
                const validatedTsForMetrics = validatedTs;
                const latency = computeLatencyMetrics({
                    decisionTs,
                    submitTs: eqSubmitTimeMs,
                    validatedTs: validatedTsForMetrics,
                    fillTs: fillTsMs,
                });
                const executionFlags = [
                    ...this.buildExecutionFlags(flags),
                    `SOURCE_${fillExecutionSource.toUpperCase()}`,
                ];
                const eqMetrics = buildExecutionQualityMetrics({
                    side,
                    intentPrice: expectedPriceForRealism ?? null,
                    midAtDecision: this.currentMidPrice,
                    bboAtDecision: side === 'buy' ? this.currentBestAsk : this.currentBestBid,
                    decisionPrice: expectedPriceForRealism ?? intent.price,
                    fillPrice: actualFillPrice,
                    amountBase: intent.amount,
                    filledBase,
                    midAfter1m: null,
                    midAfter5m: null,
                });

                const executionQualityEventId = feedbackEngine.recordExecutionQualityEvent({
                    txHash: responseTxHash ?? null,
                    pairKey: canonicalPair,
                    side,
                    strategy: this.currentStrategy,
                    regime: this.currentFlowRegime,
                    source: 'bot',
                    intentPrice: intentBaselinePrice ?? intent.price,
                    expectedPrice: expectedPriceForRealism,
                    expectedPriceSource,
                    venue: 'XRPL',
                    baselineTs: baselineContext?.baselineTsMs ?? null,
                    baselineBestBid: baselineContext?.baselineBestBid ?? null,
                    baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                    baselineMid: baselineContext?.baselineMid ?? null,
                    baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                    baselineSource: baselineContext?.baselineSource ?? null,
                    expectedRule: baselineContext?.expectedRule ?? null,
                    slippageBaselineUsed: baselineContext?.slippageBaselineUsed ?? null,
                    priceConvention: baselineContext?.priceConvention ?? null,
                    baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                    fillTs: fillTsMs,
                    decisionMid: this.currentMidPrice,
                    decisionBid: this.currentBestBid,
                    decisionAsk: this.currentBestAsk,
                    fillPrice: actualFillPrice,
                    amountBase: intent.amount,
                    filledBase,
                    filledQuote,
                    slippageBpsVsIntent: expectedPriceForRealism != null
                        ? (slippageBpsVsIntent ?? eqMetrics.slippageBpsVsIntent)
                        : null,
                    slippageBpsVsMid: slippageBpsVsMid ?? eqMetrics.slippageBpsVsMid,
                    slippageBpsVsBbo: slippageBpsVsBbo ?? eqMetrics.slippageBpsVsBbo,
                    effSpreadBps: eqMetrics.effSpreadBps,
                    implShortfallQuote: eqMetrics.implShortfallQuote,
                    fillRatio: fillResult.fillRatio,
                    status,
                    rejectReason: integrity.ok ? null : integrity.reasons.join(','),
                    flags: executionFlags,
                    guardQuarantined: !integrity.ok,
                    decisionTs,
                    submitTs: eqSubmitTimeMs,
                    submitResponseTs: submitResponseTsMs,
                    validatedTs: validatedTsForMetrics,
                    submitResultEngine: submitResult.engine_result,
                    submitError: integrity.ok ? null : integrity.reasons.join(','),
                    decisionToSubmitMs: latency.decisionToSubmitMs,
                    submitToValidatedMs: latency.submitToValidatedMs,
                    decisionToValidatedMs: latency.decisionToValidatedMs,
                });
                const edgeAttributionEventId = feedbackEngine.recordEdgeAttributionEvent({
                    txHash: responseTxHash ?? null,
                    pairKey: canonicalPair,
                    side,
                    strategy: this.currentStrategy,
                    regime: this.currentFlowRegime,
                    source: 'bot',
                    midDecision: this.currentMidPrice,
                    bidDecision: this.currentBestBid,
                    askDecision: this.currentBestAsk,
                    fillPrice: actualFillPrice,
                    midFill: this.currentMidPrice,
                    baseFilled: filledBase,
                    filledQuote,
                    strategyFair: intent.expectedPrice ?? null,
                    decisionTs,
                    fillTs: fillTsMs,
                });

                if (
                    executionQualityEventId
                    && Number.isFinite(actualFillPrice)
                    && actualFillPrice > 0
                    && Number.isFinite(this.currentMidPrice)
                    && (this.currentMidPrice ?? 0) > 0
                ) {
                    const fillTs = Date.now();
                    const decisionMidForHorizon = this.currentMidPrice as number;
                    setTimeout(() => {
                        feedbackEngine.updateExecutionQualityHorizons({
                            id: executionQualityEventId,
                            pairKey: canonicalPair,
                            side,
                            fillPrice: actualFillPrice,
                            decisionMid: decisionMidForHorizon,
                            fillTs,
                        });
                    }, 65_000);
                    setTimeout(() => {
                        feedbackEngine.updateExecutionQualityHorizons({
                            id: executionQualityEventId,
                            pairKey: canonicalPair,
                            side,
                            fillPrice: actualFillPrice,
                            decisionMid: decisionMidForHorizon,
                            fillTs,
                        });
                    }, 305_000);
                }

                if (
                    edgeAttributionEventId
                    && Number.isFinite(actualFillPrice)
                    && actualFillPrice > 0
                    && Number.isFinite(this.currentMidPrice)
                    && (this.currentMidPrice ?? 0) > 0
                    && Number.isFinite(filledBase)
                    && filledBase > 0
                ) {
                    const fillTs = fillTsMs;
                    const decisionTsForHorizon = decisionTs ?? fillTsMs;
                    const decisionMidForHorizon = this.currentMidPrice as number;
                    const fillPriceForHorizon = actualFillPrice;
                    const baseFilledForHorizon = filledBase;
                    const strategyFairForHorizon = intent.expectedPrice ?? null;
                    setTimeout(() => {
                        feedbackEngine.updateEdgeAttributionHorizons({
                            id: edgeAttributionEventId,
                            pairKey: canonicalPair,
                            side,
                            midDecision: decisionMidForHorizon,
                            fillPrice: fillPriceForHorizon,
                            baseFilled: baseFilledForHorizon,
                            decisionTs: decisionTsForHorizon,
                            fillTs,
                            strategyFair: strategyFairForHorizon,
                        });
                    }, 65_000);
                    setTimeout(() => {
                        feedbackEngine.updateEdgeAttributionHorizons({
                            id: edgeAttributionEventId,
                            pairKey: canonicalPair,
                            side,
                            midDecision: decisionMidForHorizon,
                            fillPrice: fillPriceForHorizon,
                            baseFilled: baseFilledForHorizon,
                            decisionTs: decisionTsForHorizon,
                            fillTs,
                            strategyFair: strategyFairForHorizon,
                        });
                    }, 305_000);
                }

                // Record feedback for successful fill
                if (integrity.ok) {
                    try {
                    const eventId = feedbackEngine.recordTradeEvent({
                        pairKey: canonicalPair,
                        strategy: this.currentStrategy,
                        action: 'fill',
                        side,
                        intentPrice: intentBaselinePrice ?? intent.price,
                        intentSizeBase: intent.amount,
                        fillPrice: actualFillPrice,
                        fillSizeBase: fillResult.baseFilled || intent.amount,
                        fillSizeQuote: fillResult.quoteFilled || ((fillResult.baseFilled || intent.amount) * actualFillPrice),
                        txHash: responseTxHash,
                        ledgerIndex: validatedLedgerIndex ?? ((res.result as any).ledger_index ?? null),
                        resultCode: txResult ?? 'tesSUCCESS',
                        isBotTrade: true,
                        midPriceAtDecision: this.currentMidPrice ?? undefined,
                        // Cost realism fields
                        slippageBpsVsIntent: slippageBpsVsIntent ?? costMetrics.slippageBpsVsIntent,
                        slippageBpsVsMid: slippageBpsVsMid ?? costMetrics.slippageBpsVsMid,
                        slippageBpsVsBbo,
                        expectedPriceSource,
                        decisionMidPrice: this.currentMidPrice,
                        decisionBestBid: this.currentBestBid,
                        decisionBestAsk: this.currentBestAsk,
                        spreadPaidBps: costMetrics.spreadPaidBps,
                        edgeBpsVsMid: costMetrics.edgeBpsVsMid,
                        netEdgeBpsVsMid: costMetrics.netEdgeBpsVsMid,
                        txFeeXrp,
                        ammFeeBps: null, // AMM fee detection requires pool-specific data
                        fillRatio: fillResult.fillRatio,
                        isPartial: fillResult.fillRatio < 1,
                        executionSource: fillExecutionSource,
                        entrySpreadBps: this.currentSpreadBps,
                        entryFlowCombined: this.currentFlowCombined,
                        entryFlowStrength: this.currentFlowStrength,
                        entryFlowRegime: this.currentFlowRegime,
                        entryMid: this.currentMidPrice,
                        entrySignalStrength: this.currentFlowStrength,
                        entryLocalExtreme: this.currentLocalExtreme == null ? null : (this.currentLocalExtreme ? 1 : 0),
                    });

                    if (eventId) {
                        schedulePostFillSnapshots({
                            eventId,
                            getSnapshot: () => ({
                                mid: this.currentMidPrice,
                                spreadBps: this.currentSpreadBps,
                                flowCombined: this.currentFlowCombined,
                                flowStrength: this.currentFlowStrength,
                                flowRegime: this.currentFlowRegime,
                            }),
                            record1s: (snapshot) => {
                                feedbackEngine.recordPostFillSnapshot1s({
                                    id: eventId,
                                    postMid1s: snapshot.mid,
                                    postSpread1s: snapshot.spreadBps,
                                    postFlowCombined1s: snapshot.flowCombined,
                                    postFlowStrength1s: snapshot.flowStrength,
                                    postFlowRegime1s: snapshot.flowRegime,
                                    postSignal1s: snapshot.flowStrength,
                                });
                            },
                            record3s: (snapshot) => {
                                feedbackEngine.recordPostFillSnapshot3s({
                                    id: eventId,
                                    postMid3s: snapshot.mid,
                                    postSpread3s: snapshot.spreadBps,
                                    postFlowCombined3s: snapshot.flowCombined,
                                    postFlowStrength3s: snapshot.flowStrength,
                                    postFlowRegime3s: snapshot.flowRegime,
                                    postSignal3s: snapshot.flowStrength,
                                });
                            },
                        });
                    }
                    } catch { /* feedback should never crash trading */ }
                }
            }

            // ── Execution quality trace: record fill ────────────────────────
            if (inflightTrace && this.executionQualityCollector && intent) {
                try {
                    const actualFillPriceEq = fillResult.effectivePrice || intent.price;
                    const executionSource = this.detectExecutionSource(meta);
                    this.executionQualityCollector.recordFill(inflightTrace, {
                        submitTimeMs: eqSubmitTimeMs ?? Date.now(),
                        ledgerAcceptedTimeMs: Date.now(),
                        fillPrice: actualFillPriceEq,
                        postFillMid: this.currentMidPrice ?? actualFillPriceEq,
                        fillRatio: fillResult.fillRatio,
                        txHash: responseTxHash ?? null,
                        ledgerIndex: validatedLedgerIndex ?? ((res.result as any).ledger_index ?? 0),
                        executionSource,
                    });
                } catch { /* analytics should never crash trading */ }
            }

            // ── Exposure tracking: record fill for position tracking ────────
            if (this.exposureTracker && intent) {
                const fillSide = intent.side.toLowerCase() as 'buy' | 'sell';
                const fillSize = fillResult.baseFilled || intent.amount;
                this.exposureTracker.recordFill(fillSide, fillSize, canonicalPair);
            }

            if (intent) {
                const eventTimestamp = new Date().toISOString();
                const baseAmount = fillResult.baseFilled || intent.amount;
                const quoteAmount = fillResult.quoteFilled || (baseAmount * (fillResult.effectivePrice || intent.price));
                this.emitTradeToastSafe({
                    type: 'ORDER_FILLED',
                    correlationId: tradeId ?? undefined,
                    side: intent.side as 'BUY' | 'SELL',
                    pair: canonicalPair,
                    baseCurrency: this.pair.baseCurrency,
                    quoteCurrency: this.pair.quoteCurrency,
                    baseAmount,
                    quoteAmount,
                    price: fillResult.effectivePrice || intent.price,
                    timestamp: eventTimestamp,
                });
            }

            return {
                accepted: true,
                hash: responseTxHash,
                txJSON: (validation.tx ?? (res.result as any).tx_json ?? undefined),
                fillResult, // Include fill details in result
            };
        } catch (err: any) {
            logger.error({ err, txType: tx?.TransactionType, tx, pair: pairSymbol }, 'XRPL submission failed');
            submitResponseTsMs = Date.now();
            const failureAckTsMs = submitResponseTsMs;
            const failureMessage = err?.message || 'submit-failed';
            if (txHash && intent) {
                tradeHistory.upsertTradeTrace({
                    hash: txHash,
                    tradeId,
                    patch: {
                        submit_ts_ms: eqSubmitTimeMs,
                        submit_response_ts_ms: submitResponseTsMs,
                        ack_ts_ms: failureAckTsMs,
                        submit_result: {
                            engine_result: null,
                            engine_result_code: null,
                            engine_result_message: failureMessage,
                        },
                        ack_status: 'unknown',
                        outcome: 'rejected',
                        outcome_reason: failureMessage,
                    },
                });
            }
            this.emitSubmitTelemetry({
                strategy: this.currentStrategy,
                pairKey: canonicalPair,
                stage: 'fail',
                tradeId,
                submitResponseTsMs: submitResponseTsMs,
                ackTsMs: failureAckTsMs,
                nodeEndpoint,
                feeDrops,
                sequence,
                submitResult: {
                    engine_result: null,
                    engine_result_code: null,
                    engine_result_message: failureMessage,
                },
                ackStatus: 'unknown',
                txHash,
                errorCode: failureMessage,
                baselineTsMs: baselineContext?.baselineTsMs ?? null,
                baselineBestBid: baselineContext?.baselineBestBid ?? null,
                baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                baselineMid: baselineContext?.baselineMid ?? null,
                baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                baselineSource: baselineContext?.baselineSource ?? null,
                expectedPrice: baselineContext?.expectedPrice ?? null,
                expectedRule: baselineContext?.expectedRule ?? null,
                priceConvention: baselineContext?.priceConvention ?? null,
                baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                ...(executionSide ? { side: executionSide } : {}),
                ...(typeof intent?.amount === 'number' ? { amountBase: intent.amount } : {}),
                ...(() => {
                    const intentPrice = intentBaselinePrice ?? intent?.price;
                    return typeof intentPrice === 'number' ? { intentPrice } : {};
                })(),
                ...(typeof eqSubmitTimeMs === 'number' ? { submitTsMs: eqSubmitTimeMs } : {}),
            });
            this.risk.registerFailure();

            // Record error trade
            if (intent) {
                tradeHistory.recordTrade({
                    pair: canonicalPair,
                    side: intent.side as 'BUY' | 'SELL',
                    price: intentBaselinePrice ?? intent.price,
                    priceQuotePerBase: intentBaselinePrice ?? intent.price,
                    amount: intent.amount,
                    amountBase: intent.amount,
                    filled: 0,
                    filledBase: 0,
                    filledQuote: 0,
                    fee: 0,
                    pnl: 0,
                    ...(txHash ? { hash: txHash } : {}),
                    paper: false,
                    status: 'REJECTED',
                });

                // Record feedback for error
                try {
                    feedbackEngine.recordTradeEvent({
                        pairKey: canonicalPair,
                        strategy: this.currentStrategy,
                        action: 'error',
                        side: intent.side.toLowerCase() as 'buy' | 'sell',
                        intentPrice: intentBaselinePrice ?? intent.price,
                        intentSizeBase: intent.amount,
                        ...(txHash ? { txHash } : {}),
                        error: failureMessage,
                        isBotTrade: true,
                        midPriceAtDecision: this.currentMidPrice ?? undefined,
                    });
                } catch { /* feedback should never crash trading */ }

                if (executionSide) {
                    const latency = computeLatencyMetrics({
                        decisionTs: inflightTrace?.trace.decisionTimeMs ?? null,
                        submitTs: eqSubmitTimeMs,
                        validatedTs: null,
                    });
                    feedbackEngine.recordExecutionQualityEvent({
                        txHash: txHash ?? null,
                        pairKey: canonicalPair,
                        side: executionSide,
                        strategy: this.currentStrategy,
                        regime: this.currentFlowRegime,
                        source: 'bot',
                        intentPrice: intentBaselinePrice ?? intent.price,
                        expectedPrice: expectedPriceForRealism,
                        expectedPriceSource,
                        venue: 'XRPL',
                        baselineTs: baselineContext?.baselineTsMs ?? null,
                        baselineBestBid: baselineContext?.baselineBestBid ?? null,
                        baselineBestAsk: baselineContext?.baselineBestAsk ?? null,
                        baselineMid: baselineContext?.baselineMid ?? null,
                        baselineSpreadBps: baselineContext?.baselineSpreadBps ?? null,
                        baselineSource: baselineContext?.baselineSource ?? null,
                        expectedRule: baselineContext?.expectedRule ?? null,
                        slippageBaselineUsed: baselineContext?.slippageBaselineUsed ?? null,
                        priceConvention: baselineContext?.priceConvention ?? null,
                        baselineBookAgeMs: baselineContext?.baselineBookAgeMs ?? null,
                        fillTs: null,
                        decisionMid: this.currentMidPrice,
                        decisionBid: this.currentBestBid,
                        decisionAsk: this.currentBestAsk,
                        fillPrice: null,
                        amountBase: intent.amount,
                        filledBase: 0,
                        filledQuote: 0,
                        status: 'REJECTED',
                        rejectReason: failureMessage,
                        flags: this.buildExecutionFlags(flags),
                        decisionTs: inflightTrace?.trace.decisionTimeMs ?? null,
                        submitTs: eqSubmitTimeMs,
                        submitResponseTs: submitResponseTsMs,
                        validatedTs: null,
                        submitResultEngine: null,
                        submitError: failureMessage,
                        decisionToSubmitMs: latency.decisionToSubmitMs,
                        submitToValidatedMs: latency.submitToValidatedMs,
                        decisionToValidatedMs: latency.decisionToValidatedMs,
                    });
                }
            }

            return { accepted: false, reason: failureMessage, ...(txHash ? { hash: txHash } : {}) };
        }
    }

    private emitSubmitTelemetry(event: StrategySubmitTelemetryEvent): void {
        if (!this.submitTelemetrySink) return;
        try {
            this.submitTelemetrySink(event);
        } catch (err) {
            logger.debug({ err }, 'Submit telemetry sink failed');
        }
    }

    private emitTradeToastSafe(event: TradeToastEvent): void {
        if (!this.tradeToastEmitter) return;
        try {
            this.tradeToastEmitter(event);
        } catch (err) {
            logger.debug({ err }, 'Trade toast emitter failed');
        }
    }
}
