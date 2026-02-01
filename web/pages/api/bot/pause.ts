import type { NextApiRequest, NextApiResponse } from 'next';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
        ensureRuntimeHooks();
        const state = await botController.pause();
        res.status(200).json({ state, message: 'Bot is now paused' });
    } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Failed to pause bot', state: botController.getState() });
    }
}
