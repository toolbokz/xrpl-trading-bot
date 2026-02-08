import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { feedbackEngine, AdverseSelectionRateResult } from '../../../../analytics/feedbackEngine';

export const config = {
    api: { bodyParser: false },
};

/**
 * Adverse selection rate API response shape
 */
export interface AdverseSelectionRateApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        windowMs: number | null;
    };
    rate: AdverseSelectionRateResult;
}

/**
 * GET /api/analytics/adverse-selection-rate
 *
 * Returns the rolling adverse selection rate computed from persisted
 * market snapshot flags.
 *
 * Query params:
 * - pairKey: Filter by trading pair (e.g., "XRP/RLUSD")
 * - windowMs: Rolling lookback window in milliseconds (e.g., 3600000 for 1 h)
 */
function handler(
    req: LocalRequest,
    res: NextApiResponse<AdverseSelectionRateApiResponse | { error: string }>,
) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { pairKey, windowMs } = req.query;

        const params: { pairKey?: string; windowMs?: number } = {};

        if (typeof pairKey === 'string' && pairKey.trim()) {
            params.pairKey = pairKey.trim();
        }

        if (typeof windowMs === 'string') {
            const parsed = parseInt(windowMs, 10);
            if (!isNaN(parsed) && parsed > 0) {
                params.windowMs = parsed;
            }
        }

        const rate = feedbackEngine.getAdverseSelectionRate(params);

        const response: AdverseSelectionRateApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            filters: {
                pairKey: params.pairKey ?? null,
                windowMs: params.windowMs ?? null,
            },
            rate,
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(handler);
