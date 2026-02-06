import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getRuntimeState, getCacheSnapshot, RuntimePublicState } from '../../../../src/runtime/runtimeSingleton';

/**
 * Response shape for GET /api/runtime/state.
 *
 * Exposes the full runtime telemetry snapshot (FSM state, feed health,
 * ledger progress, execution gate verdict, market health quorum).
 * Also includes pair-payload standard fields.
 */
export interface RuntimeStateResponse {
    requestId: string;
    /** Full RuntimePublicState snapshot (includes telemetry). */
    state: RuntimePublicState;
    /** Pair-payload standard fields */
    pairKey: string;
    asOfMs: number;
    stalenessMs: number;
    executionAllowed: boolean;
    runtimeState: string | null;
}

/**
 * GET /api/runtime/state
 *
 * Returns the aggregated runtime telemetry snapshot for observability,
 * dashboards, and external monitoring integrations.
 *
 * Localhost-only (enforced by withLocalApi wrapper).
 */
function handler(req: LocalRequest, res: NextApiResponse<RuntimeStateResponse>) {
    const state = getRuntimeState();
    const cache = getCacheSnapshot();
    const nowMs = Date.now();

    return res.status(200).json({
        requestId: req.requestId,
        state,
        pairKey: cache?.pairKey ?? state.pair ?? '',
        asOfMs: cache?.asOfMs ?? nowMs,
        stalenessMs: Math.max(0, nowMs - (cache?.asOfMs ?? nowMs)),
        executionAllowed: cache?.executionAllowed ?? false,
        runtimeState: cache?.runtimeState ?? state.runtimeState ?? null,
    });
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
