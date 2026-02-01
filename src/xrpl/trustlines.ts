import { Client, TxResponse, Wallet, TrustSet, TransactionMetadata } from 'xrpl';
import { RiskConfig, TradingPair } from '../config';
import { logger } from '../analytics/logger';
import { ensureIssued } from './currency';

export interface TrustlineParams {
    limit: string;
    qualityIn?: number;
    qualityOut?: number;
}

export class TrustlineManager {
    constructor(private readonly client: Client, private readonly risk: RiskConfig, private readonly paperMode = false) { }

    async ensure(pair: TradingPair, wallet: Wallet, params: TrustlineParams): Promise<boolean> {
        const issuer = pair.quoteIssuer || pair.issuer;
        if (issuer && this.risk.issuerBlacklist.has(issuer)) {
            logger.warn('Issuer blacklisted; trustline blocked');
            return false;
        }
        if (!issuer) {
            logger.warn('No issuer provided for trustline');
            return false;
        }

        const exists = await this.hasTrustline(wallet.classicAddress, pair);
        if (exists) {
            return true;
        }

        const tx: TrustSet = {
            TransactionType: 'TrustSet',
            Account: wallet.classicAddress,
            LimitAmount: {
                ...ensureIssued(pair.quoteCurrency, issuer),
                value: params.limit,
            },
            Flags: 0,
            QualityIn: params.qualityIn,
            QualityOut: params.qualityOut,
        };

        logger.info({ currency: pair.quoteCurrency, limit: params.limit }, 'Creating trustline');

        return this.submit(tx, wallet);
    }

    async remove(pair: TradingPair, wallet: Wallet): Promise<boolean> {
        const exists = await this.hasTrustline(wallet.classicAddress, pair);
        if (!exists) return true;

        const issuer = pair.quoteIssuer || pair.issuer;
        if (!issuer) return true;

        const tx: TrustSet = {
            TransactionType: 'TrustSet',
            Account: wallet.classicAddress,
            LimitAmount: {
                ...ensureIssued(pair.quoteCurrency, issuer),
                value: '0',
            },
            Flags: 0,
        };
        return this.submit(tx, wallet);
    }

    private async hasTrustline(account: string, pair: TradingPair): Promise<boolean> {
        const issuer = pair.quoteIssuer || pair.issuer;
        if (!issuer) return false;
        const lines = await this.client.request({
            command: 'account_lines',
            account,
            peer: issuer,
        });
        return lines.result.lines.some(
            (line) => line.currency === pair.quoteCurrency && line.account === issuer
        );
    }

    private handleResult(res: TxResponse): boolean {
        const txResult = this.extractTxResult(res.result.meta);
        if (txResult === 'tesSUCCESS') {
            logger.info('Trustline transaction validated');
            return true;
        }
        logger.error({ code: txResult }, 'Trustline failed');
        return false;
    }

    private extractTxResult(meta: unknown): string | undefined {
        if (!meta || typeof meta === 'string') return typeof meta === 'string' ? meta : undefined;
        return (meta as TransactionMetadata).TransactionResult;
    }

    // Guarded submit wrapper with logging and paper-mode simulation to avoid invalid parameter errors.
    private async submit(tx: TrustSet, wallet: Wallet): Promise<boolean> {
        if (this.paperMode) {
            logger.info({ tx }, 'Paper mode: skipping TrustSet submit');
            return true;
        }
        // Validate required fields before autofill.
        if (!tx.Account) tx.Account = wallet.classicAddress;
        if (!tx.LimitAmount?.issuer || !tx.LimitAmount?.currency || !tx.LimitAmount?.value) {
            throw new Error('TrustSet requires LimitAmount { currency, issuer, value }');
        }

        try {
            logger.info({ tx }, 'Preparing TrustSet');
            const prepared = await this.client.autofill(tx);
            logger.info({ tx: prepared }, 'Autofilled TrustSet');
            const signed = wallet.sign(prepared);
            const res = await this.client.submitAndWait(signed.tx_blob);
            logger.info({ result: res.result }, 'TrustSet submit result');
            return this.handleResult(res);
        } catch (err: any) {
            logger.error({ err, tx }, 'TrustSet submission failed');
            return false;
        }
    }
}
