import type { NextApiResponse } from 'next';
import { withBotAuth, type AuthenticatedRequest, hasPermission } from '../../../lib/botAuth';
import { Client, Wallet } from 'xrpl';
import { walletFromSecretNumbers } from 'xrpl/dist/npm/Wallet/walletFromSecretNumbers';
import { loadConfig } from '../../../../src/config';

export const config = {
    api: { bodyParser: false },
};

interface ActiveOffer {
    sequence: number;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    createdAt: number; // ledger index when created
    age: number; // seconds since creation
}

// Auto-manage settings stored in memory (per-session)
const globalAutoManage = globalThis as typeof globalThis & {
    _autoManageEnabled?: boolean;
    _stalenessThresholdSec?: number;
};

if (globalAutoManage._autoManageEnabled === undefined) {
    globalAutoManage._autoManageEnabled = false;
}
if (globalAutoManage._stalenessThresholdSec === undefined) {
    globalAutoManage._stalenessThresholdSec = 60; // default 60 seconds
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
    const cfg = loadConfig();

    // Handle settings updates (POST) - requires operator
    if (req.method === 'POST') {
        if (!hasPermission(req.role, 'bot:orders_manage')) {
            return res.status(403).json({ error: 'Insufficient permission for orders management' });
        }
        const { autoManageEnabled, stalenessThresholdSec } = req.body;
        if (typeof autoManageEnabled === 'boolean') {
            globalAutoManage._autoManageEnabled = autoManageEnabled;
        }
        if (typeof stalenessThresholdSec === 'number' && stalenessThresholdSec > 0) {
            globalAutoManage._stalenessThresholdSec = stalenessThresholdSec;
        }
        return res.status(200).json({
            autoManageEnabled: globalAutoManage._autoManageEnabled,
            stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
        });
    }

    // Handle cancel request (DELETE) - requires admin
    if (req.method === 'DELETE') {
        if (!hasPermission(req.role, 'bot:orders_cancel')) {
            return res.status(403).json({ error: 'Insufficient permission for order cancellation' });
        }
        const { sequence } = req.body;
        if (typeof sequence !== 'number') {
            return res.status(400).json({ error: 'Missing sequence number' });
        }
        try {
            const result = await cancelOffer(cfg, sequence);
            return res.status(200).json(result);
        } catch (err: any) {
            return res.status(500).json({ error: err?.message || 'Failed to cancel offer' });
        }
    }

    // GET: Fetch active orders and optionally auto-cancel stale ones
    try {
        const client = new Client(cfg.xrpl.endpoint);
        await client.connect();

        // Get wallet
        let wallet: Wallet | null = null;
        if (cfg.walletSeed) {
            wallet = Wallet.fromSeed(cfg.walletSeed);
        } else if (cfg.walletSecretNumbers) {
            const secretNums = cfg.walletSecretNumbers.split(',').map(n => n.trim());
            wallet = walletFromSecretNumbers(secretNums);
        }

        if (!wallet) {
            await client.disconnect();
            return res.status(200).json({
                orders: [],
                autoManageEnabled: globalAutoManage._autoManageEnabled,
                stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
                cancelledCount: 0,
            });
        }

        // Get current ledger for age calculation
        const ledgerRes = await client.request({ command: 'ledger_current' });
        const currentLedger = ledgerRes.result.ledger_current_index;

        // Fetch account offers
        const offersRes = await client.request({
            command: 'account_offers',
            account: wallet.classicAddress,
            ledger_index: 'validated',
        });

        const offers = offersRes.result.offers || [];
        const activeOrders: ActiveOffer[] = [];
        const staleSequences: number[] = [];

        // Average ~4 seconds per ledger
        const SECONDS_PER_LEDGER = 4;

        for (const offer of offers) {
            // Determine side and price
            // TakerGets = what maker gives, TakerPays = what maker receives
            const takerGets = offer.taker_gets;
            const takerPays = offer.taker_pays;

            let side: 'BUY' | 'SELL';
            let size: number;
            let price: number;

            // If TakerGets is XRP (string), we're selling XRP for token
            // If TakerPays is XRP (string), we're buying XRP with token
            if (typeof takerGets === 'string') {
                // Selling XRP
                side = 'SELL';
                size = Number(takerGets) / 1_000_000;
                const payValue = typeof takerPays === 'object' ? Number(takerPays.value) : Number(takerPays) / 1_000_000;
                price = payValue / size;
            } else if (typeof takerPays === 'string') {
                // Buying XRP
                side = 'BUY';
                size = Number(takerPays) / 1_000_000;
                const getsValue = typeof takerGets === 'object' ? Number(takerGets.value) : Number(takerGets) / 1_000_000;
                price = getsValue / size;
            } else {
                // Token-to-token, skip for now
                continue;
            }

            const createdAt = offer.seq || (offer as any).Sequence || 0;
            const ledgerAge = currentLedger - createdAt;
            const age = ledgerAge * SECONDS_PER_LEDGER;

            activeOrders.push({
                sequence: offer.seq || (offer as any).Sequence,
                side,
                size,
                price,
                createdAt,
                age,
            });

            // Check if stale and auto-manage is enabled
            if (globalAutoManage._autoManageEnabled && age > (globalAutoManage._stalenessThresholdSec || 60)) {
                staleSequences.push(offer.seq || (offer as any).Sequence);
            }
        }

        // Auto-cancel stale orders if enabled
        let cancelledCount = 0;
        if (globalAutoManage._autoManageEnabled && staleSequences.length > 0) {
            for (const seq of staleSequences) {
                try {
                    const cancelTx = {
                        TransactionType: 'OfferCancel' as const,
                        Account: wallet.classicAddress,
                        OfferSequence: seq,
                    };
                    const prepared = await client.autofill(cancelTx);
                    const signed = wallet.sign(prepared);
                    const result = await client.submitAndWait(signed.tx_blob);
                    if (result.result.meta && typeof result.result.meta === 'object' && 'TransactionResult' in result.result.meta) {
                        if (result.result.meta.TransactionResult === 'tesSUCCESS') {
                            cancelledCount++;
                            console.log(`Auto-cancelled stale offer ${seq}`);
                        }
                    }
                } catch (err) {
                    console.error(`Failed to auto-cancel offer ${seq}:`, err);
                }
            }
        }

        await client.disconnect();

        res.status(200).json({
            orders: activeOrders,
            autoManageEnabled: globalAutoManage._autoManageEnabled,
            stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
            cancelledCount,
        });
    } catch (err: any) {
        console.error('Orders API error:', err);
        res.status(500).json({
            error: err?.message || 'Failed to fetch orders',
            orders: [],
            autoManageEnabled: globalAutoManage._autoManageEnabled,
            stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
        });
    }
}

async function cancelOffer(config: ReturnType<typeof loadConfig>, sequence: number) {
    const client = new Client(config.xrpl.endpoint);
    await client.connect();

    let wallet: Wallet | null = null;
    if (config.walletSeed) {
        wallet = Wallet.fromSeed(config.walletSeed);
    } else if (config.walletSecretNumbers) {
        const secretNums = config.walletSecretNumbers.split(',').map(n => n.trim());
        wallet = walletFromSecretNumbers(secretNums);
    }

    if (!wallet) {
        await client.disconnect();
        throw new Error('No wallet configured');
    }

    const cancelTx = {
        TransactionType: 'OfferCancel' as const,
        Account: wallet.classicAddress,
        OfferSequence: sequence,
    };

    const prepared = await client.autofill(cancelTx);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);

    await client.disconnect();

    if (result.result.meta && typeof result.result.meta === 'object' && 'TransactionResult' in result.result.meta) {
        if (result.result.meta.TransactionResult === 'tesSUCCESS') {
            return { success: true, sequence };
        }
    }

    return { success: false, sequence, error: 'Transaction failed' };
}

export default withBotAuth(handler, {
    permission: 'bot:orders_read',
    methods: ['GET', 'POST', 'DELETE'],
});
