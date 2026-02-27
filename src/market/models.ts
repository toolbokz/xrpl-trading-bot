import { OrderBookState } from '../utils/types';
import { Trade } from './tradeTape';
import { BOOK_CROSS_EPS_ABS } from './bookValidationEpsilon';

export interface DepthLevel {
    price: number;
    size: number;
}

export interface NormalizedTrade {
    id: string;
    pairKey: string;
    price: number;
    baseAmount: number;
    quoteAmount: number;
    side: 'buy' | 'sell';
    source: 'tape' | 'xrpl' | 'db';
    eventTimeMs: number;
    ingestTimeMs: number;
    isDuplicate: boolean;
    stalenessMs: number;
}

export interface OrderBookSnapshot {
    pairKey: string;
    sequence: number;
    eventTimeMs: number;
    ingestTimeMs: number;
    bids: DepthLevel[];
    asks: DepthLevel[];
    bestBid: number;
    bestAsk: number;
    spreadBps: number;
    depthNotional1Pct: number;
    stalenessMs: number;
    healthScore: number;
}

export interface AMMSnapshot {
    pairKey: string;
    eventTimeMs: number;
    ingestTimeMs: number;
    poolBase: number;
    poolQuote: number;
    impliedMid: number;
    feeBps: number;
    stalenessMs: number;
    healthScore: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const sanitizePositive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

const computeSpreadBps = (bestBid: number, bestAsk: number): number => {
    if (bestBid <= 0 || bestAsk <= 0) {
        return 0;
    }

    const diff = bestAsk - bestBid;
    if (diff < 0) {
        if (Math.abs(diff) <= BOOK_CROSS_EPS_ABS) {
            return 0;
        }
        return 0;
    }

    return (diff / bestAsk) * 10_000;
};

const computeDepthNotionalNearTop = (
    bids: DepthLevel[],
    asks: DepthLevel[],
    bestBid: number,
    bestAsk: number,
): number => {
    if (bestBid <= 0 || bestAsk <= 0) {
        return 0;
    }

    const bidFloor = bestBid * 0.99;
    const askCeiling = bestAsk * 1.01;

    const bidNotional = bids
        .filter((level) => level.price >= bidFloor)
        .reduce((sum, level) => sum + (level.price * level.size), 0);

    const askNotional = asks
        .filter((level) => level.price <= askCeiling)
        .reduce((sum, level) => sum + (level.price * level.size), 0);

    return bidNotional + askNotional;
};

const computeStalenessPenalty = (stalenessMs: number): number => {
    if (stalenessMs <= 500) return 0;
    if (stalenessMs <= 2_000) return 5;
    if (stalenessMs <= 5_000) return 15;
    if (stalenessMs <= 10_000) return 30;
    return 50;
};

const computeSpreadPenalty = (spreadBps: number): number => {
    if (spreadBps <= 5) return 0;
    if (spreadBps <= 20) return 4;
    if (spreadBps <= 50) return 10;
    if (spreadBps <= 100) return 20;
    return 35;
};

const computeDepthPenalty = (depthNotional: number): number => {
    if (depthNotional >= 50_000) return 0;
    if (depthNotional >= 10_000) return 5;
    if (depthNotional >= 2_500) return 15;
    if (depthNotional >= 500) return 25;
    return 40;
};

const computeHealthScoreFromSignals = (stalenessMs: number, spreadBps: number, depthNotional: number): number => {
    const score = 100
        - computeStalenessPenalty(stalenessMs)
        - computeSpreadPenalty(spreadBps)
        - computeDepthPenalty(depthNotional);
    return clamp(Math.round(score), 0, 100);
};

export const normalizeTrade = (
    input: Trade,
    nowMs: number,
    lastEventMs: number,
    source: NormalizedTrade['source'] = 'tape',
    isDuplicate = false,
): NormalizedTrade => {
    const sanitizedNow = Math.floor(nowMs);
    const eventTimeMs = Math.max(Math.floor(input.ts), Math.floor(lastEventMs));
    const baseAmount = sanitizePositive(input.sizeBase);
    const quoteAmount = sanitizePositive(input.sizeQuote || (input.sizeBase * input.price));
    const stalenessMs = Math.max(0, sanitizedNow - eventTimeMs);

    return {
        id: input.id,
        pairKey: input.pairKey,
        price: sanitizePositive(input.price),
        baseAmount,
        quoteAmount,
        side: input.side,
        source,
        eventTimeMs,
        ingestTimeMs: sanitizedNow,
        isDuplicate,
        stalenessMs,
    };
};

export const normalizeOrderBookSnapshot = (
    pairKey: string,
    state: OrderBookState,
    nowMs: number,
    sequence: number,
): OrderBookSnapshot => {
    const ingestTimeMs = Math.floor(nowMs);
    const eventTimeMs = Math.max(0, Math.min(ingestTimeMs, Math.floor(state.lastUpdated || 0)));

    const bids: DepthLevel[] = state.bids.map((level) => ({
        price: sanitizePositive(level.price),
        size: sanitizePositive(level.quantity),
    })).filter((level) => level.price > 0 && level.size > 0);

    const asks: DepthLevel[] = state.asks.map((level) => ({
        price: sanitizePositive(level.price),
        size: sanitizePositive(level.quantity),
    })).filter((level) => level.price > 0 && level.size > 0);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const spreadBps = computeSpreadBps(bestBid, bestAsk);
    const stalenessMs = Math.max(0, ingestTimeMs - eventTimeMs);
    const depthNotional1Pct = computeDepthNotionalNearTop(bids, asks, bestBid, bestAsk);
    const healthScore = computeHealthScoreFromSignals(stalenessMs, spreadBps, depthNotional1Pct);

    return {
        pairKey,
        sequence: Math.max(0, Math.floor(sequence)),
        eventTimeMs,
        ingestTimeMs,
        bids,
        asks,
        bestBid,
        bestAsk,
        spreadBps,
        depthNotional1Pct,
        stalenessMs,
        healthScore,
    };
};

export const normalizeAmmSnapshot = (
    input: {
        pairKey: string;
        eventTimeMs: number;
        poolBase: number;
        poolQuote: number;
        feeBps: number;
    },
    nowMs: number,
): AMMSnapshot => {
    const ingestTimeMs = Math.floor(nowMs);
    const eventTimeMs = Math.max(0, Math.min(ingestTimeMs, Math.floor(input.eventTimeMs)));
    const poolBase = sanitizePositive(input.poolBase);
    const poolQuote = sanitizePositive(input.poolQuote);
    const impliedMid = poolBase > 0 ? poolQuote / poolBase : 0;
    const stalenessMs = Math.max(0, ingestTimeMs - eventTimeMs);
    const healthScore = computeHealthScoreFromSignals(stalenessMs, 0, poolQuote);

    return {
        pairKey: input.pairKey,
        eventTimeMs,
        ingestTimeMs,
        poolBase,
        poolQuote,
        impliedMid,
        feeBps: clamp(Math.round(input.feeBps), 0, 10_000),
        stalenessMs,
        healthScore,
    };
};

export const computeMarketHealth = (args: {
    trade: NormalizedTrade | null;
    book: OrderBookSnapshot | null;
    amm: AMMSnapshot | null;
}): number => {
    const bookScore = args.book?.healthScore;
    const tradeStaleness = args.trade?.stalenessMs;
    const ammScore = args.amm?.healthScore;

    let score = 100;
    if (bookScore !== undefined) {
        score = Math.min(score, bookScore);
    }
    if (ammScore !== undefined) {
        score = Math.round((score * 0.7) + (ammScore * 0.3));
    }
    if (tradeStaleness !== undefined) {
        score -= computeStalenessPenalty(tradeStaleness);
    }

    if (!args.book && !args.trade && !args.amm) {
        score = 0;
    }

    return clamp(score, 0, 100);
};
