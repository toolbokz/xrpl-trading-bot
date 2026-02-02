/**
 * Trading Pairs - Frontend Re-export
 * 
 * This module re-exports from the shared trading pairs module for frontend use.
 * DO NOT add pairs here - use src/config/tradingPairs.ts instead.
 * 
 * @module lib/tradingPairs
 */

// Re-export everything from the shared module
export {
    TRADING_PAIRS,
    type TradingPair,
    type CurrencySide,
    type LiquidityLevel,
    type Network,
    type LegacyTradingPair,
    getPair,
    findPair,
    listPairs,
    isValidPairKey,
    assertValidPair,
    toLegacyPair,
    fromLegacyPair,
} from '../../src/config/tradingPairs';

// Legacy compatibility - map to old types
import { TRADING_PAIRS, TradingPair, toLegacyPair, findPair } from '../../src/config/tradingPairs';

/**
 * @deprecated Use TradingPair from src/config/tradingPairs instead
 */
export type TradingPairOption = TradingPair;

/**
 * @deprecated Use TRADING_PAIRS from src/config/tradingPairs instead
 */
export const tradingPairs: readonly TradingPair[] = TRADING_PAIRS;

/**
 * @deprecated Use findPair from src/config/tradingPairs instead
 */
export const findTradingPair = findPair;

/**
 * @deprecated Use LegacyTradingPair from src/config/tradingPairs instead
 */
export type BotTradingPair = {
    baseCurrency: string;
    baseIssuer?: string | undefined;
    quoteCurrency: string;
    quoteIssuer?: string | undefined;
    issuer?: string | undefined; // legacy fallback
    description?: string | undefined;
};

/**
 * @deprecated Use toLegacyPair from src/config/tradingPairs instead
 */
export const toBotTradingPair = (option: TradingPair): BotTradingPair => {
    return toLegacyPair(option);
};
