import type { NextApiResponse } from 'next';
import { withBotAuth, AuthenticatedRequest } from '../../../lib/botAuth';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';

export const config = {
    api: { bodyParser: false },
};

function handler(_req: AuthenticatedRequest, res: NextApiResponse) {
    ensureRuntimeHooks();
    const state = botController.getState();
    res.status(200).json({ state, message: `Bot state is ${state.toLowerCase()}` });
}

export default withBotAuth(handler, {
    permission: 'bot:status_read',
    methods: ['GET'],
});
