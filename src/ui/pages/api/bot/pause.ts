import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest, logSensitiveAction } from '../../../lib/localApi';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { logger } from '../../../../analytics/logger';

export const config = {
    api: { bodyParser: false },
};

async function handler(req: LocalRequest, res: NextApiResponse) {
    try {
        ensureRuntimeHooks();
        const previousState = botController.getState();
        const state = await botController.pause();

        // Audit log sensitive action
        await logSensitiveAction(req.requestId, 'bot:pause', { previousState });

        res.status(200).json({ state, message: 'Bot is now paused', requestId: req.requestId });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to pause bot';
        logger.error({ err }, '[API /bot/pause] Error');
        res.status(400).json({
            error: errorMessage,
            state: botController.getState(),
            requestId: req.requestId,
        });
    }
}

export default withLocalApi(handler, { methods: ['POST'] });
