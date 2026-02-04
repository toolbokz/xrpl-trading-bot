import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { getRuntime } from '../../../../lib/runtimeHooks';
import { getRegimePolicyEngine, RegimePolicy } from '../../../../../src/analytics/regimePolicy';

export const config = {
    api: { bodyParser: false },
};

/**
 * Regime policy API response
 */
export interface RegimePolicyApiResponse {
    requestId: string;
    timestamp: string;
    available: boolean;
    policy: RegimePolicy | null;
}

/**
 * GET /api/analytics/regimes/policy
 *
 * Returns the current regime policy including:
 * - Global and per-strategy disabled regimes
 * - Size multipliers by regime
 * - Smoothed scores and reasons
 * - Policy metadata (updated time, lookback hours, etc.)
 *
 * Returns available: false if policy engine is not initialized.
 */
function handler(
    req: LocalRequest,
    res: NextApiResponse<RegimePolicyApiResponse | { error: string }>
) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Try to get policy from runtime first (preferred, ensures bot context)
        const runtime = getRuntime();
        let policy: RegimePolicy | null = null;

        if (runtime) {
            policy = runtime.getRegimePolicy();
        } else {
            // Fallback: try to get from singleton engine (may have persisted state)
            try {
                const engine = getRegimePolicyEngine();
                policy = engine.getCurrentPolicy();
            } catch {
                // Engine not initialized
            }
        }

        const response: RegimePolicyApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            available: policy !== null,
            policy,
        };

        return res.status(200).json(response);
    } catch (err) {
        console.error('[regimes/policy] Error:', err);
        return res.status(500).json({
            error: err instanceof Error ? err.message : 'Failed to get regime policy',
        });
    }
}

export default withLocalApi(handler);
