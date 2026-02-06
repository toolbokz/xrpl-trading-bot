/**
 * GET /api/trades/tape
 *
 * Returns the live trade tape from the runtime cache.
 * Follows the PairPayload standard envelope.
 *
 * Replaces the old proxy to backend HTTP server.
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getCacheSnapshot, isSingleProcessMode } from '../../../lib/runtimeBridge';
import { buildPairPayload, PairPayload } from '../../../lib/types/pairPayload';
import type { Trade } from '../../../../market/tradeTape';

export interface TapeData {
    trades: Trade[];
    tradeCount: number;
    lastTradeAtMs: number | null;
}

function handler(
    req: LocalRequest,
    res: NextApiResponse<PairPayload<TapeData>>,
) {
    const cache = isSingleProcessMode() ? getCacheSnapshot() : null;
    const pairKey = cache?.pairKey ?? '';
    const asOfMs = cache?.tape?.asOfMs ?? Date.now();

    const data: TapeData | null = cache?.tape
        ? cache.tape.data
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
