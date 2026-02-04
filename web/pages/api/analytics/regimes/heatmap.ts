import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { feedbackEngine, RegimeHeatmapResponse } from '../../../../../src/analytics/feedbackEngine';

export const config = {
    api: { bodyParser: false },
};

/**
 * Regime heatmap API response
 */
export interface RegimeHeatmapApiResponse {
    requestId: string;
    timestamp: string;
    heatmap: RegimeHeatmapResponse;
}

/**
 * GET /api/analytics/regimes/heatmap
 *
 * Returns regime performance heatmap with scores, win rates, and cost metrics
 * for both global and per-strategy breakdowns.
 *
 * Query params:
 * - hours: Lookback window in hours (default: 24)
 * - minTrades: Minimum trades for valid stats (default: 5)
 * - byStrategy: Include per-strategy breakdown (default: true)
 */
function handler(
    req: LocalRequest,
    res: NextApiResponse<RegimeHeatmapApiResponse | { error: string }>
) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Parse query parameters
        const { hours, minTrades, byStrategy } = req.query;

        const lookbackHours = typeof hours === 'string' ? parseInt(hours, 10) : 24;
        const minTradesNum = typeof minTrades === 'string' ? parseInt(minTrades, 10) : 5;
        const includeStrategy = byStrategy !== 'false';

        // Get heatmap from feedback engine
        const heatmap = feedbackEngine.getRegimeHeatmap({
            lookbackHours: isNaN(lookbackHours) ? 24 : lookbackHours,
            minTrades: isNaN(minTradesNum) ? 5 : minTradesNum,
            byStrategy: includeStrategy,
        });

        const response: RegimeHeatmapApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            heatmap,
        };

        return res.status(200).json(response);
    } catch (err) {
        console.error('[regimes/heatmap] Error:', err);
        return res.status(500).json({
            error: err instanceof Error ? err.message : 'Failed to get regime heatmap',
        });
    }
}

export default withLocalApi(handler);
