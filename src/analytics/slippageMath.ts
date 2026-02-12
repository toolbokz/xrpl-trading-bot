import { logger } from './logger';

export type SlippageSide = 'buy' | 'sell';
export type ExpectedPriceSource = 'intent' | 'mid' | 'bbo' | 'fallback_intent';

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
    logger.warn({
        source: context.source,
        side: context.side,
        expectedPrice: context.expectedPrice,
        fillPrice: context.fillPrice,
        baseline: context.baseline ?? 'unknown',
        pairKey: context.pairKey ?? null,
        txHash: context.txHash ?? null,
    }, 'Invalid slippage inputs (non-positive or missing baseline/fill)');
}
