import type { NextApiRequest, NextApiResponse } from 'next';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
    ensureRuntimeHooks();
    const state = botController.getState();
    res.status(200).json({ state, message: `Bot state is ${state.toLowerCase()}` });
}
