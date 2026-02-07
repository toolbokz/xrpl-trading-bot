/**
 * GET /api/runtime/balances
 *
 * Returns pair-keyed balance snapshot from the runtime cache.
 * Follows the PairPayload standard envelope.
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getCacheSnapshot, isSingleProcessMode } from '../../../lib/runtimeBridge';
import { buildPairPayload, PairPayload } from '../../../lib/types/pairPayload';

export interface BalanceData {
    xrpBalance: number;
    quoteBalance: number;
    quoteCurrency: string;
    ledgerIndex: number;
}

function handler(
    req: LocalRequest,
    res: NextApiResponse<PairPayload<BalanceData>>,
) {
    const cache = isSingleProcessMode() ? getCacheSnapshot() : null;
    const pairKey = cache?.pairKey ?? '';
    const asOfMs = cache?.balance?.asOfMs ?? Date.now();

    const data: BalanceData | null = cache?.balance
        ? cache.balance.data
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
