import { Client, Wallet, TransactionMetadata, Amount, IssuedCurrencyAmount, dropsToXrp } from 'xrpl';
import { ExecutionResult, OrderBookState, PartialFillResult } from '../utils/types';
import { RiskEngine } from '../risk/riskEngine';
import { StrategyConfig, TradingPair } from '../config';
import { executionLog as logger } from '../analytics/logger';
import { tradeHistory } from '../analytics/tradeHistory';
import { feedbackEngine } from '../analytics/feedbackEngine';
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
        flowCombined: number | null;
        flowStrength: number | null;
        flowRegime: FlowRegime | null;
        localExtreme?: boolean | null;
    }): void {
        this.currentMidPrice = input.midPrice;
        this.currentBestBid = input.bestBid ?? null;
        this.currentBestAsk = input.bestAsk ?? null;
        this.currentSpreadBps = input.spreadBps;
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
        const expectedBaseline = this.resolveExpectedBaseline({
            side: normalizedSide,
            intentPrice: normalizedIntent.price,
            expectedPrice: normalizedIntent.expectedPrice,
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
                intentPrice: normalizedIntent.expectedPrice ?? normalizedIntent.price,
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
                    expectedPriceSource: expectedBaseline.source,
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
                        expectedPrice: expectedBaseline.expectedPrice,
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

    private resolveExpectedBaseline(input: {
        side: 'buy' | 'sell';
        intentPrice: number;
        expectedPrice: number | undefined;
    }): { expectedPrice: number; source: ExpectedPriceSource } {
        const expected = input.expectedPrice;
        if (expected != null && Number.isFinite(expected) && expected > 0) {
            return { expectedPrice: expected, source: 'intent' };
        }

        if (this.currentMidPrice != null && Number.isFinite(this.currentMidPrice) && this.currentMidPrice > 0) {
            return { expectedPrice: this.currentMidPrice, source: 'mid' };
        }

        const bbo = this.getBboBaseline(input.side);
        if (bbo != null) {
            return { expectedPrice: bbo, source: 'bbo' };
        }

        return { expectedPrice: input.intentPrice, source: 'fallback_intent' };
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

    // Timeout for submitAndWait (12 seconds - ~3 ledger closes)
    private static readonly SUBMIT_TIMEOUT_MS = 12_000;

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

    // Unified submit path with logging, validation, and error handling to avoid rippled parameter errors.
    private async submitWithGuards(tx: any, pairSymbol?: string, intent?: TradeIntent, flags?: { passive?: boolean }): Promise<ExecutionResult> {
        const canonicalPair = canonicalizePairKey(
            pairSymbol ?? (intent ? `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}` : `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`)
        );
        const intentBaselinePrice = intent?.expectedPrice ?? intent?.price;
        const executionSide = intent ? (intent.side.toLowerCase() as 'buy' | 'sell') : null;
        const expectedBaseline = (intent && executionSide)
            ? this.resolveExpectedBaseline({
                side: executionSide,
                intentPrice: intent.price,
                expectedPrice: intent.expectedPrice,
            })
            : null;
        const selectedExpectedPrice = expectedBaseline?.expectedPrice ?? intentBaselinePrice;
        const expectedPriceSource = expectedBaseline?.source ?? 'fallback_intent';
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
        const decisionTs = inflightTrace?.trace.decisionTimeMs ?? null;
        let eqSubmitTimeMs: number | null = null;

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
            this.botTxHashSink?.(signed.hash);

            // ── Execution quality trace: mark submit ────────────────────────
            eqSubmitTimeMs = Date.now();

            // Wrap submitAndWait with timeout to prevent blocking indefinitely
            let res;
            try {
                res = await this.withTimeout(
                    this.client.submitAndWait(signed.tx_blob),
                    OfferExecutor.SUBMIT_TIMEOUT_MS,
                    `submitAndWait for ${tx.TransactionType}`
                );
            } catch (timeoutErr: any) {
                // Timeout does NOT mean failure - tx may still succeed
                // Log warning and return unknown finality
                logger.warn({
                    err: timeoutErr,
                    txType: tx.TransactionType,
                    pair: pairSymbol,
                    hash: signed.hash,
                }, 'Transaction timeout - finality unknown, requires reconciliation');

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
                        expectedPrice: selectedExpectedPrice ?? null,
                        expectedPriceSource,
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
                        validatedTs: null,
                        decisionToSubmitMs: latency.decisionToSubmitMs,
                        submitToValidatedMs: latency.submitToValidatedMs,
                        decisionToValidatedMs: latency.decisionToValidatedMs,
                    });
                }

                return {
                    accepted: false,
                    reason: 'timeout-unknown-finality',
                    hash: signed.hash,
                };
            }

            logger.info({ result: res.result, pair: pairSymbol }, 'XRPL submitAndWait result');

            const txResult = this.extractTxResult(res.result.meta);
            const success = txResult === 'tesSUCCESS';
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
                        hash: res.result.hash,
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
                            txHash: res.result.hash,
                            resultCode: txResult ?? undefined,
                            error: txResult ?? 'unknown-error',
                            isBotTrade: true,
                            midPriceAtDecision: this.currentMidPrice ?? undefined,
                        });
                    } catch { /* feedback should never crash trading */ }

                    if (executionSide) {
                        const validatedTs = Date.now();
                        const latency = computeLatencyMetrics({
                            decisionTs,
                            submitTs: eqSubmitTimeMs,
                            validatedTs,
                        });
                        feedbackEngine.recordExecutionQualityEvent({
                            txHash: res.result.hash ?? null,
                            pairKey: canonicalPair,
                            side: executionSide,
                            strategy: this.currentStrategy,
                            regime: this.currentFlowRegime,
                            source: 'bot',
                            intentPrice: intentBaselinePrice ?? intent.price,
                            expectedPrice: selectedExpectedPrice ?? null,
                            expectedPriceSource,
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
                            validatedTs,
                            decisionToSubmitMs: latency.decisionToSubmitMs,
                            submitToValidatedMs: latency.submitToValidatedMs,
                            decisionToValidatedMs: latency.decisionToValidatedMs,
                        });
                    }
                }

                return { accepted: false, reason: txResult };
            }
            this.risk.resetFailures();

            // Parse actual fill amounts from transaction metadata (P2-8: Partial fill handling)
            const meta = res.result.meta as TransactionMetadata | undefined;
            const fillResult = this.parsePartialFill(
                meta,
                prepared.TakerGets as Amount,
                prepared.TakerPays as Amount,
                intent?.side ?? 'BUY',
                selectedExpectedPrice
            );

            // Log slippage metrics for monitoring
            if (fillResult.slippageBps !== 0) {
                logger.info({
                    pair: pairSymbol,
                    expectedPrice: selectedExpectedPrice,
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
                    txHash: res.result.hash,
                    source: 'bot',
                } as const;
                const integrity = validateTradeIntegrity(
                    selectedExpectedPrice != null
                        ? { ...integrityInput, expectedPrice: selectedExpectedPrice }
                        : integrityInput
                );

                if (!integrity.ok) {
                    logger.error({
                        txHash: res.result.hash,
                        pair: canonicalPair,
                        side: intent.side,
                        status,
                        amountBase: intent.amount,
                        filledBase,
                        filledQuote,
                        priceQuotePerBase: actualFillPrice,
                        expectedPrice: selectedExpectedPrice,
                        reasons: integrity.reasons,
                    }, 'Blocked corrupted fill persistence');
                    quarantineTradeRecord({
                        type: 'executor-fill-persistence-blocked',
                        txHash: res.result.hash,
                        pair: canonicalPair,
                        side: intent.side,
                        status,
                        amountBase: intent.amount,
                        filledBase,
                        filledQuote,
                        priceQuotePerBase: actualFillPrice,
                        expectedPrice: selectedExpectedPrice,
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
                        hash: res.result.hash,
                        paper: false,
                        status,
                        slippageBps: fillResult.slippageBps,
                    });
                }

                // Compute cost realism metrics
                const costMetrics = computeCostRealism({
                    side,
                    intentPrice: intentBaselinePrice ?? intent.price,
                    fillPrice: actualFillPrice,
                    midPriceAtDecision: this.currentMidPrice,
                    ammFeeBps: null, // Populated below if AMM fill detected
                });
                const slippageBpsVsIntent = computeCanonicalSlippageBps(
                    side,
                    intentBaselinePrice ?? intent.price,
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
                    baseline: 'intent',
                    pair: canonicalPair,
                    side: intent.side,
                    txHash: res.result.hash,
                    expectedPrice: intentBaselinePrice ?? intent.price,
                    fillPrice: actualFillPrice,
                    bestBid: this.currentBestBid,
                    bestAsk: this.currentBestAsk,
                });
                warnSuspiciousSlippage({
                    slippageBps: slippageBpsVsMid,
                    baseline: 'mid',
                    pair: canonicalPair,
                    side: intent.side,
                    txHash: res.result.hash,
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
                    txHash: res.result.hash,
                    expectedPrice: bboBaseline,
                    fillPrice: actualFillPrice,
                    bestBid: this.currentBestBid,
                    bestAsk: this.currentBestAsk,
                });

                // Detect execution source (AMM vs order book)
                const fillExecutionSource = this.detectExecutionSource(meta);

                // Standard XRPL transaction fee in XRP
                const txFeeXrp = 0.000012;
                const validatedTs = Date.now();
                const latency = computeLatencyMetrics({
                    decisionTs,
                    submitTs: eqSubmitTimeMs,
                    validatedTs,
                });
                const executionFlags = [
                    ...this.buildExecutionFlags(flags),
                    `SOURCE_${fillExecutionSource.toUpperCase()}`,
                ];
                const eqMetrics = buildExecutionQualityMetrics({
                    side,
                    intentPrice: intentBaselinePrice ?? intent.price,
                    midAtDecision: this.currentMidPrice,
                    bboAtDecision: side === 'buy' ? this.currentBestAsk : this.currentBestBid,
                    decisionPrice: selectedExpectedPrice ?? intent.price,
                    fillPrice: actualFillPrice,
                    amountBase: intent.amount,
                    filledBase,
                    midAfter1m: null,
                    midAfter5m: null,
                });

                const executionQualityEventId = feedbackEngine.recordExecutionQualityEvent({
                    txHash: res.result.hash ?? null,
                    pairKey: canonicalPair,
                    side,
                    strategy: this.currentStrategy,
                    regime: this.currentFlowRegime,
                    source: 'bot',
                    intentPrice: intentBaselinePrice ?? intent.price,
                    expectedPrice: selectedExpectedPrice ?? null,
                    expectedPriceSource,
                    decisionMid: this.currentMidPrice,
                    decisionBid: this.currentBestBid,
                    decisionAsk: this.currentBestAsk,
                    fillPrice: actualFillPrice,
                    amountBase: intent.amount,
                    filledBase,
                    filledQuote,
                    slippageBpsVsIntent: slippageBpsVsIntent ?? eqMetrics.slippageBpsVsIntent,
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
                    validatedTs,
                    decisionToSubmitMs: latency.decisionToSubmitMs,
                    submitToValidatedMs: latency.submitToValidatedMs,
                    decisionToValidatedMs: latency.decisionToValidatedMs,
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
                        txHash: res.result.hash,
                        ledgerIndex: (res.result as any).ledger_index,
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
                        submitTimeMs: eqSubmitTimeMs,
                        ledgerAcceptedTimeMs: Date.now(),
                        fillPrice: actualFillPriceEq,
                        postFillMid: this.currentMidPrice ?? actualFillPriceEq,
                        fillRatio: fillResult.fillRatio,
                        txHash: res.result.hash ?? null,
                        ledgerIndex: (res.result as any).ledger_index ?? 0,
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
                    type: 'ORDER_PLACED',
                    side: intent.side as 'BUY' | 'SELL',
                    pair: canonicalPair,
                    baseCurrency: this.pair.baseCurrency,
                    quoteCurrency: this.pair.quoteCurrency,
                    baseAmount: intent.amount,
                    quoteAmount: intent.amount * intent.price,
                    price: intent.price,
                    timestamp: eventTimestamp,
                });
                this.emitTradeToastSafe({
                    type: 'ORDER_FILLED',
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
                hash: res.result.hash,
                txJSON: (res.result as any).tx_json,
                fillResult, // Include fill details in result
            };
        } catch (err: any) {
            logger.error({ err, txType: tx?.TransactionType, tx, pair: pairSymbol }, 'XRPL submission failed');
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
                        error: err?.message || 'submit-failed',
                        isBotTrade: true,
                        midPriceAtDecision: this.currentMidPrice ?? undefined,
                    });
                } catch { /* feedback should never crash trading */ }

                if (executionSide) {
                    const failedAt = Date.now();
                    const latency = computeLatencyMetrics({
                        decisionTs: inflightTrace?.trace.decisionTimeMs ?? null,
                        submitTs: eqSubmitTimeMs,
                        validatedTs: failedAt,
                    });
                    feedbackEngine.recordExecutionQualityEvent({
                        txHash: null,
                        pairKey: canonicalPair,
                        side: executionSide,
                        strategy: this.currentStrategy,
                        regime: this.currentFlowRegime,
                        source: 'bot',
                        intentPrice: intentBaselinePrice ?? intent.price,
                        expectedPrice: selectedExpectedPrice ?? null,
                        expectedPriceSource,
                        decisionMid: this.currentMidPrice,
                        decisionBid: this.currentBestBid,
                        decisionAsk: this.currentBestAsk,
                        fillPrice: null,
                        amountBase: intent.amount,
                        filledBase: 0,
                        filledQuote: 0,
                        status: 'REJECTED',
                        rejectReason: err?.message || 'submit-failed',
                        flags: this.buildExecutionFlags(flags),
                        decisionTs: inflightTrace?.trace.decisionTimeMs ?? null,
                        submitTs: eqSubmitTimeMs,
                        validatedTs: failedAt,
                        decisionToSubmitMs: latency.decisionToSubmitMs,
                        submitToValidatedMs: latency.submitToValidatedMs,
                        decisionToValidatedMs: latency.decisionToValidatedMs,
                    });
                }
            }

            return { accepted: false, reason: err?.message || 'submit-failed' };
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
