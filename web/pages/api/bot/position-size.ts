import type { NextApiResponse } from 'next';
import { withBotAuth, AuthenticatedRequest } from '../../../lib/botAuth';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { validateBody, positionSizeSchema } from '../../../lib/validation/schemas';

export const config = {
    api: { bodyParser: false },
};

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed', requestId: req.auth.requestId });
    }

    // Validate input with zod
    const validation = validateBody(req.parsedBody, positionSizeSchema);
    if (!validation.success) {
        return res.status(400).json({
            error: 'Invalid input',
            details: validation.errors,
            requestId: req.auth.requestId,
        });
    }

    try {
        const { size } = validation.data;
        const runtime = ensureRuntimeHooks();
        runtime.setPositionSize(size);
        res.status(200).json({ message: 'Position size updated', size, requestId: req.auth.requestId });
    } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Failed to update position size', requestId: req.auth.requestId });
    }
}

export default withBotAuth(handler, {
    permission: 'bot:position_size',
    methods: ['POST'],
});
