import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { triggerUpdate, isSchedulerRunning } from '../../../../../src/analytics/adaptiveScheduler';
import { isAdaptiveEnabled } from '../../../../../src/analytics/adaptiveConfig';

export const config = {
    api: { bodyParser: true },
};

/**
 * Recompute API response
 */
export interface RecomputeApiResponse {
    requestId: string;
    timestamp: string;
    success: boolean;
    message: string;
}

/**
 * POST /api/analytics/adaptive/recompute
 *
 * Triggers an immediate adaptive learning update.
 */
function handler(req: LocalRequest, res: NextApiResponse<RecomputeApiResponse | { error: string }>) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        if (!isAdaptiveEnabled()) {
            return res.status(200).json({
                requestId: req.requestId,
                timestamp: new Date().toISOString(),
                success: false,
                message: 'Adaptive learning is disabled',
            });
        }

        if (!isSchedulerRunning()) {
            return res.status(200).json({
                requestId: req.requestId,
                timestamp: new Date().toISOString(),
                success: false,
                message: 'Scheduler not running - bot may not be started',
            });
        }

        triggerUpdate();

        return res.status(200).json({
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            success: true,
            message: 'Recompute triggered successfully',
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(handler);
