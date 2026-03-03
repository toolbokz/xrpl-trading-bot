import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { computeAdverseSelectionRate, computeAdverseSelectionRateFromTrades } from '../../../../analytics/feedbackEngine';
import { querySnapshots, queryTradeEvents } from '../../../../analytics/feedbackDb';
import { canonicalizePairKey } from '../../../../xrpl/currency';
import { buildAnalyticsCacheKey, getAnalyticsCacheTtlMs, getCachedAnalytics, setCachedAnalytics } from './_cache';
import { loadConfig } from '../../../../config';

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
        const canonicalPairKey = parsedPairKey ? canonicalizePairKey(parsedPairKey) : null;

        let parsedWindowMs = DEFAULT_WINDOW_MS;
        if (typeof windowMs === 'string') {
            const parsed = parseInt(windowMs, 10);
            if (!isNaN(parsed) && parsed > 0) {
                parsedWindowMs = parsed;
            }
        }

        const sinceMs = Date.now() - parsedWindowMs;

        const cacheKey = buildAnalyticsCacheKey('adverse-selection-rate', {
            pairKey: canonicalPairKey,
            sinceMs,
            windowMs: parsedWindowMs,
        });
        const cached = getCachedAnalytics<Omit<AdverseSelectionRateResponse, 'requestId' | 'timestamp'>>(cacheKey);
        if (cached) {
            return res.status(200).json({
                requestId: req.requestId,
                timestamp: new Date().toISOString(),
                ...cached,
            });
        }

        const filters: { pairKey?: string; sinceMs?: number; paperMode?: boolean } = { sinceMs };
        if (canonicalPairKey) {
            filters.pairKey = canonicalPairKey;
        }
        filters.paperMode = loadConfig().paperTrading;

        const snapshots = querySnapshots(filters);

        let result = computeAdverseSelectionRate(snapshots);

        // Fallback: when no market snapshots have adverse data, derive
        // adverse selection rate from trade events (entry flow + post-fill price).
        if (result.sampleCount === 0) {
            const trades = queryTradeEvents(filters);
            result = computeAdverseSelectionRateFromTrades(trades);
        }

        const payload: Omit<AdverseSelectionRateResponse, 'requestId' | 'timestamp'> = {
            filters: {
                pairKey: canonicalPairKey,
                windowMs: parsedWindowMs,
            },
            sampleCount: result.sampleCount,
            adverseCount: result.adverseCount,
            adverseRate: result.adverseRate,
        };

        setCachedAnalytics(cacheKey, payload, getAnalyticsCacheTtlMs());

        const response: AdverseSelectionRateResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            ...payload,
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'] });
