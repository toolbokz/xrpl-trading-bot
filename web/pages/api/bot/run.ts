import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest, logSensitiveAction } from '../../../lib/localApi';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { logger } from '../../../../src/analytics/logger';

export const config = {
    api: { bodyParser: false },
};

async function handler(req: LocalRequest, res: NextApiResponse) {
    // Idempotent: if already running, return success instead of throwing
    const currentState = botController.getState();
    if (currentState === 'RUNNING') {
        return res.status(200).json({
            state: currentState,
            message: 'Bot already running',
            requestId: req.requestId
        });
    }

    try {
        ensureRuntimeHooks();
        const state = await botController.run();

        // Audit log sensitive action
        await logSensitiveAction(req.requestId, 'bot:run', { previousState: currentState });

        res.status(200).json({ state, message: 'Bot is now running', requestId: req.requestId });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to start bot';
        logger.error({ err }, '[API /bot/run] Error');
        res.status(400).json({
            error: errorMessage,
            state: botController.getState(),
            requestId: req.requestId,
        });
    }
}

export default withLocalApi(handler, { methods: ['POST'] });
