import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { Client, Wallet } from 'xrpl';
import { walletFromSecretNumbers } from 'xrpl/dist/npm/Wallet/walletFromSecretNumbers';
import { loadConfig } from '../../../../src/config';
import { getSharedClient } from '../../../lib/xrplClient';
import { logger } from '../../../../src/analytics/logger';

export const config = {
    api: { bodyParser: false },
};

// Known NZD gateways on mainnet
const MAINNET_NZD_ISSUERS = [
    'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', // Bitstamp
    'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq', // GateHub
];

// Known USD gateways for fallback (USD -> NZD conversion)
const MAINNET_USD_ISSUERS = [
    'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', // Bitstamp
    'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq', // GateHub
    'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', // RLUSD (Ripple USD)
];

// Approximate USD to NZD conversion (updated periodically)
const USD_TO_NZD_RATE = 1.62;

interface TrustLineBalance {
    currency: string;
    issuer: string;
    balance: number;
}

/**
 * Convert a currency code to its display name.
 * On XRPL, non-standard (>3 char) currency codes are stored as 40-char hex.
 * e.g., "RLUSD" is stored as "524C555344000000000000000000000000000000"
 */
function decodeCurrency(currency: string): string {
    // Standard 3-character codes are stored as-is
    if (currency.length <= 3) {
        return currency;
    }
    // Hex-encoded currency codes (40 hex chars = 20 bytes)
    if (currency.length === 40 && /^[0-9A-Fa-f]+$/.test(currency)) {
        try {
            const decoded = Buffer.from(currency, 'hex').toString('utf8').replace(/\0/g, '');
            return decoded || currency;
        } catch {
            return currency;
        }
    }
    return currency;
}

/**
 * Check if two currency codes match (handling hex encoding)
 */
function currencyMatches(ledgerCurrency: string, queryCurrency: string): boolean {
    const decoded = decodeCurrency(ledgerCurrency);
    return decoded.toUpperCase() === queryCurrency.toUpperCase() ||
        ledgerCurrency.toUpperCase() === queryCurrency.toUpperCase();
}

async function fetchAccountLines(client: Client, address: string): Promise<TrustLineBalance[]> {
    try {
        const res = await client.request({
            command: 'account_lines',
            account: address,
            ledger_index: 'validated',
        });

        return (res.result.lines || []).map((line: any) => ({
            currency: line.currency,
            issuer: line.account,
            balance: parseFloat(line.balance) || 0,
        }));
    } catch (err: unknown) {
        const errData = (err as any)?.data?.error;
        if (errData !== 'actNotFound') {
            logger.error({ err }, 'Failed to fetch account lines');
        }
        return [];
    }
}

async function fetchXrpRate(client: Client, currency: string, issuers: string[]): Promise<number | null> {
    for (const issuer of issuers) {
        try {
            const bookRes = await client.request({
                command: 'book_offers',
                taker_gets: { currency: 'XRP' },
                taker_pays: { currency, issuer },
                ledger_index: 'validated',
                limit: 1,
            });
            const offers = (bookRes.result as any).offers as Array<any> | undefined;
            if (offers && offers.length > 0) {
                const offer = offers[0];
                if (offer) {
                    const takerGets = Number(offer.TakerGets) / 1_000_000; // XRP in drops
                    const takerPays = Number((offer.TakerPays as any).value);
                    if (takerGets > 0 && takerPays > 0) {
                        return takerPays / takerGets;
                    }
                }
            }
        } catch (err) {
            // Try next issuer
        }
    }
    return null;
}

async function handler(req: LocalRequest, res: NextApiResponse) {
    try {
        const cfg = loadConfig();
        const network = cfg.xrpl.network?.toUpperCase() || 'MAINNET';

        // Allow override via query params (from frontend's selected pair)
        const queryBase = typeof req.query.base === 'string' ? req.query.base : null;
        const queryQuote = typeof req.query.quote === 'string' ? req.query.quote : null;
        const queryIssuer = typeof req.query.issuer === 'string' ? req.query.issuer : null;

        // Use shared client to avoid rate limiting
        const client = await getSharedClient(cfg.xrpl.endpoint);

        // Get wallet address from seed or secret numbers
        let address: string | null = null;

        if (cfg.walletSeed) {
            const wallet = Wallet.fromSeed(cfg.walletSeed);
            address = wallet.classicAddress;
        } else if (cfg.walletSecretNumbers) {
            // Secret numbers format: "123456,234567,345678,..." (8 numbers)
            try {
                const secretNums = cfg.walletSecretNumbers.split(',').map(n => n.trim());
                const wallet = walletFromSecretNumbers(secretNums);
                address = wallet.classicAddress;
            } catch (err) {
                logger.error({ err }, 'Failed to derive wallet from secret numbers');
            }
        }

        if (!address) {
            // Don't disconnect - using shared client
            return res.status(200).json({
                address: null,
                balance: 0,
                nzdRate: 0.85,
                network,
            });
        }

        // Fetch account balance
        let balance = 0;
        try {
            const accountInfo = await client.request({
                command: 'account_info',
                account: address,
                ledger_index: 'validated',
            });
            balance = Number(accountInfo.result.account_data.Balance) / 1_000_000;
        } catch (err: unknown) {
            // Account may not exist yet
            const errData = (err as any)?.data?.error;
            if (errData !== 'actNotFound') {
                logger.error({ err }, 'Failed to fetch account info');
            }
        }

        // Fetch trust line balances (for quote currency)
        const trustLines = await fetchAccountLines(client, address);

        // Get quote currency info - prefer query params over config
        const quoteCurrency = queryQuote || cfg.tradingPair.quoteCurrency || '';
        const quoteIssuer = queryIssuer || cfg.tradingPair.quoteIssuer || cfg.tradingPair.issuer || '';
        const baseCurrency = queryBase || cfg.tradingPair.baseCurrency || 'XRP';
        const baseIssuer = queryIssuer || cfg.tradingPair.baseIssuer || cfg.tradingPair.issuer || '';

        // Find the quote currency balance if it's not XRP
        let quoteBalance = 0;
        let quoteCurrencyDisplay = quoteCurrency;

        if (quoteCurrency.toUpperCase() !== 'XRP' && quoteIssuer) {
            const quoteLine = trustLines.find(
                (line) => currencyMatches(line.currency, quoteCurrency) && line.issuer === quoteIssuer
            );
            if (quoteLine) {
                quoteBalance = quoteLine.balance;
            }
        } else if (quoteCurrency.toUpperCase() === 'XRP') {
            // If quote is XRP, use XRP balance
            quoteBalance = balance;
        }

        // If base currency is not XRP, also get its balance
        let baseBalance = balance; // Default to XRP balance
        let baseCurrencyDisplay = baseCurrency;

        if (baseCurrency.toUpperCase() !== 'XRP' && baseIssuer) {
            const baseLine = trustLines.find(
                (line) => currencyMatches(line.currency, baseCurrency) && line.issuer === baseIssuer
            );
            if (baseLine) {
                baseBalance = baseLine.balance;
            } else {
                baseBalance = 0;
            }
        }

        // Try to get XRP/NZD rate
        let nzdRate = 0.85; // Default fallback rate
        const isMainnet = cfg.xrpl.network === 'mainnet';

        // Build list of NZD issuers to try
        const nzdIssuers: string[] = [];
        const configIssuer = cfg.tradingPair.quoteIssuer || cfg.tradingPair.issuer;
        if (configIssuer) {
            nzdIssuers.push(configIssuer);
        }
        if (isMainnet) {
            nzdIssuers.push(...MAINNET_NZD_ISSUERS.filter(i => i !== configIssuer));
        }

        // Try NZD first
        const directNzdRate = await fetchXrpRate(client, 'NZD', nzdIssuers);
        if (directNzdRate !== null) {
            nzdRate = directNzdRate;
        } else if (isMainnet) {
            // Fallback: Try USD and convert to NZD
            const usdRate = await fetchXrpRate(client, 'USD', MAINNET_USD_ISSUERS);
            if (usdRate !== null) {
                nzdRate = usdRate * USD_TO_NZD_RATE;
                logger.debug({ usdRate, nzdRate }, 'Using USD rate for NZD conversion');
            }
        }

        // Don't disconnect - using shared client

        res.status(200).json({
            address,
            balance,
            nzdRate,
            network,
            // Pair balances
            tradingPair: {
                base: baseCurrencyDisplay,
                quote: quoteCurrencyDisplay,
            },
            baseBalance,
            quoteBalance,
            quoteCurrency: quoteCurrencyDisplay,
            requestId: req.requestId,
        });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch wallet info';
        logger.error({ err }, '[API /bot/wallet] Error');
        res.status(500).json({
            error: errorMessage,
            address: null,
            balance: 0,
            nzdRate: 0.85,
            network: 'UNKNOWN',
            tradingPair: { base: 'XRP', quote: '' },
            baseBalance: 0,
            quoteBalance: 0,
            quoteCurrency: '',
            requestId: req.requestId,
        });
    }
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });