/**
 * GET /api/analytics/execution-quality?pairKey=XRP/RLUSD&window=3600000
 *
 * Returns per-fill execution quality analytics (slippage, latency, spread,
 * impact) from the ExecutionQualityCollector.
 *
 * Query params:
 *   pairKey — pair to aggregate for (default: current active pair)
 *   window  — aggregation window in ms (default: 1 hour)
 *   recent  — max recent fills to include (default: 20)
 *
 * Follows the PairPayload standard envelope.
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { isSingleProcessMode, getCacheSnapshot } from '../../../lib/runtimeBridge';
import { getRuntime } from '../../../../runtime/runtimeSingleton';
import { buildPairPayload, PairPayload } from '../../../lib/types/pairPayload';
import type { ExecutionQualityPayload } from '../../../../analytics/executionQuality';

function handler(
    req: LocalRequest,
    res: NextApiResponse<PairPayload<ExecutionQualityPayload | null>>,
) {
    const cache = isSingleProcessMode() ? getCacheSnapshot() : null;
    const runtime = getRuntime();
    const collector = runtime?.getExecutionQualityCollector() ?? null;

    const windowParam = typeof req.query.window === 'string' ? Number(req.query.window) : undefined;
    const recentParam = typeof req.query.recent === 'string' ? Number(req.query.recent) : 20;
    const windowMs = windowParam && Number.isFinite(windowParam) && windowParam > 0 ? windowParam : undefined;
    const recentLimit = Number.isFinite(recentParam) && recentParam > 0 ? recentParam : 20;

    const pairKey = (typeof req.query.pairKey === 'string' && req.query.pairKey)
        || cache?.pairKey
        || '';

    const data: ExecutionQualityPayload | null = collector
        ? collector.getPayload(windowMs, recentLimit)
        : null;

    return res.status(200).json(buildPairPayload(
        {
            pairKey,
            asOfMs: Date.now(),
            executionAllowed: cache?.executionAllowed ?? false,
            runtimeState: cache?.runtimeState ?? null,
            requestId: req.requestId,
        },
        data,
    ));
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
