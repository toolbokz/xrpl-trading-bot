import type { NextApiResponse } from 'next';
import { withBotAuth, type AuthenticatedRequest, hasPermission } from '../../../lib/botAuth';
import { tradeHistory, Trade, TradeStats } from '../../../lib/tradeHistory';

export const config = {
    api: { bodyParser: false },
};

interface TradesResponse {
    trades: Trade[];
    stats: TradeStats;
}

interface ErrorResponse {
    error: string;
}

async function handler(
    req: AuthenticatedRequest,
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

            return res.status(200).json({ trades, stats });
        } catch (err: any) {
            console.error('Error fetching trades:', err);
            return res.status(500).json({ error: err?.message || 'Failed to fetch trades' });
        }
    }

    if (req.method === 'DELETE') {
        // DELETE requires admin permission (bot:orders_cancel used as proxy for admin actions)
        if (!hasPermission(req.auth.role, 'bot:orders_cancel')) {
            return res.status(403).json({ error: 'Insufficient permission for trades clear' });
        }
        try {
            tradeHistory.clearHistory();
            return res.status(200).json({ trades: [], stats: tradeHistory.getStats() });
        } catch (err: any) {
            console.error('Error clearing trades:', err);
            return res.status(500).json({ error: err?.message || 'Failed to clear trades' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}

export default withBotAuth(handler, {
    permission: 'bot:trades_read',
    methods: ['GET', 'DELETE'],
});
