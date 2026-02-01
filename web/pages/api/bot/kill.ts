import type { NextApiResponse } from 'next';
import { withBotAuth, AuthenticatedRequest } from '../../../lib/botAuth';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';

export const config = {
    api: { bodyParser: false },
};

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
        ensureRuntimeHooks();
        const state = await botController.kill();
        res.status(200).json({ state, message: 'Bot has been stopped' });
    } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Failed to stop bot', state: botController.getState() });
    }
}

export default withBotAuth(handler, {
    permission: 'bot:kill',
    methods: ['POST'],
});
