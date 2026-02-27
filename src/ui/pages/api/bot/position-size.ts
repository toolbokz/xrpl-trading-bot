import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest, logSensitiveAction } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { validateBody, positionSizeSchema } from '../../../lib/validation/schemas';
import { logger } from '../../../../analytics/logger';

export const config = {
    api: { bodyParser: false },
};

async function handler(req: LocalRequest, res: NextApiResponse) {
    // Validate input with zod
    const validation = validateBody(req.parsedBody, positionSizeSchema);
    if (!validation.success) {
        return res.status(400).json({
            error: 'Invalid input',
            details: validation.errors,
            requestId: req.requestId,
        });
    }

    try {
        const { size } = validation.data;
        const runtime = ensureRuntimeHooks();
        runtime.setPositionSize(size);

        // Audit log sensitive action
        await logSensitiveAction(req.requestId, 'bot:position_size', { size });

        res.status(200).json({ message: 'Position size updated', size, requestId: req.requestId });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to update position size';
        logger.error({ err }, '[API /bot/position-size] Error');
        res.status(400).json({ error: errorMessage, requestId: req.requestId });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['POST'] });
