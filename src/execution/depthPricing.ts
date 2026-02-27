export interface DepthBookLevel {
    /** Quote-per-base level price. */
    price: number;
    /** Base quantity available at this level. */
    baseSize: number;
}

export interface DepthBook {
    bids: DepthBookLevel[];
    asks: DepthBookLevel[];
}

export interface DepthFillComputation {
    fillableBase: number;
    vwap: number | null;
    worstPrice: number | null;
}

export interface DepthLimitChoice {
    limitPrice: number | null;
    fillableBase: number;
    expectedVwap: number | null;
    worstPrice: number | null;
}

export interface MidSlippageCheck {
    allowed: boolean;
    slippageBps: number | null;
}

function isFinitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function normalizeLevels(levels: DepthBookLevel[], side: 'BUY' | 'SELL'): DepthBookLevel[] {
    const filtered = levels
        .filter((level) => isFinitePositive(level.price) && isFinitePositive(level.baseSize))
        .map((level) => ({ price: level.price, baseSize: level.baseSize }));
    filtered.sort((a, b) => (side === 'BUY' ? a.price - b.price : b.price - a.price));
    return filtered;
}

/**
 * Walks depth levels and computes cumulative fill statistics up to desired base size.
 */
export function computeFill(bookLevels: DepthBookLevel[], desiredBase: number): DepthFillComputation {
    if (!isFinitePositive(desiredBase)) {
        return { fillableBase: 0, vwap: null, worstPrice: null };
    }

    let remaining = desiredBase;
    let fillableBase = 0;
    let filledQuote = 0;
    let worstPrice: number | null = null;

    for (const level of bookLevels) {
        if (remaining <= 1e-12) break;
        if (!isFinitePositive(level.price) || !isFinitePositive(level.baseSize)) continue;

        const takeBase = Math.min(remaining, level.baseSize);
        if (!isFinitePositive(takeBase)) continue;

        fillableBase += takeBase;
        filledQuote += takeBase * level.price;
        worstPrice = level.price;
        remaining -= takeBase;
    }

    if (!isFinitePositive(fillableBase) || !isFinitePositive(filledQuote)) {
        return { fillableBase: 0, vwap: null, worstPrice: null };
    }

    return {
        fillableBase,
        vwap: filledQuote / fillableBase,
        worstPrice,
    };
}

/**
 * Chooses an executable limit price based on book depth and a VWAP-based slippage budget.
 */
export function chooseLimitPrice(input: {
    side: 'BUY' | 'SELL' | 'buy' | 'sell';
    desiredBase: number;
    book: DepthBook;
    slippageBps: number;
}): DepthLimitChoice {
    const side = input.side === 'BUY' || input.side === 'buy' ? 'BUY' : 'SELL';
    const desiredBase = input.desiredBase;
    if (!isFinitePositive(desiredBase)) {
        return { limitPrice: null, fillableBase: 0, expectedVwap: null, worstPrice: null };
    }

    const sideLevels = side === 'BUY'
        ? normalizeLevels(input.book.asks ?? [], side)
        : normalizeLevels(input.book.bids ?? [], side);
    if (sideLevels.length === 0) {
        return { limitPrice: null, fillableBase: 0, expectedVwap: null, worstPrice: null };
    }

    // First pass: execution VWAP from currently available depth.
    const rawFill = computeFill(sideLevels, desiredBase);
    if (!isFinitePositive(rawFill.fillableBase) || rawFill.vwap == null) {
        return { limitPrice: null, fillableBase: 0, expectedVwap: null, worstPrice: null };
    }

    const slippageBps = Number.isFinite(input.slippageBps) ? Math.max(0, input.slippageBps) : 0;
    const slippageFactor = slippageBps / 10_000;
    const vwapCap = side === 'BUY'
        ? rawFill.vwap * (1 + slippageFactor)
        : rawFill.vwap * (1 - slippageFactor);

    // Second pass: enforce slippage cap around VWAP and recompute executable quantity.
    const cappedLevels = sideLevels.filter((level) => (
        side === 'BUY'
            ? level.price <= vwapCap + 1e-12
            : level.price + 1e-12 >= vwapCap
    ));
    const cappedFill = computeFill(cappedLevels, desiredBase);
    if (!isFinitePositive(cappedFill.fillableBase) || cappedFill.vwap == null || cappedFill.worstPrice == null) {
        return { limitPrice: null, fillableBase: 0, expectedVwap: null, worstPrice: null };
    }

    return {
        limitPrice: cappedFill.worstPrice,
        fillableBase: cappedFill.fillableBase,
        expectedVwap: cappedFill.vwap,
        worstPrice: cappedFill.worstPrice,
    };
}

/**
 * Guard against trading at a limit that is too far from the current mid.
 */
export function checkLimitVsMidSlippage(input: {
    side: 'BUY' | 'SELL';
    limitPrice: number | null;
    midPrice: number | null;
    maxSlippageBps: number;
}): MidSlippageCheck {
    if (!isFinitePositive(input.limitPrice ?? 0) || !isFinitePositive(input.midPrice ?? 0)) {
        return { allowed: true, slippageBps: null };
    }

    const maxSlippageBps = Number.isFinite(input.maxSlippageBps)
        ? Math.max(0, input.maxSlippageBps)
        : 0;
    const rawBps = ((input.limitPrice! - input.midPrice!) / input.midPrice!) * 10_000;
    const directional = input.side === 'BUY' ? rawBps : -rawBps;
    const slippageBps = Number.isFinite(directional) ? directional : null;
    if (slippageBps == null) {
        return { allowed: false, slippageBps: null };
    }

    return {
        allowed: slippageBps <= maxSlippageBps + 1e-9,
        slippageBps,
    };
}
