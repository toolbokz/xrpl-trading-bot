import { Client, Wallet, TransactionMetadata, Amount, IssuedCurrencyAmount, dropsToXrp } from 'xrpl';
import { ExecutionResult, OrderBookState } from '../utils/types';
import { RiskEngine } from '../risk/riskEngine';
import { StrategyConfig, TradingPair } from '../config';
import { logger } from '../analytics/logger';
import { tradeHistory } from '../analytics/tradeHistory';
import { feedbackEngine } from '../analytics/feedbackEngine';
import { computeCostRealism } from '../analytics/costRealism';
import { buildOfferCreate, TradeIntent, TradeSide, normalizeIntent } from './offerBuilder';

/**
 * Represents the actual amounts filled by an OfferCreate transaction.
 */
export interface PartialFillResult {
    /** Amount of TakerGets actually delivered */
    takerGotAmount: number;
    /** Amount of TakerPays actually delivered */
    takerPaidAmount: number;
    /** Percentage of the original order filled (0-1) */
    fillRatio: number;
    /** Effective price achieved (takerPaidAmount / takerGotAmount) */
    effectivePrice: number;
    /** Slippage from expected price in basis points (can be negative for better execution) */
    slippageBps: number;
}

export interface OfferParams {
    side: 'buy' | 'sell';
    price: number;
    amount: number;
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

export class OfferExecutor {
    private currentStrategy: string = 'unknown';
    private currentMidPrice: number | null = null;

    constructor(
        private readonly client: Client,
        private readonly wallet: Wallet | null,
        private readonly risk: RiskEngine,
        private readonly paper: boolean,
        private readonly pair: TradingPair,
        private readonly strategyConfig?: StrategyConfig
    ) { }

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
     * Check if the actual price vs expected price is within slippage tolerance
     */
    checkSlippage(expectedPrice: number, actualPrice: number, side: 'buy' | 'sell'): SlippageCheckResult {
        const maxSlippageBps = this.strategyConfig?.maxSlippageBps ?? 50;

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

    async placeOffer(params: OfferParams): Promise<ExecutionResult> {
        // Check slippage if expected price provided
        if (params.expectedPrice) {
            const slippageCheck = this.checkSlippage(params.expectedPrice, params.price, params.side);
            if (!slippageCheck.allowed) {
                logger.warn({
                    expectedPrice: params.expectedPrice,
                    actualPrice: params.price,
                    slippageBps: slippageCheck.actualSlippageBps,
                    maxSlippageBps: slippageCheck.maxSlippageBps,
                }, 'Order rejected due to slippage');

                // Record rejected trade
                tradeHistory.recordTrade({
                    pair: `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`,
                    side: params.side.toUpperCase() as 'BUY' | 'SELL',
                    price: params.price,
                    amount: params.amount,
                    filled: 0,
                    fee: 0,
                    pnl: 0,
                    paper: this.paper,
                    status: 'REJECTED',
                });

                // Record feedback event for analytics
                try {
                    feedbackEngine.recordTradeEvent({
                        pairKey: `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`,
                        strategy: this.currentStrategy,
                        action: 'reject',
                        side: params.side,
                        intentPrice: params.price,
                        intentSizeBase: params.amount,
                        error: slippageCheck.reason,
                        midPriceAtDecision: this.currentMidPrice ?? undefined,
                    });
                } catch { /* feedback should never crash trading */ }

                return { accepted: false, reason: slippageCheck.reason };
            }
        }

        const intent: TradeIntent = {
            pair: this.pair,
            side: params.side.toUpperCase() as TradeSide,
            amount: params.amount,
            price: params.price,
        };
        return this.placeOfferIntent(intent, params.flags, params.expectedPrice);
    }

    async placeOfferIntent(intent: TradeIntent, flags?: OfferParams['flags'], _expectedPrice?: number): Promise<ExecutionResult> {
        const pairSymbol = `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`;

        if (this.paper) {
            logger.info({ intent }, 'Paper trade: simulated OfferCreate');

            // Record paper trade
            tradeHistory.recordTrade({
                pair: pairSymbol,
                side: intent.side as 'BUY' | 'SELL',
                price: intent.price,
                amount: intent.amount,
                filled: intent.amount,
                fee: 0,
                pnl: 0, // P&L calculated by strategy
                paper: true,
                status: 'FILLED',
            });

            // Compute cost realism for paper trades
            const side = intent.side.toLowerCase() as 'buy' | 'sell';
            const costMetrics = computeCostRealism({
                side,
                intentPrice: intent.price,
                fillPrice: intent.price, // Paper assumes perfect fill
                midPriceAtDecision: this.currentMidPrice,
                ammFeeBps: null, // No AMM fee in paper mode
            });

            // Record feedback event for paper trades
            try {
                feedbackEngine.recordTradeEvent({
                    pairKey: pairSymbol,
                    strategy: this.currentStrategy,
                    action: 'fill',
                    side,
                    intentPrice: intent.price,
                    intentSizeBase: intent.amount,
                    fillPrice: intent.price,
                    fillSizeBase: intent.amount,
                    resultCode: 'paper-mode',
                    isBotTrade: true,
                    midPriceAtDecision: this.currentMidPrice ?? undefined,
                    // Cost realism fields
                    slippageBpsVsIntent: costMetrics.slippageBpsVsIntent,
                    slippageBpsVsMid: costMetrics.slippageBpsVsMid,
                    spreadPaidBps: costMetrics.spreadPaidBps,
                    edgeBpsVsMid: costMetrics.edgeBpsVsMid,
                    netEdgeBpsVsMid: costMetrics.netEdgeBpsVsMid,
                    txFeeXrp: 0,
                    ammFeeBps: null,
                    fillRatio: 1,
                    isPartial: false,
                });
            } catch { /* feedback should never crash trading */ }

            return { accepted: true, reason: 'paper-mode' };
        }
        if (!this.wallet) return { accepted: false, reason: 'wallet-missing' };

        if (!Number.isFinite(intent.price) || intent.price <= 0 || !Number.isFinite(intent.amount) || intent.amount <= 0) {
            return { accepted: false, reason: 'invalid-params' };
        }

        const normalized = normalizeIntent(intent);
        const txCore = buildOfferCreate(normalized);

        const tx: any = {
            ...txCore,
            TransactionType: 'OfferCreate',
            Account: this.wallet.classicAddress,
            Flags: this.mapFlags(flags),
            LastLedgerSequence: await this.computeLastLedgerSequence(),
        };
        return this.submitWithGuards(tx, normalized.pair.symbol, intent);
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
        const pairSymbol = `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`;

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
        expectedPrice?: number
    ): PartialFillResult {
        const originalGetsNum = this.amountToNumber(originalTakerGets);
        const originalPaysNum = this.amountToNumber(originalTakerPays);

        // Default to full fill assumption if no metadata
        if (!meta || typeof meta === 'string' || !meta.AffectedNodes) {
            const effectivePrice = originalGetsNum > 0 ? originalPaysNum / originalGetsNum : 0;
            const slippageBps = expectedPrice && expectedPrice > 0
                ? Math.round(((effectivePrice - expectedPrice) / expectedPrice) * 10000)
                : 0;

            return {
                takerGotAmount: originalGetsNum,
                takerPaidAmount: originalPaysNum,
                fillRatio: 1,
                effectivePrice,
                slippageBps,
            };
        }

        // Track delivered amounts from balance changes
        let takerGotAmount = 0;
        let takerPaidAmount = 0;

        // Look through AffectedNodes for balance changes that indicate fills
        // For OfferCreate, we look for:
        // - ModifiedNode on Offer entries that were consumed
        // - CreatedNode/DeletedNode for the offer itself
        // - Balance changes in AccountRoot or RippleState (trustline)

        for (const node of meta.AffectedNodes) {
            // Check for Offer nodes that were consumed (filled against)
            if ('ModifiedNode' in node && node.ModifiedNode.LedgerEntryType === 'Offer') {
                const modified = node.ModifiedNode;
                const prev = modified.PreviousFields;
                const final = modified.FinalFields;

                if (prev && final) {
                    // The difference in TakerGets/TakerPays shows how much was consumed
                    const prevGets = prev.TakerGets ? this.amountToNumber(prev.TakerGets as Amount) : 0;
                    const finalGets = final.TakerGets ? this.amountToNumber(final.TakerGets as Amount) : 0;
                    const prevPays = prev.TakerPays ? this.amountToNumber(prev.TakerPays as Amount) : 0;
                    const finalPays = final.TakerPays ? this.amountToNumber(final.TakerPays as Amount) : 0;

                    // Amount consumed = previous - final
                    takerGotAmount += Math.max(0, prevGets - finalGets);
                    takerPaidAmount += Math.max(0, prevPays - finalPays);
                }
            }

            // Check for Offer nodes that were fully consumed (deleted)
            if ('DeletedNode' in node && node.DeletedNode.LedgerEntryType === 'Offer') {
                const deleted = node.DeletedNode;
                const prev = deleted.PreviousFields;
                const final = deleted.FinalFields;

                // For deleted nodes, final fields show what remained before deletion
                // We need previous fields to know the starting amount
                if (prev) {
                    const prevGets = prev.TakerGets ? this.amountToNumber(prev.TakerGets as Amount) : 0;
                    const prevPays = prev.TakerPays ? this.amountToNumber(prev.TakerPays as Amount) : 0;

                    takerGotAmount += prevGets;
                    takerPaidAmount += prevPays;
                } else if (final) {
                    // No previous fields means entire offer was consumed
                    const finalGets = final.TakerGets ? this.amountToNumber(final.TakerGets as Amount) : 0;
                    const finalPays = final.TakerPays ? this.amountToNumber(final.TakerPays as Amount) : 0;

                    takerGotAmount += finalGets;
                    takerPaidAmount += finalPays;
                }
            }
        }

        // If we couldn't determine fill from metadata, assume full fill
        if (takerGotAmount === 0 && takerPaidAmount === 0) {
            takerGotAmount = originalGetsNum;
            takerPaidAmount = originalPaysNum;
        }

        // Calculate fill ratio based on the "gets" side (what we receive)
        const fillRatio = originalGetsNum > 0 ? Math.min(1, takerGotAmount / originalGetsNum) : 0;

        // Calculate effective price (what we paid per unit received)
        const effectivePrice = takerGotAmount > 0 ? takerPaidAmount / takerGotAmount : 0;

        // Calculate slippage in basis points
        // Positive = worse execution, negative = better execution
        const slippageBps = expectedPrice && expectedPrice > 0
            ? Math.round(((effectivePrice - expectedPrice) / expectedPrice) * 10000)
            : 0;

        logger.debug({
            originalGetsNum,
            originalPaysNum,
            takerGotAmount,
            takerPaidAmount,
            fillRatio,
            effectivePrice,
            expectedPrice,
            slippageBps,
        }, 'Parsed partial fill result');

        return {
            takerGotAmount,
            takerPaidAmount,
            fillRatio,
            effectivePrice,
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

    // Unified submit path with logging, validation, and error handling to avoid rippled parameter errors.
    private async submitWithGuards(tx: any, pairSymbol?: string, intent?: TradeIntent): Promise<ExecutionResult> {
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
                        pair: pairSymbol || `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}`,
                        side: intent.side as 'BUY' | 'SELL',
                        price: intent.price,
                        amount: intent.amount,
                        filled: 0,
                        fee: 0,
                        pnl: 0,
                        hash: res.result.hash,
                        paper: false,
                        status: 'REJECTED',
                    });

                    // Record feedback for failed trade
                    try {
                        feedbackEngine.recordTradeEvent({
                            pairKey: pairSymbol || `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}`,
                            strategy: this.currentStrategy,
                            action: 'error',
                            side: intent.side.toLowerCase() as 'buy' | 'sell',
                            intentPrice: intent.price,
                            intentSizeBase: intent.amount,
                            txHash: res.result.hash,
                            resultCode: txResult ?? undefined,
                            error: txResult ?? 'unknown-error',
                            isBotTrade: true,
                            midPriceAtDecision: this.currentMidPrice ?? undefined,
                        });
                    } catch { /* feedback should never crash trading */ }
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
                intent?.expectedPrice
            );

            // Log slippage metrics for monitoring
            if (fillResult.slippageBps !== 0) {
                logger.info({
                    pair: pairSymbol,
                    expectedPrice: intent?.expectedPrice,
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
                    takerGotAmount: fillResult.takerGotAmount,
                    takerPaidAmount: fillResult.takerPaidAmount,
                }, 'Partial fill detected');
            }

            // Record trade with actual fill amounts
            if (intent) {
                tradeHistory.recordTrade({
                    pair: pairSymbol || `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}`,
                    side: intent.side as 'BUY' | 'SELL',
                    price: fillResult.effectivePrice || intent.price,
                    amount: intent.amount,
                    filled: fillResult.takerGotAmount || intent.amount, // Use actual fill amount
                    fee: 0.000012, // Typical XRPL transaction fee
                    pnl: 0, // P&L calculated separately by strategy
                    hash: res.result.hash,
                    paper: false,
                    status,
                    slippageBps: fillResult.slippageBps,
                });

                // Compute cost realism metrics
                const side = intent.side.toLowerCase() as 'buy' | 'sell';
                const actualFillPrice = fillResult.effectivePrice || intent.price;
                const costMetrics = computeCostRealism({
                    side,
                    intentPrice: intent.price,
                    fillPrice: actualFillPrice,
                    midPriceAtDecision: this.currentMidPrice,
                    ammFeeBps: null, // TODO: detect AMM vs order book
                });

                // Standard XRPL transaction fee in XRP
                const txFeeXrp = 0.000012;

                // Record feedback for successful fill
                try {
                    feedbackEngine.recordTradeEvent({
                        pairKey: pairSymbol || `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}`,
                        strategy: this.currentStrategy,
                        action: 'fill',
                        side,
                        intentPrice: intent.price,
                        intentSizeBase: intent.amount,
                        fillPrice: actualFillPrice,
                        fillSizeBase: fillResult.takerGotAmount || intent.amount,
                        txHash: res.result.hash,
                        ledgerIndex: (res.result as any).ledger_index,
                        resultCode: txResult ?? 'tesSUCCESS',
                        isBotTrade: true,
                        midPriceAtDecision: this.currentMidPrice ?? undefined,
                        // Cost realism fields
                        slippageBpsVsIntent: costMetrics.slippageBpsVsIntent,
                        slippageBpsVsMid: costMetrics.slippageBpsVsMid,
                        spreadPaidBps: costMetrics.spreadPaidBps,
                        edgeBpsVsMid: costMetrics.edgeBpsVsMid,
                        netEdgeBpsVsMid: costMetrics.netEdgeBpsVsMid,
                        txFeeXrp,
                        ammFeeBps: null, // TODO: detect AMM vs order book
                        fillRatio: fillResult.fillRatio,
                        isPartial: fillResult.fillRatio < 1,
                    });
                } catch { /* feedback should never crash trading */ }
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
                    pair: pairSymbol || `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}`,
                    side: intent.side as 'BUY' | 'SELL',
                    price: intent.price,
                    amount: intent.amount,
                    filled: 0,
                    fee: 0,
                    pnl: 0,
                    paper: false,
                    status: 'REJECTED',
                });

                // Record feedback for error
                try {
                    feedbackEngine.recordTradeEvent({
                        pairKey: pairSymbol || `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}`,
                        strategy: this.currentStrategy,
                        action: 'error',
                        side: intent.side.toLowerCase() as 'buy' | 'sell',
                        intentPrice: intent.price,
                        intentSizeBase: intent.amount,
                        error: err?.message || 'submit-failed',
                        isBotTrade: true,
                        midPriceAtDecision: this.currentMidPrice ?? undefined,
                    });
                } catch { /* feedback should never crash trading */ }
            }

            return { accepted: false, reason: err?.message || 'submit-failed' };
        }
    }
}
