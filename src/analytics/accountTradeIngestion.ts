import { TransactionMetadata, TransactionStream, isDeletedNode, isModifiedNode } from 'xrpl';
import type { TradingPair } from '../config';
import { logger } from './logger';
import { tradeHistory } from './tradeHistory';

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
}

interface PairMatch {
    baseAmount: number;
    quoteAmount: number;
    takerReceivesBase: boolean;
}

/**
 * Ingests account-level OfferCreate fills from XRPL transaction stream.
 * Writes fills into tradeHistory with explicit source tagging:
 * - source='bot' for runtime-submitted hashes
 * - source='manual' for external/Xaman/manual submissions
 */
export class AccountTradeIngestionService {
    private pair: TradingPair;
    private walletAddress: string | null;
    private readonly seenHashes = new Map<string, number>();
    private readonly botHashes = new Map<string, number>();
    private readonly maxTrackedHashes: number;

    constructor(pair: TradingPair, walletAddress: string | null, maxTrackedHashes = 5000) {
        this.pair = pair;
        this.walletAddress = walletAddress;
        this.maxTrackedHashes = Math.max(100, maxTrackedHashes);
    }

    setPair(pair: TradingPair): void {
        this.pair = pair;
    }

    setWalletAddress(walletAddress: string | null): void {
        this.walletAddress = walletAddress;
    }

    registerBotTxHash(hash: string | null | undefined): void {
        if (!hash) return;
        this.remember(this.botHashes, hash);
    }

    reset(): void {
        this.seenHashes.clear();
        this.botHashes.clear();
    }

    processTransaction(tx: TransactionStream): void {
        if (!this.walletAddress) return;
        if (tx.transaction?.TransactionType !== 'OfferCreate') return;
        if (!tx.validated) return;
        if (!tx.meta || typeof tx.meta === 'string') return;
        if (tx.transaction.Account !== this.walletAddress) return;

        const hash = tx.transaction.hash;
        if (!hash || this.seenHashes.has(hash)) return;

        const meta = tx.meta as TransactionMetadata;
        const txResult = meta.TransactionResult;
        if (txResult !== 'tesSUCCESS') {
            this.remember(this.seenHashes, hash);
            return;
        }

        if (tradeHistory.hasTradeHash(hash)) {
            this.remember(this.seenHashes, hash);
            return;
        }

        const fill = this.extractFill(meta);
        if (!fill) return;

        const intendedBaseAmount = this.getIntendedBaseAmount(tx.transaction as {
            TakerGets?: Amount;
            TakerPays?: Amount;
        }, fill.takerReceivesBase);
        const fillRatio = intendedBaseAmount > 0 ? Math.max(0, Math.min(1, fill.baseAmount / intendedBaseAmount)) : 1;
        const pairKey = `${this.pair.baseCurrency}/${this.pair.quoteCurrency}`;
        const source = this.botHashes.has(hash) ? 'bot' : 'manual';

        tradeHistory.recordTrade({
            pair: pairKey,
            side: fill.takerReceivesBase ? 'BUY' : 'SELL',
            price: fill.quoteAmount / fill.baseAmount,
            amount: intendedBaseAmount > 0 ? intendedBaseAmount : fill.baseAmount,
            filled: fill.baseAmount,
            fee: 0,
            pnl: 0,
            hash,
            paper: false,
            status: fillRatio < 0.999 ? 'PARTIAL' : 'FILLED',
            source,
        });

        this.remember(this.seenHashes, hash);
        logger.info({
            hash,
            pair: pairKey,
            side: fill.takerReceivesBase ? 'BUY' : 'SELL',
            filled: fill.baseAmount,
            price: fill.quoteAmount / fill.baseAmount,
            source,
        }, 'Account-level fill ingested');
    }

    private extractFill(meta: TransactionMetadata): PairMatch | null {
        let baseAmount = 0;
        let quoteAmount = 0;
        let takerReceivesBase: boolean | null = null;

        const nodes = meta.AffectedNodes ?? [];
        for (const node of nodes) {
            let fields: OfferFields | null = null;
            let previousFields: Partial<OfferFields> | null = null;

            if (isDeletedNode(node) && node.DeletedNode.LedgerEntryType === 'Offer') {
                fields = node.DeletedNode.FinalFields as unknown as OfferFields;
                previousFields = (node.DeletedNode.PreviousFields as unknown as Partial<OfferFields>) ?? null;
            } else if (isModifiedNode(node) && node.ModifiedNode.LedgerEntryType === 'Offer') {
                fields = node.ModifiedNode.FinalFields as unknown as OfferFields;
                previousFields = (node.ModifiedNode.PreviousFields as unknown as Partial<OfferFields>) ?? null;
            }
            if (!fields || !previousFields?.TakerGets || !previousFields?.TakerPays) continue;

            const filledGets = this.subtractAmounts(previousFields.TakerGets, fields.TakerGets);
            const filledPays = this.subtractAmounts(previousFields.TakerPays, fields.TakerPays);
            if (filledGets <= 0 || filledPays <= 0) continue;

            const match = this.matchPair(
                this.reconstructAmount(previousFields.TakerGets, filledGets),
                this.reconstructAmount(previousFields.TakerPays, filledPays),
            );
            if (!match) continue;

            if (takerReceivesBase == null) {
                takerReceivesBase = match.takerReceivesBase;
            }
            if (takerReceivesBase !== match.takerReceivesBase) {
                continue;
            }

            baseAmount += match.baseAmount;
            quoteAmount += match.quoteAmount;
        }

        if (baseAmount <= 0 || quoteAmount <= 0 || takerReceivesBase == null) {
            return null;
        }

        return { baseAmount, quoteAmount, takerReceivesBase };
    }

    private getIntendedBaseAmount(tx: { TakerGets?: Amount; TakerPays?: Amount }, takerReceivesBase: boolean): number {
        const amount = takerReceivesBase ? tx.TakerGets : tx.TakerPays;
        const parsed = this.parseAmount(amount as Amount);
        if (!parsed) return 0;

        const baseCurrency = this.pair.baseCurrency.toUpperCase();
        const baseIssuer = this.pair.baseIssuer ?? this.pair.issuer;
        return this.currencyMatches(parsed, baseCurrency, baseIssuer) ? parsed.value : 0;
    }

    private matchPair(takerGets: Amount, takerPays: Amount): PairMatch | null {
        const getsInfo = this.parseAmount(takerGets);
        const paysInfo = this.parseAmount(takerPays);
        if (!getsInfo || !paysInfo) return null;

        const baseCurrency = this.pair.baseCurrency.toUpperCase();
        const quoteCurrency = this.pair.quoteCurrency.toUpperCase();
        const baseIssuer = this.pair.baseIssuer ?? this.pair.issuer;
        const quoteIssuer = this.pair.quoteIssuer ?? this.pair.issuer;

        const getsIsBase = this.currencyMatches(getsInfo, baseCurrency, baseIssuer);
        const paysIsQuote = this.currencyMatches(paysInfo, quoteCurrency, quoteIssuer);
        if (getsIsBase && paysIsQuote) {
            return {
                baseAmount: getsInfo.value,
                quoteAmount: paysInfo.value,
                takerReceivesBase: true,
            };
        }

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

    private parseAmount(amount: Amount): { currency: string; issuer: string | undefined; value: number } | null {
        if (!amount) return null;

        if (typeof amount === 'string') {
            const drops = parseInt(amount, 10);
            if (!Number.isFinite(drops) || drops <= 0) return null;
            return { currency: 'XRP', issuer: undefined, value: drops / 1_000_000 };
        }

        if (typeof amount.currency !== 'string' || typeof amount.value !== 'string') return null;
        const value = parseFloat(amount.value);
        if (!Number.isFinite(value) || value <= 0) return null;

        let currency = amount.currency.toUpperCase();
        if (currency.length === 40 && /^[0-9A-F]+$/.test(currency)) {
            const decoded = Buffer.from(currency, 'hex').toString('ascii').replace(/\0/g, '').trim();
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

    private currencyMatches(
        info: { currency: string; issuer: string | undefined; value: number },
        currency: string,
        issuer?: string
    ): boolean {
        if (info.currency !== currency) return false;
        if (currency === 'XRP') return true;
        return info.issuer === issuer;
    }

    private subtractAmounts(a: Amount, b: Amount): number {
        const aVal = typeof a === 'string' ? parseInt(a, 10) / 1_000_000 : parseFloat(a.value);
        const bVal = typeof b === 'string' ? parseInt(b, 10) / 1_000_000 : parseFloat(b.value);
        if (!Number.isFinite(aVal) || !Number.isFinite(bVal)) return 0;
        return aVal - bVal;
    }

    private reconstructAmount(template: Amount, value: number): Amount {
        if (typeof template === 'string') {
            return Math.max(0, Math.round(value * 1_000_000)).toString();
        }
        const amount: XRPLAmount = {
            currency: template.currency,
            value: value.toString(),
        };
        if (template.issuer) {
            amount.issuer = template.issuer;
        }
        return amount;
    }

    private remember(target: Map<string, number>, hash: string): void {
        target.set(hash, Date.now());
        while (target.size > this.maxTrackedHashes) {
            const oldest = target.keys().next().value as string | undefined;
            if (!oldest) break;
            target.delete(oldest);
        }
    }
}
