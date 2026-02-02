import type { NextApiResponse } from 'next';
import { withBotAuth, AuthenticatedRequest } from '../../../lib/botAuth';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { findTradingPair, toBotTradingPair } from '../../../lib/tradingPairs';
import { validateBody, tradingPairSchema } from '../../../lib/validation/schemas';

export const config = {
    api: { bodyParser: false },
};

function handler(req: AuthenticatedRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed', requestId: req.auth.requestId });
    }

    // Validate input with zod
    const validation = validateBody(req.parsedBody, tradingPairSchema);
    if (!validation.success) {
        return res.status(400).json({
            error: 'Invalid input',
            details: validation.errors,
            requestId: req.auth.requestId,
        });
    }

    const { pairKey } = validation.data;
    const option = findTradingPair(pairKey);
    if (!option) {
        return res.status(400).json({ error: 'Unknown trading pair', requestId: req.auth.requestId });
    }

    try {
        const runtime = ensureRuntimeHooks();
        runtime.setTradingPair(toBotTradingPair(option));
        res.status(200).json({ message: 'Trading pair updated', pair: option, requestId: req.auth.requestId });
    } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Failed to update trading pair', requestId: req.auth.requestId });
    }
}

export default withBotAuth(handler, {
    permission: 'bot:trading_pair',
    methods: ['POST'],
});
