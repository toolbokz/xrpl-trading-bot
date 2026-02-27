import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { withApiRouteContext } from '../../../../lib/localApi/withApiRouteContext';
import { getRuntime } from '../../../../lib/runtimeHooks';
import { getRegimePolicyEngine, RegimePolicy } from '../../../../../analytics/regimePolicy';
import { invalidateAnalyticsCache } from '../_cache';

export const config = {
    api: { bodyParser: false },
};

/**
 * Recompute response
 */
export interface RecomputeApiResponse {
    requestId: string;
    timestamp: string;
    success: boolean;
    policy: RegimePolicy | null;
    message: string;
}

/**
 * POST /api/analytics/regimes/recompute
 *
 * Triggers a manual recomputation of the regime policy.
 * This will:
 * 1. Fetch fresh heatmap data from the feedback database
 * 2. Apply smoothing with the current smoothed state
 * 3. Update disabled regimes and size multipliers
 * 4. Persist the new policy to disk
 *
 * Returns the newly computed policy.
 */
function handler(
    req: LocalRequest,
    res: NextApiResponse<RecomputeApiResponse | { error: string }>
) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Try to recompute via runtime first (preferred, ensures bot context)
        const runtime = getRuntime();
        let policy: RegimePolicy | null = null;

        if (runtime) {
            policy = runtime.recomputeRegimePolicy();
        } else {
            // Fallback: try to recompute via singleton engine
            try {
                const engine = getRegimePolicyEngine();
                policy = engine.recompute();
            } catch {
                // Engine not initialized
            }
        }

        const success = policy !== null;
        invalidateAnalyticsCache('analytics:');

        const response: RecomputeApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            success,
            policy,
            message: success
                ? `Policy recomputed with ${policy?.stats.totalTrades ?? 0} trades`
                : 'Regime policy engine not available (bot may not be running)',
        };

        return res.status(200).json(response);
    } catch (err) {
        console.error('[regimes/recompute] Error:', err);
        return res.status(500).json({
            error: err instanceof Error ? err.message : 'Failed to recompute regime policy',
        });
    }
}

export default withLocalApi(withApiRouteContext(handler));
