import { OfferCreate, xrpToDrops } from 'xrpl';
import { TradingPair } from '../config';
import { toXrplCurrency, XrplCurrency } from '../xrpl/currency';
import { shouldCrossSpread } from './qualityGate';

export type TradeSide = 'BUY' | 'SELL';

export type TradingLeg = XrplCurrency;

export interface NormalizedPair {
    base: TradingLeg;
    quote: TradingLeg;
    symbol: string;
}

export interface TradeIntent {
    pair: TradingPair;
    side: TradeSide;
    amount: number; // base amount
    price: number; // quote per base
    invertPair?: boolean;
    /** Expected execution price for slippage calculation */
    expectedPrice?: number;
}

export interface NormalizedTradeIntent {
    pair: NormalizedPair;
    side: TradeSide;
    amount: number;
    price: number;
}

export interface MakerQuoteInput {
    mid: number;
    side: 'buy' | 'sell';
    spreadBps: number;
    volatilityBps: number;
    stalenessMs: number;
    minTick: number;
}

export interface MakerDecisionInput {
    expectedEdgeBps: number;
    feesBps: number;
    slippageBudgetBps: number;
}

const isXRP = (code: string): boolean => code.toUpperCase() === 'XRP';

const toPrecisionString = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error('Amount and price must be positive finite numbers');
    }
    const str = value.toPrecision(15);
    return str.replace(/\.0+$|(?<=\.\d*?)0+$/g, '').replace(/\.$/, '');
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const roundToTick = (price: number, tick: number, side: 'buy' | 'sell'): number => {
    const safeTick = Number.isFinite(tick) && tick > 0 ? tick : 0.000001;
    const ticks = price / safeTick;
    const roundedTicks = side === 'buy' ? Math.floor(ticks) : Math.ceil(ticks);
    return Math.max(safeTick, roundedTicks * safeTick);
};

export const normalizePair = (pair: TradingPair, opts?: { invert?: boolean }): NormalizedPair => {
    const inverted = !!opts?.invert;
    const baseCurrency = inverted ? pair.quoteCurrency : pair.baseCurrency;
    const quoteCurrency = inverted ? pair.baseCurrency : pair.quoteCurrency;

    if (baseCurrency.toUpperCase() === quoteCurrency.toUpperCase()) {
        throw new Error('Base and quote currency must differ');
    }

    const baseIssuer = isXRP(baseCurrency) ? undefined : (inverted ? pair.quoteIssuer ?? pair.issuer : pair.baseIssuer ?? pair.issuer);
    const quoteIssuer = isXRP(quoteCurrency) ? undefined : (inverted ? pair.baseIssuer ?? pair.issuer : pair.quoteIssuer ?? pair.issuer);
    const normBase = toXrplCurrency({ currency: baseCurrency, issuer: baseIssuer as any });
    const normQuote = toXrplCurrency({ currency: quoteCurrency, issuer: quoteIssuer as any });

    return {
        base: normBase,
        quote: normQuote,
        symbol: `${normBase.currency}/${normQuote.currency}`,
    };
};

export const normalizeIntent = (intent: TradeIntent): NormalizedTradeIntent => {
    if (!Number.isFinite(intent.price) || intent.price <= 0) {
        throw new Error('Price must be positive');
    }
    if (!Number.isFinite(intent.amount) || intent.amount <= 0) {
        throw new Error('Amount must be positive');
    }

    const inverted = !!intent.invertPair;
    const pair = normalizePair(intent.pair, { invert: inverted });
    const price = inverted ? 1 / intent.price : intent.price;

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error('Price became invalid after inversion');
    }

    return {
        pair,
        side: intent.side,
        amount: intent.amount,
        price,
    };
};

const toXRPLAmount = (leg: TradingLeg, value: number): OfferCreate['TakerGets'] => {
    const normalized = toXrplCurrency(leg);
    if (normalized.currency === 'XRP') {
        return xrpToDrops(value);
    }
    const issued = normalized as Extract<XrplCurrency, { issuer: string }>;
    return { currency: issued.currency, issuer: issued.issuer, value: toPrecisionString(value) } as any;
};

export const computeMakerQuote = (input: MakerQuoteInput): number => {
    const mid = Number.isFinite(input.mid) && input.mid > 0 ? input.mid : 0;
    const spread = Math.max(0, Number.isFinite(input.spreadBps) ? input.spreadBps : 0);
    const volatility = Math.max(0, Number.isFinite(input.volatilityBps) ? input.volatilityBps : 0);
    const stalenessMs = Math.max(0, Number.isFinite(input.stalenessMs) ? input.stalenessMs : 0);

    if (mid <= 0) {
        return 0;
    }

    const halfSpreadBps = spread / 2;
    const stalenessBps = stalenessMs / 500;
    const widthBps = clamp(halfSpreadBps + (volatility * 0.25) + stalenessBps, 0.5, 250);
    const rawOffset = (mid * widthBps) / 10_000;

    const targetPrice = input.side === 'buy' ? mid - rawOffset : mid + rawOffset;
    return roundToTick(targetPrice, input.minTick, input.side);
};

export const shouldCrossForEdge = (input: MakerDecisionInput): boolean => shouldCrossSpread({
    expectedEdgeBps: input.expectedEdgeBps,
    feesBps: input.feesBps,
    slippageBudgetBps: input.slippageBudgetBps,
});

export const buildOfferCreate = (intent: NormalizedTradeIntent): Pick<OfferCreate, 'TakerGets' | 'TakerPays'> => {
    const baseAmount = intent.amount;
    const quoteAmount = intent.amount * intent.price;

    // XRPL OfferCreate semantics:
    // - TakerGets = what you are SELLING (what the taker receives from you)
    // - TakerPays = what you are BUYING (what the taker pays to you)

    const side = intent.side;
    if (side === 'BUY') {
        // BUY base: you SELL quote, you RECEIVE base
        // TakerGets = quote (you sell), TakerPays = base (you receive)
        return {
            TakerGets: toXRPLAmount(intent.pair.quote, quoteAmount),
            TakerPays: toXRPLAmount(intent.pair.base, baseAmount),
        };
    }

    // SELL base: you SELL base, you RECEIVE quote
    // TakerGets = base (you sell), TakerPays = quote (you receive)
    return {
        TakerGets: toXRPLAmount(intent.pair.base, baseAmount),
        TakerPays: toXRPLAmount(intent.pair.quote, quoteAmount),
    };
};

export const buildIntentSymbol = (pair: NormalizedPair): string => pair.symbol;
