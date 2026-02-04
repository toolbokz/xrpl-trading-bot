import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { feedbackEngine, AnalyticsResponse, AnalyticsSummary, RegimeStats, StrategyStats, DrawdownPoint } from '../../../../src/analytics/feedbackEngine';

export const config = {
    api: { bodyParser: false },
};

/**
 * Analytics response shape
 */
export interface AnalyticsApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        sinceMs: number | null;
    };
    summary: AnalyticsSummary;
    byRegime: RegimeStats[];
    byStrategy: StrategyStats[];
    drawdown: DrawdownPoint[];
}

/**
 * GET /api/analytics/summary
 * 
 * Returns trading analytics including:
 * - Summary: trades, win rate, profit factor, expectancy, slippage, drawdown
 * - By Regime: performance breakdown by market regime
 * - By Strategy: performance breakdown by strategy
 * - Drawdown: equity curve with rolling drawdown
 * 
 * Query params:
 * - pair: Filter by trading pair (e.g., "XRP/RLUSD")
 * - sinceMs: Filter trades since timestamp (ms)
 */
function handler(req: LocalRequest, res: NextApiResponse<AnalyticsApiResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Parse query parameters
        const { pair, sinceMs } = req.query;

        const filters: { pairKey?: string; sinceMs?: number } = {};

        if (typeof pair === 'string' && pair.trim()) {
            filters.pairKey = pair.trim();
        }

        if (typeof sinceMs === 'string') {
            const parsed = parseInt(sinceMs, 10);
            if (!isNaN(parsed) && parsed > 0) {
                filters.sinceMs = parsed;
            }
        }

        // Get analytics from feedback engine
        const analytics: AnalyticsResponse = feedbackEngine.getAnalytics(filters);

        const response: AnalyticsApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            filters: {
                pairKey: filters.pairKey ?? null,
                sinceMs: filters.sinceMs ?? null,
            },
            summary: analytics.summary,
            byRegime: analytics.byRegime,
            byStrategy: analytics.byStrategy,
            drawdown: analytics.drawdown,
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(handler);
