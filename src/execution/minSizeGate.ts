import type { TradingPair } from '../config';
import { canonicalizePairKey } from '../xrpl/currency';
import type { TradeSide } from './offerBuilder';

const DEFAULT_MIN_BASE_XRP = 5;
const DEFAULT_MIN_QUOTE_RLUSD = 5;
const EPSILON = 1e-12;

export type MinSizeGateReason =
    | 'invalid-pair'
    | 'invalid-side'
    | 'invalid-amount-base'
    | 'invalid-price'
    | 'base-below-min'
    | 'quote-below-min';

export interface MinSizeGateResult {
    ok: boolean;
    reason: MinSizeGateReason | null;
}

export interface MinSizeGateConfig {
    minBaseXrp: number;
    minQuoteRlusd: number;
}

export interface EnforceMinSizeInput {
    pair: TradingPair | string;
    side: TradeSide | 'buy' | 'sell';
    amountBase: number;
    price: number;
}

const normalizeNonNegative = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
};

const normalizePairKey = (pair: TradingPair | string): string => {
    if (typeof pair === 'string') {
        const normalized = canonicalizePairKey(pair);
        return normalized.trim();
    }
    return canonicalizePairKey(`${pair.baseCurrency}/${pair.quoteCurrency}`).trim();
};

const normalizeSide = (side: TradeSide | 'buy' | 'sell'): TradeSide | null => {
    if (side === 'BUY' || side === 'buy') return 'BUY';
    if (side === 'SELL' || side === 'sell') return 'SELL';
    return null;
};

export const getMinSizeGateConfig = (env: NodeJS.ProcessEnv = process.env): MinSizeGateConfig => ({
    minBaseXrp: normalizeNonNegative(env.EXECUTION_MIN_BASE_XRP, DEFAULT_MIN_BASE_XRP),
    minQuoteRlusd: normalizeNonNegative(env.EXECUTION_MIN_QUOTE_RLUSD, DEFAULT_MIN_QUOTE_RLUSD),
});

export const enforceMinSize = (
    input: EnforceMinSizeInput,
    config: MinSizeGateConfig = getMinSizeGateConfig(),
): MinSizeGateResult => {
    const pairKey = normalizePairKey(input.pair);
    if (!pairKey) {
        return { ok: false, reason: 'invalid-pair' };
    }

    const normalizedSide = normalizeSide(input.side);
    if (!normalizedSide) {
        return { ok: false, reason: 'invalid-side' };
    }

    const amountBase = Number(input.amountBase);
    if (!Number.isFinite(amountBase) || amountBase <= 0) {
        return { ok: false, reason: 'invalid-amount-base' };
    }

    const limitPrice = Number(input.price);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
        return { ok: false, reason: 'invalid-price' };
    }

    // Base/quote semantics are canonical and side-independent:
    // base = XRP amount, quote = RLUSD notional.
    const quoteNotional = amountBase * limitPrice;
    if (!Number.isFinite(quoteNotional) || quoteNotional <= 0) {
        return { ok: false, reason: 'invalid-price' };
    }

    if (amountBase + EPSILON < config.minBaseXrp) {
        return { ok: false, reason: 'base-below-min' };
    }

    if (quoteNotional + EPSILON < config.minQuoteRlusd) {
        return { ok: false, reason: 'quote-below-min' };
    }

    return { ok: true, reason: null };
};
