import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { feedbackEngine, CostSummary } from '../../../../analytics/feedbackEngine';

export const config = {
    api: { bodyParser: false },
};

/**
 * Deprecated route: currently not mounted in the primary dashboard.
 * Kept for telemetry and backward compatibility until explicit removal.
 */

/**
 * Cost realism API response shape
 */
export interface CostRealismApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        strategy: string | null;
        sinceMs: number | null;
    };
    costs: CostSummary;
}

/**
 * GET /api/analytics/costs
 * 
 * Returns cost realism metrics for trade fills:
 * - avgSlippageBpsVsIntent: Average slippage vs limit/quote price
 * - avgSlippageBpsVsMid: Average slippage vs mid price
 * - avgSpreadPaidBps: Average spread cost
 * - avgEdgeBpsVsMid: Average edge (quoting skill)
 * - avgNetEdgeBpsVsMid: Average net edge after costs
 * - avgTxFeeXrp / totalTxFeeXrp: Transaction fees
 * - partialFillRatio: Ratio of partial fills
 * - avgFillRatio: Average fill percentage
 * 
 * Query params:
 * - pair: Filter by trading pair (e.g., "XRP/RLUSD")
 * - strategy: Filter by strategy name
 * - sinceMs: Filter trades since timestamp (ms)
 */
function handler(req: LocalRequest, res: NextApiResponse<CostRealismApiResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Parse query parameters
        const { pair, strategy, sinceMs } = req.query;

        const filters: { pairKey?: string; strategy?: string; sinceMs?: number } = {};

        if (typeof pair === 'string' && pair.trim()) {
            filters.pairKey = pair.trim();
        }

        if (typeof strategy === 'string' && strategy.trim()) {
            filters.strategy = strategy.trim();
        }

        if (typeof sinceMs === 'string') {
            const parsed = parseInt(sinceMs, 10);
            if (!isNaN(parsed) && parsed > 0) {
                filters.sinceMs = parsed;
            }
        }

        // Get cost summary from feedback engine
        const costs = feedbackEngine.getCostSummary(filters);

        const response: CostRealismApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            filters: {
                pairKey: filters.pairKey ?? null,
                strategy: filters.strategy ?? null,
                sinceMs: filters.sinceMs ?? null,
            },
            costs,
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(withApiRouteContext(handler));
