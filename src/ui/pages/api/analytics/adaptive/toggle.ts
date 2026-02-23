import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { withApiRouteContext } from '../../../../lib/localApi/withApiRouteContext';
import { setAdaptiveEnabled, isAdaptiveEnabled } from '../../../../../analytics/adaptiveConfig';

export const config = {
    api: { bodyParser: true },
};

/**
 * Toggle API request body
 */
interface ToggleRequestBody {
    enabled: boolean;
}

/**
 * Toggle API response
 */
export interface ToggleApiResponse {
    requestId: string;
    timestamp: string;
    enabled: boolean;
    message: string;
}

/**
 * POST /api/analytics/adaptive/toggle
 *
 * Enable or disable adaptive learning at runtime.
 * Does not delete state - just stops applying tunings.
 */
function handler(req: LocalRequest, res: NextApiResponse<ToggleApiResponse | { error: string }>) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const body = req.body as ToggleRequestBody;

        if (typeof body?.enabled !== 'boolean') {
            return res.status(400).json({ error: 'Missing required field: enabled (boolean)' });
        }

        const previousState = isAdaptiveEnabled();
        setAdaptiveEnabled(body.enabled);
        const newState = isAdaptiveEnabled();

        const action = newState ? 'enabled' : 'disabled';
        const message = previousState === newState
            ? `Adaptive learning was already ${action}`
            : `Adaptive learning ${action}`;

        return res.status(200).json({
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            enabled: newState,
            message,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(withApiRouteContext(handler));
