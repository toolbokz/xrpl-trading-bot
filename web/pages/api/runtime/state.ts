import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getRuntimeState, RuntimePublicState } from '../../../../src/runtime/runtimeSingleton';

/**
 * Response shape for GET /api/runtime/state.
 *
 * Exposes the full runtime telemetry snapshot (FSM state, feed health,
 * ledger progress, execution gate verdict, market health quorum).
 */
export interface RuntimeStateResponse {
    requestId: string;
    /** Full RuntimePublicState snapshot (includes telemetry). */
    state: RuntimePublicState;
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

    return res.status(200).json({
        requestId: req.requestId,
        state,
    });
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
