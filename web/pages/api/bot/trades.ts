import type { NextApiRequest, NextApiResponse } from 'next';
import { tradeHistory, Trade, TradeStats } from '../../../lib/tradeHistory';

interface TradesResponse {
    trades: Trade[];
    stats: TradeStats;
}

interface ErrorResponse {
    error: string;
}

export default async function handler(
    req: NextApiRequest,
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
