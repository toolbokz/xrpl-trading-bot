import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { computeAdverseSelectionRate } from '../../../../analytics/feedbackEngine';
import { querySnapshots } from '../../../../analytics/feedbackDb';

export const config = {
    api: { bodyParser: false },
};

/**
 * Adverse selection rate response shape
 */
export interface AdverseSelectionRateResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        windowMs: number;
    };
    sampleCount: number;
    adverseCount: number;
    adverseRate: number;
}

/** Default lookback window: 1 hour */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/**
 * GET /api/analytics/adverse-selection-rate
 *
 * Returns rolling adverse selection rate computed from market snapshots.
 *
 * Query params:
 * - pairKey: Filter by trading pair (e.g., "XRP/RLUSD")
 * - windowMs: Lookback window in milliseconds (default: 3600000 = 1 hour)
 */
function handler(
    req: LocalRequest,
    res: NextApiResponse<AdverseSelectionRateResponse | { error: string }>,
) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { pairKey, windowMs } = req.query;

        let parsedPairKey: string | undefined;
        if (typeof pairKey === 'string' && pairKey.trim()) {
            parsedPairKey = pairKey.trim();
        }

        let parsedWindowMs = DEFAULT_WINDOW_MS;
        if (typeof windowMs === 'string') {
            const parsed = parseInt(windowMs, 10);
            if (!isNaN(parsed) && parsed > 0) {
                parsedWindowMs = parsed;
            }
        }

        const sinceMs = Date.now() - parsedWindowMs;

        const filters: { pairKey?: string; sinceMs?: number } = { sinceMs };
        if (parsedPairKey) {
            filters.pairKey = parsedPairKey;
        }

        const snapshots = querySnapshots(filters);

        const { sampleCount, adverseCount, adverseRate } =
            computeAdverseSelectionRate(snapshots);

        const response: AdverseSelectionRateResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            filters: {
                pairKey: parsedPairKey ?? null,
                windowMs: parsedWindowMs,
            },
            sampleCount,
            adverseCount,
            adverseRate,
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(handler, { methods: ['GET'] });
