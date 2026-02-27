import type { DepthBook, DepthBookLevel } from './depthPricing';

export type DepthCheckErrorCode = 'NO_ORDERBOOK';

export interface DepthAvailabilityResult {
    fillableBase: number;
    hasDepth: boolean;
    levelsWalked: number;
    error: DepthCheckErrorCode | null;
}

const DEPTH_EPSILON = 1e-12;

function isFinitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function normalizeLevels(levels: DepthBookLevel[] | undefined, side: 'BUY' | 'SELL', maxLevels: number): DepthBookLevel[] {
    const filtered = (levels ?? [])
        .filter((level) => isFinitePositive(level.price) && isFinitePositive(level.baseSize))
        .map((level) => ({
            price: level.price,
            baseSize: level.baseSize,
        }));
    filtered.sort((a, b) => (side === 'BUY' ? a.price - b.price : b.price - a.price));
    return filtered.slice(0, maxLevels);
}

export function evaluateDepthAvailability(input: {
    side: 'BUY' | 'SELL';
    requiredBase: number;
    minRequiredBase: number;
    maxLevels: number;
    book: Partial<DepthBook> | null | undefined;
}): DepthAvailabilityResult {
    const maxLevels = Number.isFinite(input.maxLevels)
        ? Math.max(1, Math.floor(input.maxLevels))
        : 1;
    const requiredBase = Number.isFinite(input.requiredBase) ? Math.max(0, input.requiredBase) : 0;
    const minRequiredBase = Number.isFinite(input.minRequiredBase) ? Math.max(0, input.minRequiredBase) : 0;
    const sourceLevels = input.side === 'BUY' ? input.book?.asks : input.book?.bids;

    if (!Array.isArray(sourceLevels) || sourceLevels.length === 0) {
        return {
            fillableBase: 0,
            hasDepth: false,
            levelsWalked: 0,
            error: 'NO_ORDERBOOK',
        };
    }

    const levels = normalizeLevels(sourceLevels, input.side, maxLevels);
    if (levels.length === 0) {
        return {
            fillableBase: 0,
            hasDepth: false,
            levelsWalked: 0,
            error: 'NO_ORDERBOOK',
        };
    }

    let remaining = requiredBase;
    let fillableBase = 0;
    let levelsWalked = 0;
    for (const level of levels) {
        if (remaining <= DEPTH_EPSILON) break;
        const takeBase = Math.min(remaining, level.baseSize);
        if (!isFinitePositive(takeBase)) continue;
        fillableBase += takeBase;
        remaining -= takeBase;
        levelsWalked += 1;
    }

    return {
        fillableBase,
        hasDepth: fillableBase + DEPTH_EPSILON >= minRequiredBase,
        levelsWalked,
        error: null,
    };
}