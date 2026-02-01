import {
    AccountSet,
    Client,
    OfferCancel,
    OfferCreate,
    Payment,
    TrustSet,
    Wallet,
    TransactionMetadata,
} from 'xrpl';
import { logger } from '../analytics/logger';

export interface TransactionEngineOptions {
    client: Client;
    wallet: Wallet | null;
    paperMode?: boolean;
    maxRetries?: number;
    backoffMs?: number;
}

export interface SubmitResult {
    hash?: string;
    accepted: boolean;
    result?: string;
    partialFill?: boolean;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1_000;

export class TransactionEngine {
    private sequence: number | null = null;
    private readonly paperMode: boolean;
    private readonly maxRetries: number;
    private readonly backoffMs: number;

    constructor(private readonly opts: TransactionEngineOptions) {
        this.paperMode = Boolean(opts.paperMode);
        this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
        if (!opts.wallet && !this.paperMode) {
            throw new Error('Wallet must be initialized unless in paper mode');
        }
    }

    async submitTransaction<T extends OfferCreate | Payment | TrustSet | AccountSet | OfferCancel>(tx: T): Promise<SubmitResult> {
        return this.send(tx);
    }

    async submitOfferCreate(tx: OfferCreate): Promise<SubmitResult> {
        return this.send(tx);
    }

    async submitPayment(tx: Payment): Promise<SubmitResult> {
        return this.send(tx);
    }

    async submitTrustSet(tx: TrustSet): Promise<SubmitResult> {
        return this.send(tx);
    }

    // Cancels stale offers by sequence.
    async cancelOffer(offerSequence: number): Promise<SubmitResult> {
        const tx: OfferCancel = {
            TransactionType: 'OfferCancel',
            Account: this.requireWallet().classicAddress,
            OfferSequence: offerSequence,
        };
        return this.send(tx);
    }

    private async send<T extends OfferCreate | Payment | TrustSet | AccountSet | OfferCancel>(tx: T): Promise<SubmitResult> {
        if (this.paperMode) {
            logger.info({ tx }, 'Paper mode enabled: skipping submit');
            return { accepted: true, result: 'paper-mode' };
        }

        const wallet = this.requireWallet();
        await this.ensureSequence(wallet.classicAddress);

        // Ensure sequence and common fields are set; autofill will patch fees & LastLedgerSequence.
        const preparedBase = { ...tx, Account: wallet.classicAddress, Sequence: this.sequence ?? undefined } as T;
        logger.info({ tx: preparedBase }, 'Preparing XRPL transaction');

        let attempt = 0;
        let lastError: unknown;
        while (attempt <= this.maxRetries) {
            try {
                const prepared = await this.opts.client.autofill(preparedBase);
                logger.info({ tx: prepared }, 'Autofilled XRPL transaction');
                const signed = wallet.sign(prepared);
                logger.info({ txType: prepared.TransactionType, seq: prepared.Sequence }, 'Submitting transaction');
                const res = await this.opts.client.submitAndWait(signed.tx_blob);
                logger.info({ result: res.result }, 'SubmitAndWait result');
                this.sequence = (prepared.Sequence || this.sequence || 0) + 1;

                const txResult = this.extractResult(res.result.meta);
                const partialFill = this.detectPartialFill(prepared.TransactionType, res.result.meta);
                const accepted = txResult === 'tesSUCCESS';
                if (!accepted) {
                    throw new Error(txResult || 'Transaction failed');
                }
                return { accepted, hash: res.result.hash, result: txResult, partialFill };
            } catch (err: any) {
                lastError = err;
                const code = err?.data?.error || err?.name || err?.message;
                // Retry on transient codes
                if (code === 'terQUEUED' || code === 'timeout' || code === 'tecPATH_DRY') {
                    attempt += 1;
                    if (attempt > this.maxRetries) break;
                    const delay = this.backoffMs * attempt;
                    logger.warn({ attempt, delay, code }, 'Retrying transaction');
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                // Non-retryable; surface error
                throw err;
            }
        }

        throw lastError || new Error('Transaction failed after retries');
    }

    private requireWallet(): Wallet {
        if (!this.opts.wallet) {
            throw new Error('Wallet not initialized');
        }
        return this.opts.wallet;
    }

    private async ensureSequence(account: string): Promise<void> {
        if (this.sequence !== null) return;
        const info = await this.opts.client.request({
            command: 'account_info',
            account,
            ledger_index: 'current',
        });
        this.sequence = info.result.account_data.Sequence;
    }

    private extractResult(meta: unknown): string | undefined {
        if (!meta || typeof meta === 'string') return typeof meta === 'string' ? meta : undefined;
        return (meta as TransactionMetadata).TransactionResult;
    }

    private detectPartialFill(txType: string, meta: unknown): boolean {
        // Basic heuristic: Offer/Payment that consumed offers will show AffectedNodes with ModifiedOffer/DeletedOffer.
        if (!meta || typeof meta === 'string') return false;
        if (txType !== 'OfferCreate' && txType !== 'Payment') return false;
        const nodes = (meta as any).AffectedNodes as any[] | undefined;
        if (!Array.isArray(nodes)) return false;
        return nodes.some((n) => 'ModifiedNode' in n || 'DeletedNode' in n);
    }
}

// Helpers to build correctly typed amounts for callers
export const formatXrpDrops = (xrp: number): string => Math.round(xrp * 1_000_000).toString();
export const formatIssuedAmount = (value: number | string, currency: string, issuer: string) => ({
    currency,
    issuer,
    value: value.toString(),
});
