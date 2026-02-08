/**
 * Trade Tape Service
 * 
 * Listens to XRPL transaction events and extracts executed trades from
 * offer crossings in transaction metadata. Normalizes them into Trade objects
 * and pushes to TradeTape.
 * 
 * XRPL Trade Parsing Notes:
 * - Trades occur when offers cross (taker fills maker orders)
 * - AffectedNodes contains ModifiedNode/DeletedNode for Offer objects
 * - When an Offer is crossed, FinalFields vs PreviousFields shows the fill
 * - The "taker" is the account that submitted the OfferCreate transaction
 * - Side is inferred from whether taker receives base or quote currency
 */

import { TransactionStream, TransactionMetadata, isModifiedNode, isDeletedNode } from 'xrpl';
import { TradingPair } from '../config';
import { TradeTape, Trade, TradeSide } from './tradeTape';
import { logger } from '../analytics/logger';
import EventEmitter from 'events';

// ─────────────────────────────────────────────────────────────────────────────
// Types for XRPL Metadata Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface XRPLAmount {
    currency: string;
    issuer?: string;
    value: string;
}

type Amount = string | XRPLAmount;

interface OfferFields {
    Account: string;
    TakerGets: Amount;
    TakerPays: Amount;
    Sequence?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Emitter for Real-time Updates
// ─────────────────────────────────────────────────────────────────────────────

export type TradeTapeEvents = {
    trade: (trade: Trade) => void;
};

class TradeTapeEventEmitter extends EventEmitter {
    emitTrade(trade: Trade): void {
        this.emit('trade', trade);
    }

    onTrade(listener: (trade: Trade) => void): void {
        this.on('trade', listener);
    }

    offTrade(listener: (trade: Trade) => void): void {
        this.off('trade', listener);
    }
}

// Global event emitter for SSE streaming
export const tradeTapeEvents = new TradeTapeEventEmitter();

// ─────────────────────────────────────────────────────────────────────────────
// TradeTapeService
// ─────────────────────────────────────────────────────────────────────────────

export class TradeTapeService {
    private tape: TradeTape;
    private pair: TradingPair;
    private botAddress: string | null;
    private enabled: boolean;

    constructor(tape: TradeTape, pair: TradingPair, botAddress: string | null = null) {
        this.tape = tape;
        this.pair = pair;
        this.botAddress = botAddress;
        this.enabled = process.env.TRADE_TAPE_ENABLED !== 'false';

        if (!this.enabled) {
            logger.info('TradeTapeService disabled via TRADE_TAPE_ENABLED=false');
        }
    }

    /**
     * Process an incoming XRPL transaction stream event.
     * Extracts trades from offer crossings and adds to tape.
     */
    processTransaction(tx: TransactionStream): void {
        if (!this.enabled) return;

        try {
            // Only process validated OfferCreate transactions
            if (tx.transaction?.TransactionType !== 'OfferCreate') return;
            if (!tx.validated) return;
            if (!tx.meta || typeof tx.meta === 'string') return;

            const meta = tx.meta as TransactionMetadata;
            const txHash = tx.transaction.hash ?? '';
            const ledgerIndex = tx.ledger_index ?? 0;
            const takerAccount = tx.transaction.Account;

            // Extract trades from affected nodes
            const trades = this.extractTradesFromMeta(meta, txHash, ledgerIndex, takerAccount);

            for (const trade of trades) {
                const added = this.tape.add(trade);
                if (added) {
                    // Emit for SSE streaming (backend HTTP server subscribes)
                    tradeTapeEvents.emitTrade(trade);
                }
            }
        } catch (err) {
            logger.warn({ err, tx: tx.transaction?.hash }, 'TradeTapeService: error processing transaction');
        }
    }

    /**
     * Update the active trading pair.
     */
    setPair(pair: TradingPair): void {
        this.pair = pair;
        this.tape.setPair(pair);
    }

    /**
     * Check if the service is enabled.
     */
    isEnabled(): boolean {
        return this.enabled;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Extract trades from transaction metadata by finding offer crossings.
     * 
     * When an OfferCreate crosses existing offers:
     * 1. ModifiedNode: Offer partially filled (PreviousFields → FinalFields delta)
     * 2. DeletedNode: Offer fully filled (FinalFields shows final state before deletion)
     */
    private extractTradesFromMeta(
        meta: TransactionMetadata,
        txHash: string,
        ledgerIndex: number,
        _takerAccount: string
    ): Trade[] {
        const trades: Trade[] = [];
        const affectedNodes = meta.AffectedNodes ?? [];
        const pairKey = `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`;
        const ts = Date.now(); // Use current time; could also parse close_time from ledger

        let tradeIndex = 0;

        for (const node of affectedNodes) {
            // Look for Offer objects that were modified or deleted (crossed)
            let fields: OfferFields | null = null;
            let previousFields: Partial<OfferFields> | null = null;
            let isFullFill = false;

            if (isDeletedNode(node) && node.DeletedNode.LedgerEntryType === 'Offer') {
                // Fully filled offer
                fields = node.DeletedNode.FinalFields as unknown as OfferFields;
                previousFields = (node.DeletedNode.PreviousFields as unknown as Partial<OfferFields>) ?? null;
                isFullFill = true;
            } else if (isModifiedNode(node) && node.ModifiedNode.LedgerEntryType === 'Offer') {
                // Partially filled offer
                fields = node.ModifiedNode.FinalFields as unknown as OfferFields;
                previousFields = (node.ModifiedNode.PreviousFields as unknown as Partial<OfferFields>) ?? null;
            }

            if (!fields) continue;

            // Skip self-trades if configured
            if (TradeTape.shouldIgnoreSelfTrades() && fields.Account === this.botAddress) {
                continue;
            }

            // Calculate the fill amount
            const fill = this.calculateFill(fields, previousFields, isFullFill);
            if (!fill) continue;

            // Check if this trade matches our trading pair
            const match = this.matchPair(fill.takerGets, fill.takerPays);
            if (!match) continue;

            // Determine trade side from taker's perspective
            // If taker receives base currency, they're buying (bid was hit)
            // If taker receives quote currency, they're selling (ask was lifted)
            const side: TradeSide = match.takerReceivesBase ? 'buy' : 'sell';

            // Calculate price as quote/base
            const price = match.quoteAmount / match.baseAmount;

            const trade: Trade = {
                id: `${txHash}:${tradeIndex}`,
                ts,
                pairKey,
                price,
                sizeBase: match.baseAmount,
                sizeQuote: match.quoteAmount,
                side,
                txHash,
                ledgerIndex,
            };

            trades.push(trade);
            tradeIndex++;
        }

        if (trades.length > 0) {
            logger.debug({ txHash, tradeCount: trades.length }, 'TradeTapeService: extracted trades');
        }

        return trades;
    }

    /**
     * Calculate the fill amount from offer fields.
     * 
     * For DeletedNode with PreviousFields: Previous - Final = filled amount
     * For DeletedNode without PreviousFields: entire offer filled in one shot (use FinalFields)
     * For ModifiedNode: Previous - Final = filled amount (partial fill)
     */
    private calculateFill(
        fields: OfferFields,
        previousFields: Partial<OfferFields> | null,
        isFullFill: boolean
    ): { takerGets: Amount; takerPays: Amount } | null {
        // If we have PreviousFields, always compute the delta (both deleted and modified nodes)
        if (previousFields?.TakerGets && previousFields?.TakerPays) {
            const filledGets = this.subtractAmounts(previousFields.TakerGets, fields.TakerGets);
            const filledPays = this.subtractAmounts(previousFields.TakerPays, fields.TakerPays);

            if (filledGets <= 0 || filledPays <= 0) {
                return null;
            }

            return {
                takerGets: this.reconstructAmount(previousFields.TakerGets, filledGets),
                takerPays: this.reconstructAmount(previousFields.TakerPays, filledPays),
            };
        }

        if (isFullFill) {
            // No PreviousFields — offer was created and fully consumed in the same ledger
            // FinalFields contains the entire amount
            return {
                takerGets: fields.TakerGets,
                takerPays: fields.TakerPays,
            };
        }

        // ModifiedNode without PreviousFields — shouldn't happen, but bail
        return null;
    }

    /**
     * Match the trade against our trading pair.
     * Returns normalized base/quote amounts and direction.
     */
    private matchPair(takerGets: Amount, takerPays: Amount): {
        baseAmount: number;
        quoteAmount: number;
        takerReceivesBase: boolean;
    } | null {
        const getsInfo = this.parseAmount(takerGets);
        const paysInfo = this.parseAmount(takerPays);

        if (!getsInfo || !paysInfo) return null;

        const baseCurrency = this.pair.baseCurrency.toUpperCase();
        const quoteCurrency = this.pair.quoteCurrency.toUpperCase();
        const baseIssuer = this.pair.baseIssuer ?? this.pair.issuer;
        const quoteIssuer = this.pair.quoteIssuer ?? this.pair.issuer;

        // Debug logging for pair matching
        logger.debug({
            getsInfo: { currency: getsInfo.currency, issuer: getsInfo.issuer?.slice(0, 8) },
            paysInfo: { currency: paysInfo.currency, issuer: paysInfo.issuer?.slice(0, 8) },
            expected: { base: baseCurrency, quote: quoteCurrency, baseIssuer: baseIssuer?.slice(0, 8), quoteIssuer: quoteIssuer?.slice(0, 8) }
        }, 'TradeTape: matchPair check');

        // Check if takerGets is base (taker buys base = bid hit)
        const getsIsBase = this.currencyMatches(getsInfo, baseCurrency, baseIssuer);
        const paysIsQuote = this.currencyMatches(paysInfo, quoteCurrency, quoteIssuer);

        if (getsIsBase && paysIsQuote) {
            return {
                baseAmount: getsInfo.value,
                quoteAmount: paysInfo.value,
                takerReceivesBase: true,
            };
        }

        // Check if takerGets is quote (taker sells base = ask lifted)
        const getsIsQuote = this.currencyMatches(getsInfo, quoteCurrency, quoteIssuer);
        const paysIsBase = this.currencyMatches(paysInfo, baseCurrency, baseIssuer);

        if (getsIsQuote && paysIsBase) {
            return {
                baseAmount: paysInfo.value,
                quoteAmount: getsInfo.value,
                takerReceivesBase: false,
            };
        }

        return null;
    }

    /**
     * Parse an XRPL amount into normalized form.
     * Handles hex-encoded currency codes (e.g., RLUSD = 524C555344000000000000000000000000000000)
     */
    private parseAmount(amount: Amount): { currency: string; issuer: string | undefined; value: number } | null {
        if (typeof amount === 'string') {
            // XRP in drops
            const drops = parseInt(amount, 10);
            if (isNaN(drops)) return null;
            return { currency: 'XRP', issuer: undefined, value: drops / 1_000_000 };
        }

        const value = parseFloat(amount.value);
        if (isNaN(value) || value <= 0) return null;

        // Normalize currency code - decode hex if needed
        let currency = amount.currency.toUpperCase();

        // If it's a 40-character hex string, try to decode it
        if (currency.length === 40 && /^[0-9A-F]+$/.test(currency)) {
            // Decode hex to ASCII, stripping null bytes
            const decoded = Buffer.from(currency, 'hex')
                .toString('ascii')
                .replace(/\0/g, '')
                .trim();
            if (decoded.length > 0 && decoded.length <= 20) {
                currency = decoded.toUpperCase();
            }
        }

        return {
            currency,
            issuer: amount.issuer,
            value,
        };
    }

    /**
     * Check if a currency matches (including issuer for non-XRP).
     */
    private currencyMatches(
        info: { currency: string; issuer: string | undefined; value: number },
        currency: string,
        issuer?: string
    ): boolean {
        if (info.currency !== currency) return false;

        // XRP doesn't have an issuer
        if (currency === 'XRP') return true;

        // Issued currencies must match issuer
        return info.issuer === issuer;
    }

    /**
     * Subtract two amounts (assuming same currency).
     */
    private subtractAmounts(a: Amount, b: Amount): number {
        const aVal = typeof a === 'string' ? parseInt(a, 10) / 1_000_000 : parseFloat(a.value);
        const bVal = typeof b === 'string' ? parseInt(b, 10) / 1_000_000 : parseFloat(b.value);
        return aVal - bVal;
    }

    /**
     * Reconstruct an Amount object with a new value.
     */
    private reconstructAmount(template: Amount, newValue: number): Amount {
        if (typeof template === 'string') {
            return Math.round(newValue * 1_000_000).toString();
        }
        const result: XRPLAmount = {
            currency: template.currency,
            value: newValue.toString(),
        };
        if (template.issuer) {
            result.issuer = template.issuer;
        }
        return result;
    }
}
