import type { NextApiResponse } from 'next';
import { withBotAuth, type AuthenticatedRequest, hasPermission } from '../../../lib/botAuth';
import { loadConfig } from '../../../../src/config';
import { getSharedClient } from '../../../lib/xrplClient';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { logger } from '../../../../src/analytics/logger';
import { validateBody, ordersUpdateSchema, ordersCancelSchema } from '../../../lib/validation/schemas';

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
        if (!hasPermission(req.auth.role, 'bot:orders_manage')) {
            return res.status(403).json({ error: 'Insufficient permission for orders management', requestId: req.auth.requestId });
        }

        // Validate input with zod
        const validation = validateBody(req.parsedBody, ordersUpdateSchema);
        if (!validation.success) {
            return res.status(400).json({
                error: 'Invalid input',
                details: validation.errors,
                requestId: req.auth.requestId,
            });
        }

        const { autoManageEnabled, stalenessThresholdSec } = validation.data;
        if (typeof autoManageEnabled === 'boolean') {
            globalAutoManage._autoManageEnabled = autoManageEnabled;
        }
        if (typeof stalenessThresholdSec === 'number') {
            globalAutoManage._stalenessThresholdSec = stalenessThresholdSec;
        }
        return res.status(200).json({
            autoManageEnabled: globalAutoManage._autoManageEnabled,
            stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
            requestId: req.auth.requestId,
        });
    }

    // Handle cancel request (DELETE) - requires admin
    // Routes through TradingRuntime to use proper signing via executor
    if (req.method === 'DELETE') {
        if (!hasPermission(req.auth.role, 'bot:orders_cancel')) {
            return res.status(403).json({ error: 'Insufficient permission for order cancellation', requestId: req.auth.requestId });
        }

        // Validate input with zod
        const validation = validateBody(req.parsedBody, ordersCancelSchema);
        if (!validation.success) {
            return res.status(400).json({
                error: 'Invalid input',
                details: validation.errors,
                requestId: req.auth.requestId,
            });
        }

        const { sequence } = validation.data;
        try {
            const runtime = ensureRuntimeHooks();
            if (!runtime.isStarted()) {
                return res.status(400).json({
                    error: 'Bot must be running to cancel offers',
                    requestId: req.auth.requestId,
                });
            }
            const result = await runtime.cancelOffer(sequence);
            logger.info({ sequence, result, requestId: req.auth.requestId }, 'Offer cancel result');
            return res.status(200).json({
                success: result.accepted,
                sequence,
                hash: result.hash,
                reason: result.reason,
                requestId: req.auth.requestId,
            });
        } catch (err: any) {
            logger.error({ err, sequence, requestId: req.auth.requestId }, 'Failed to cancel offer');
            return res.status(500).json({
                error: err?.message || 'Failed to cancel offer',
                requestId: req.auth.requestId,
            });
        }
    }

    // GET: Fetch active orders and optionally auto-cancel stale ones
    try {
        // Use shared client to avoid rate limiting and connection leaks
        const client = await getSharedClient(cfg.xrpl.endpoint);

        // Try to get wallet address from runtime if available
        let walletAddress: string | null = null;
        try {
            const runtime = ensureRuntimeHooks();
            walletAddress = runtime.getWalletAddress();
        } catch {
            // Runtime not initialized, try to get from config
        }

        // If no wallet address from runtime, we can't fetch orders
        if (!walletAddress) {
            return res.status(200).json({
                orders: [],
                autoManageEnabled: globalAutoManage._autoManageEnabled,
                stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
                cancelledCount: 0,
                requestId: req.auth.requestId,
                message: 'Bot not running or wallet not configured',
            });
        }

        // Get current ledger for age calculation
        const ledgerRes = await client.request({ command: 'ledger_current' });
        const currentLedger = ledgerRes.result.ledger_current_index;

        // Fetch account offers
        const offersRes = await client.request({
            command: 'account_offers',
            account: walletAddress,
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

        // Auto-cancel stale orders if enabled (routes through runtime)
        let cancelledCount = 0;
        if (globalAutoManage._autoManageEnabled && staleSequences.length > 0) {
            try {
                const runtime = ensureRuntimeHooks();
                if (runtime.isStarted()) {
                    for (const seq of staleSequences) {
                        try {
                            const result = await runtime.cancelOffer(seq);
                            if (result.accepted) {
                                cancelledCount++;
                                logger.info({ sequence: seq, hash: result.hash }, 'Auto-cancelled stale offer');
                            }
                        } catch (err) {
                            logger.error({ err, sequence: seq }, 'Failed to auto-cancel offer');
                        }
                    }
                }
            } catch {
                // Runtime not available for auto-cancel
                logger.warn('Auto-cancel skipped: bot not running');
            }
        }

        res.status(200).json({
            orders: activeOrders,
            autoManageEnabled: globalAutoManage._autoManageEnabled,
            stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
            cancelledCount,
            requestId: req.auth.requestId,
        });
    } catch (err: any) {
        logger.error({ err, requestId: req.auth.requestId }, 'Orders API error');
        res.status(500).json({
            error: err?.message || 'Failed to fetch orders',
            orders: [],
            autoManageEnabled: globalAutoManage._autoManageEnabled,
            stalenessThresholdSec: globalAutoManage._stalenessThresholdSec,
            requestId: req.auth.requestId,
        });
    }
}

export default withBotAuth(handler, {
    permission: 'bot:orders_read',
    methods: ['GET', 'POST', 'DELETE'],
});
