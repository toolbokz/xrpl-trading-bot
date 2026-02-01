import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { size } = req.body as { size?: number };
        if (!Number.isFinite(size) || (size as number) <= 0) {
            return res.status(400).json({ error: 'Size must be a positive number' });
        }
        const runtime = ensureRuntimeHooks();
        runtime.setPositionSize(size as number);
        res.status(200).json({ message: 'Position size updated', size });
    } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Failed to update position size' });
    }
}
