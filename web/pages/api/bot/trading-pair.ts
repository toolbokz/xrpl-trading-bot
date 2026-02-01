import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { findTradingPair, toBotTradingPair } from '../../../lib/tradingPairs';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { pairKey } = req.body as { pairKey?: string };
    if (!pairKey) {
        return res.status(400).json({ error: 'pairKey is required' });
    }

    const option = findTradingPair(pairKey);
    if (!option) {
        return res.status(400).json({ error: 'Unknown trading pair' });
    }

    try {
        const runtime = ensureRuntimeHooks();
        runtime.setTradingPair(toBotTradingPair(option));
        res.status(200).json({ message: 'Trading pair updated', pair: option });
    } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Failed to update trading pair' });
    }
}
