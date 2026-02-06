import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest, logSensitiveAction } from '../../../lib/localApi';
import { tradeHistory, Trade, TradeStats } from '../../../lib/tradeHistory';
import { logger } from '../../../../analytics/logger';

export const config = {
    api: { bodyParser: false },
};

interface TradesResponse {
    trades: Trade[];
    stats: TradeStats;
    requestId?: string;
}

interface ErrorResponse {
    error: string;
    requestId?: string;
}

async function handler(
    req: LocalRequest,
    res: NextApiResponse<TradesResponse | ErrorResponse>
): Promise<void> {
    if (req.method === 'GET') {
        try {
            const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
            const pair = typeof req.query.pair === 'string' ? req.query.pair : undefined;

            const trades = pair
                ? tradeHistory.getTradesByPair(pair, limit)
                : tradeHistory.getRecentTrades(limit);
            const stats = tradeHistory.getStats();

            return res.status(200).json({ trades, stats, requestId: req.requestId });
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to fetch trades';
            logger.error({ err }, '[API /bot/trades] Error fetching trades');
            return res.status(500).json({ error: errorMessage, requestId: req.requestId });
        }
    }

    if (req.method === 'DELETE') {
        try {
            tradeHistory.clearHistory();

            // Audit log sensitive action
            await logSensitiveAction(req.requestId, 'bot:trades_clear', {});

            return res.status(200).json({ trades: [], stats: tradeHistory.getStats(), requestId: req.requestId });
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to clear trades';
            logger.error({ err }, '[API /bot/trades] Error clearing trades');
            return res.status(500).json({ error: errorMessage, requestId: req.requestId });
        }
    }

    return res.status(405).json({ error: 'Method not allowed', requestId: req.requestId });
}

export default withLocalApi(handler, { methods: ['GET', 'DELETE'] });
