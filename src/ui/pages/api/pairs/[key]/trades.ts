/**
 * GET /api/pairs/[key]/trades
 * 
 * Returns recent trades for a trading pair (if available).
 * Note: XRPL doesn't have a direct "recent trades" API like centralized exchanges.
 * This endpoint returns our local trade history for the pair.
 */

import type { NextApiResponse } from 'next';
import { findPair, isValidPairKey } from '../../../../lib/tradingPairs';
import { loadConfig } from '../../../../../config';
import { logger } from '../../../../../analytics/logger';
import { getGlobalTradeTape, Trade } from '../../../../../market/tradeTape';
import {
    isSingleProcessMode,
    getTapeFromRuntime,
    initRuntimeBridge,
} from '../../../../lib/runtimeBridge';
import { withLocalApi } from '../../../../lib/localApi';
import type { LocalRequest } from '../../../../lib/localApi';

export const config = {
    api: { bodyParser: false },
};

// =============================================================================
// Types
// =============================================================================

interface TradeRecord {
    id: string;
    timestamp: number;
    pair: string;
    side: 'BUY' | 'SELL';
    price: number;
    amount: number;
    total: number;
    txHash?: string;
}

interface TradesResponse {
    pair: string;
    trades: TradeRecord[];
    lastUpdated: number;
    network: 'mainnet' | 'testnet';
}

interface ErrorResponse {
    error: string;
    code: string;
    requestId: string;
}

// =============================================================================
// Handler
// =============================================================================

async function handler(
    req: LocalRequest,
    res: NextApiResponse<TradesResponse | ErrorResponse>
) {
    const requestId = req.requestId;

    // Initialize runtime bridge in single-process mode
    if (isSingleProcessMode()) {
        try {
            await initRuntimeBridge();
        } catch (err) {
            logger.warn({ err }, '[API /pairs/[key]/trades] Runtime bridge init failed');
        }
    }

    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({
            error: 'Method not allowed',
            code: 'METHOD_NOT_ALLOWED',
            requestId,
        });
    }

    // Extract pair key from dynamic route
    const { key } = req.query;
    const pairKey = Array.isArray(key) ? key[0] : key;

    if (!pairKey || !isValidPairKey(pairKey)) {
        return res.status(400).json({
            error: `Invalid trading pair: ${pairKey}`,
            code: 'INVALID_PAIR',
            requestId,
        });
    }

    const pair = findPair(pairKey);
    if (!pair) {
        return res.status(404).json({
            error: `Trading pair not found: ${pairKey}`,
            code: 'PAIR_NOT_FOUND',
            requestId,
        });
    }

    try {
        const cfg = loadConfig();
        const currentNetwork = cfg.xrpl.network as 'mainnet' | 'testnet';
        const limitParam = req.query.limit;
        const limit = Math.min(Math.max(parseInt(String(limitParam || '50'), 10) || 50, 1), 500);

        // Get trades from runtime trade tape (single-process mode) or global tape
        let rawTrades: Trade[] = [];

        if (isSingleProcessMode()) {
            const tapeData = getTapeFromRuntime();
            if (tapeData && tapeData.trades.length > 0) {
                rawTrades = tapeData.trades
                    .filter((t: Trade) => t.pairKey === pairKey)
                    .slice(-limit);
            }
        } else {
            const tape = getGlobalTradeTape();
            if (tape) {
                const tapeKey = tape.getPairKey();
                if (tapeKey === pairKey) {
                    rawTrades = tape.getAll().slice(-limit);
                }
            }
        }

        // Map to TradeRecord format
        const trades: TradeRecord[] = rawTrades.map((t: Trade) => ({
            id: t.txHash || `${t.ts}-${t.price}`,
            timestamp: t.ts,
            pair: pairKey,
            side: t.side === 'buy' ? 'BUY' : 'SELL',
            price: t.price,
            amount: t.sizeBase,
            total: t.sizeQuote,
            txHash: t.txHash,
        }));

        const response: TradesResponse = {
            pair: pairKey,
            trades,
            lastUpdated: Date.now(),
            network: currentNetwork,
        };

        // Cache for 5 seconds
        res.setHeader('Cache-Control', 'private, max-age=5');
        return res.status(200).json(response);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Internal server error';
        logger.error({ err, pairKey }, '[API /pairs/[key]/trades] Error');
        return res.status(500).json({
            error: errorMessage,
            code: 'INTERNAL_ERROR',
            requestId,
        });
    }
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
