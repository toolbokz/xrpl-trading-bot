import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { getAdaptiveState, isAdaptiveEnabled } from '../../../../../analytics/adaptiveConfig';
import { AdaptiveState } from '../../../../../analytics/adaptiveLearner';

export const config = {
    api: { bodyParser: false },
};

/**
 * Adaptive state API response
 */
export interface AdaptiveStateApiResponse {
    requestId: string;
    timestamp: string;
    enabled: boolean;
    state: {
        updatedAt: number;
        tunings: AdaptiveState['tunings'];
    };
}

/**
 * GET /api/analytics/adaptive/state
 *
 * Returns the current adaptive learning state including all tunings.
 */
function handler(req: LocalRequest, res: NextApiResponse<AdaptiveStateApiResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const enabled = isAdaptiveEnabled();
        const state = getAdaptiveState();

        const response: AdaptiveStateApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            enabled,
            state: {
                updatedAt: state.updatedAt,
                tunings: state.tunings,
            },
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(handler);
