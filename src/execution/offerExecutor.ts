import { Client, Wallet, TransactionMetadata } from 'xrpl';
import { ExecutionResult, OrderBookState } from '../utils/types';
import { RiskEngine } from '../risk/riskEngine';
import { StrategyConfig, TradingPair } from '../config';
import { logger } from '../analytics/logger';
import { tradeHistory } from '../analytics/tradeHistory';
import { buildOfferCreate, TradeIntent, TradeSide, normalizeIntent } from './offerBuilder';

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
    reason?: string;
}

export class OfferExecutor {
    constructor(
        private readonly client: Client,
        private readonly wallet: Wallet | null,
        private readonly risk: RiskEngine,
        private readonly paper: boolean,
        private readonly pair: TradingPair,
        private readonly strategyConfig?: StrategyConfig
    ) { }

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
        if (this.paper) {
            logger.info({ offerSequence }, 'Paper trade: simulated cancel');
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
            const res = await this.client.submitAndWait(signed.tx_blob);
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
                }

                return { accepted: false, reason: txResult };
            }
            this.risk.resetFailures();

            // Record successful trade
            if (intent) {
                tradeHistory.recordTrade({
                    pair: pairSymbol || `${intent.pair.baseCurrency}/${intent.pair.quoteCurrency}`,
                    side: intent.side as 'BUY' | 'SELL',
                    price: intent.price,
                    amount: intent.amount,
                    filled: intent.amount, // IOC orders either fill fully or not at all in most cases
                    fee: 0.000012, // Typical XRPL transaction fee
                    pnl: 0, // P&L calculated separately by strategy
                    hash: res.result.hash,
                    paper: false,
                    status: 'FILLED',
                });
            }

            return { accepted: true, hash: res.result.hash, txJSON: (res.result as any).tx_json };
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
            }

            return { accepted: false, reason: err?.message || 'submit-failed' };
        }
    }
}
