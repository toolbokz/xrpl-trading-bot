/**
 * GET /api/analytics/execution-quality
 *
 * Returns execution quality metrics from the runtime cache.
 * Follows the PairPayload standard envelope.
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getCacheSnapshot, isSingleProcessMode } from '../../../lib/runtimeBridge';
import { buildPairPayload, PairPayload } from '../../../lib/types/pairPayload';
import type { ExecutionQualitySnapshot } from '../../../../src/runtime/runtimeCacheRegistry';

function handler(
    req: LocalRequest,
    res: NextApiResponse<PairPayload<ExecutionQualitySnapshot>>,
) {
    const cache = isSingleProcessMode() ? getCacheSnapshot() : null;
    const pairKey = cache?.pairKey ?? '';
    const asOfMs = cache?.executionQuality?.asOfMs ?? Date.now();

    const data: ExecutionQualitySnapshot | null = cache?.executionQuality
        ? cache.executionQuality.data
        : null;

    return res.status(200).json(buildPairPayload(
        {
            pairKey,
            asOfMs,
            executionAllowed: cache?.executionAllowed ?? false,
            runtimeState: cache?.runtimeState ?? null,
            requestId: req.requestId,
        },
        data,
    ));
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
