import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest, logSensitiveAction } from '../../../lib/localApi';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { findInstrument, isValidPairKey } from '../../../../market/instrumentRegistry';
import { validateBody, tradingPairSchema } from '../../../lib/validation/schemas';
import { logger } from '../../../../analytics/logger';
import { resetHealthTracking } from '../../api/market/health';

export const config = {
    api: { bodyParser: false },
};

async function handler(req: LocalRequest, res: NextApiResponse) {
    // Validate input with zod
    const validation = validateBody(req.parsedBody, tradingPairSchema);
    if (!validation.success) {
        return res.status(400).json({
            error: 'Invalid input',
            code: 'VALIDATION_ERROR',
            details: validation.errors,
            requestId: req.requestId,
        });
    }

    const { pairKey } = validation.data;

    // Runtime guard: only allow pairs from Instrument Registry
    if (!isValidPairKey(pairKey)) {
        return res.status(400).json({
            error: `Trading pair not allowed: ${pairKey}. Only registered instruments are supported.`,
            code: 'INVALID_PAIR',
            requestId: req.requestId,
        });
    }

    const instrument = findInstrument(pairKey);
    if (!instrument) {
        return res.status(400).json({
            error: 'Unknown trading pair',
            code: 'PAIR_NOT_FOUND',
            requestId: req.requestId,
        });
    }

    try {
        const runtime = ensureRuntimeHooks();

        // ── Availability Safety Check ────────────────────────────────────
        // Reject pair switches to BLOCKED pairs (issuer frozen, etc.)
        const avail = runtime.getPairAvailability(pairKey);
        if (avail && avail.verdict === 'BLOCKED') {
            return res.status(400).json({
                error: `Pair ${pairKey} is blocked: ${avail.details.join('; ')}`,
                code: 'PAIR_BLOCKED',
                availability: avail.verdict,
                reasons: avail.reasons,
                requestId: req.requestId,
            });
        }

        const switchResult = runtime.setActivePair(pairKey);
        if (!switchResult.success) {
            return res.status(400).json({
                error: switchResult.error || 'Failed to switch trading pair',
                code: 'UPDATE_FAILED',
                requestId: req.requestId,
            });
        }

        // Reset health tracking timestamps so stale data from the previous pair
        // doesn't bleed into the new pair's health assessment.
        resetHealthTracking();

        // Audit log sensitive action
        await logSensitiveAction(req.requestId, 'bot:trading_pair', { pairKey });

        res.status(200).json({
            message: 'Trading pair updated',
            activePair: switchResult.activePair,
            pending: switchResult.pending,
            ...(switchResult.switchId ? { switchId: switchResult.switchId } : {}),
            pair: {
                key: instrument.key,
                base: instrument.base,
                quote: instrument.quote,
                description: instrument.description,
                liquidity: instrument.liquidity,
                network: instrument.network,
            },
            availability: avail?.verdict ?? null,
            requestId: req.requestId,
        });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to update trading pair';
        logger.error({ err }, '[API /bot/trading-pair] Error');
        res.status(400).json({
            error: errorMessage,
            code: 'UPDATE_FAILED',
            requestId: req.requestId,
        });
    }
}

export default withLocalApi(handler, { methods: ['POST'] });
