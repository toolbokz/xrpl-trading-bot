/**
 * GET /api/metrics/runtime
 *
 * Returns the full runtime cache snapshot for observability / monitoring.
 * Follows the PairPayload standard envelope.
 *
 * This is the canonical "give me everything" endpoint for institutional
 * monitoring integrations. It returns all cache feeds in one response.
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getCacheSnapshot, isSingleProcessMode } from '../../../lib/runtimeBridge';
import { buildPairPayload, PairPayload } from '../../../lib/types/pairPayload';
import type { RuntimeCacheSnapshot } from '../../../../src/runtime/runtimeCacheRegistry';

function handler(
    req: LocalRequest,
    res: NextApiResponse<PairPayload<RuntimeCacheSnapshot>>,
) {
    const cache = isSingleProcessMode() ? getCacheSnapshot() : null;
    const pairKey = cache?.pairKey ?? '';
    const asOfMs = cache?.asOfMs ?? Date.now();

    return res.status(200).json(buildPairPayload(
        {
            pairKey,
            asOfMs,
            executionAllowed: cache?.executionAllowed ?? false,
            runtimeState: cache?.runtimeState ?? null,
            requestId: req.requestId,
        },
        cache,
    ));
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
