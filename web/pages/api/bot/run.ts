import type { NextApiResponse } from 'next';
import { withBotAuth, AuthenticatedRequest } from '../../../lib/botAuth';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';

// Disable body parser for HMAC signature verification
export const config = {
    api: {
        bodyParser: false,
    },
};

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
        ensureRuntimeHooks();
        const state = await botController.run();
        res.status(200).json({ state, message: 'Bot is now running' });
    } catch (err: any) {
        console.error('[API /bot/run] Error:', err);
        const errorMessage = err?.message || 'Failed to start bot';
        res.status(400).json({
            error: errorMessage,
            state: botController.getState(),
            details: process.env.NODE_ENV === 'development' ? err?.stack : undefined
        });
    }
}

export default withBotAuth(handler, {
    permission: 'bot:run',
    methods: ['POST'],
});
