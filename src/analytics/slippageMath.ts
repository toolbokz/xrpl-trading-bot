import { logger } from './logger';

export type SlippageSide = 'buy' | 'sell';
export type ExpectedPriceSource = 'intent' | 'mid' | 'bbo' | 'fallback_intent';

const INVALID_SLIPPAGE_WARN_COOLDOWN_MS = Math.max(
    1000,
    parseInt(process.env.SLIPPAGE_INVALID_WARN_COOLDOWN_MS ?? '30000', 10) || 30000
);

interface InvalidSlippageWarnState {
    lastLoggedAt: number;
    suppressed: number;
}

const invalidSlippageWarnStates = new Map<string, InvalidSlippageWarnState>();

export interface ReciprocalCheckResult {
    reciprocalLike: boolean;
    reason?: string;
}

export function isReciprocalLikePrices(expectedPrice: number, fillPrice: number): ReciprocalCheckResult {
    if (!Number.isFinite(expectedPrice) || !Number.isFinite(fillPrice) || expectedPrice <= 0 || fillPrice <= 0) {
        return { reciprocalLike: false };
    }

    const reciprocalProduct = expectedPrice * fillPrice;
    const oppositeQuadrants =
        (expectedPrice > 1.05 && fillPrice < 0.95)
        || (expectedPrice < 0.95 && fillPrice > 1.05);

    if (oppositeQuadrants && Math.abs(reciprocalProduct - 1) < 0.02) {
        return {
            reciprocalLike: true,
            reason: `reciprocal-like-prices: expected=${expectedPrice}, fill=${fillPrice}, product=${reciprocalProduct}`,
        };
    }
    return { reciprocalLike: false };
}

/**
 * Canonical slippage:
 * positive = worse execution, negative = price improvement.
 */
export function computeCanonicalSlippageBps(
    side: SlippageSide,
    expectedPrice: number,
    fillPrice: number
): number | null {
    if (!Number.isFinite(expectedPrice) || expectedPrice <= 0) return null;
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;

    const reciprocal = isReciprocalLikePrices(expectedPrice, fillPrice);
    if (reciprocal.reciprocalLike) {
        return null;
    }

    if (side === 'buy') {
        return ((fillPrice - expectedPrice) / expectedPrice) * 10_000;
    }
    return ((expectedPrice - fillPrice) / expectedPrice) * 10_000;
}

export function warnInvalidSlippageInputs(context: {
    source: string;
    side: SlippageSide | null;
    expectedPrice: number | null | undefined;
    fillPrice: number | null | undefined;
    baseline?: ExpectedPriceSource | 'unknown';
    pairKey?: string | null;
    txHash?: string | null;
}): void {
    const key = [
        context.source,
        context.pairKey ?? 'all-pairs',
        context.side ?? 'unknown-side',
        context.baseline ?? 'unknown-baseline',
    ].join('|');

    const now = Date.now();
    const state = invalidSlippageWarnStates.get(key);
    if (state && (now - state.lastLoggedAt) < INVALID_SLIPPAGE_WARN_COOLDOWN_MS) {
        state.suppressed += 1;
        return;
    }

    const suppressedSinceLast = state?.suppressed ?? 0;
    invalidSlippageWarnStates.set(key, {
        lastLoggedAt: now,
        suppressed: 0,
    });

    logger.warn({
        source: context.source,
        side: context.side,
        expectedPrice: context.expectedPrice,
        fillPrice: context.fillPrice,
        baseline: context.baseline ?? 'unknown',
        pairKey: context.pairKey ?? null,
        txHash: context.txHash ?? null,
        ...(suppressedSinceLast > 0 ? { suppressedSinceLast } : {}),
    }, 'Invalid slippage inputs (non-positive or missing baseline/fill)');
}

export function __resetInvalidSlippageWarningThrottleForTests(): void {
    invalidSlippageWarnStates.clear();
}
