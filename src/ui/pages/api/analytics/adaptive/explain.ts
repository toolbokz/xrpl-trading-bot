import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { getAdaptiveLearner, AdaptiveTuning, PerformanceRow } from '../../../../../analytics/adaptiveLearner';
import { isAdaptiveEnabled } from '../../../../../analytics/adaptiveConfig';
import { FlowRegime } from '../../../../../market/flowMetrics';

export const config = {
    api: { bodyParser: false },
};

/**
 * Explain API response
 */
export interface ExplainApiResponse {
    requestId: string;
    timestamp: string;
    pairKey: string;
    strategy: string;
    regime: FlowRegime;
    enabled: boolean;
    tuning: AdaptiveTuning | null;
    performance: PerformanceRow | null;
}

/**
 * GET /api/analytics/adaptive/explain
 *
 * Returns tuning + reason + performance metrics for a specific combination.
 * Useful for understanding why a tuning was set.
 *
 * Query params:
 * - pairKey: Trading pair (e.g., "XRP/RLUSD")
 * - strategy: Strategy name (e.g., "scalper")
 * - regime: Flow regime (e.g., "normal", "chaotic")
 */
function handler(req: LocalRequest, res: NextApiResponse<ExplainApiResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { pairKey, strategy, regime } = req.query;

        // Validate required params
        if (typeof pairKey !== 'string' || !pairKey.trim()) {
            return res.status(400).json({ error: 'Missing required query param: pairKey' });
        }
        if (typeof strategy !== 'string' || !strategy.trim()) {
            return res.status(400).json({ error: 'Missing required query param: strategy' });
        }
        if (typeof regime !== 'string' || !regime.trim()) {
            return res.status(400).json({ error: 'Missing required query param: regime' });
        }

        const validRegimes: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];
        if (!validRegimes.includes(regime as FlowRegime)) {
            return res.status(400).json({
                error: `Invalid regime. Must be one of: ${validRegimes.join(', ')}`,
            });
        }

        const learner = getAdaptiveLearner();
        const explanation = learner.explainTuning(pairKey.trim(), strategy.trim(), regime as FlowRegime);

        return res.status(200).json({
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            pairKey: pairKey.trim(),
            strategy: strategy.trim(),
            regime: regime as FlowRegime,
            enabled: isAdaptiveEnabled(),
            tuning: explanation.tuning,
            performance: explanation.performance,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(handler);
