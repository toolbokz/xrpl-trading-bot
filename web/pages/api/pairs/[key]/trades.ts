/**
 * GET /api/pairs/[key]/trades
 * 
 * Returns recent trades for a trading pair (if available).
 * Note: XRPL doesn't have a direct "recent trades" API like centralized exchanges.
 * This endpoint returns our local trade history for the pair.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { findPair, isValidPairKey } from '../../../../lib/tradingPairs';
import { loadConfig } from '../../../../../src/config';
import { logger } from '../../../../../src/analytics/logger';

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

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<TradesResponse | ErrorResponse>
) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({
            error: 'Method not allowed',
            code: 'METHOD_NOT_ALLOWED',
            requestId,
        });
    }

    // Extract pair key from dynamic route
    const { key, limit: limitParam } = req.query;
    const pairKey = Array.isArray(key) ? key[0] : key;
    const limit = Math.min(Math.max(parseInt(String(limitParam || '20'), 10) || 20, 1), 100);

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

        // For now, return empty trades array.
        // In a full implementation, this would query:
        // 1. Local trade history database
        // 2. Or subscribe to XRPL transaction stream and filter for this pair
        const trades: TradeRecord[] = [];

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
