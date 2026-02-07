/**
 * Trading Pairs — Frontend Interception Layer
 *
 * Delegates to the Instrument Registry for all pair data.
 * All UI code should import from this module (never from config/tradingPairs).
 *
 * Exports match the legacy surface area for backward compatibility
 * but are backed by the SQLite-based Instrument Registry.
 *
 * @module lib/tradingPairs
 */

// ── Re-export from Instrument Registry (single source of truth) ─────────────
export {
    getInstruments,
    getActiveInstruments,
    findInstrument,
    getInstrument,
    isValidPairKey,
    listInstruments,
    toLegacyPair,
    fromLegacyPair,
    validateAllPairs,
    assertAllowedInstrument as assertValidPair,
    type Instrument,
    type CurrencySide,
    type LiquidityLevel,
    type Network,
    type LegacyTradingPair,
} from '../../market/instrumentRegistry';

import {
    getInstruments,
    findInstrument,
    toLegacyPair,
    type Instrument,
} from '../../market/instrumentRegistry';

// ── Backward-compatible aliases ─────────────────────────────────────────────

/** @deprecated Use Instrument instead */
export type TradingPair = Instrument;

/** @deprecated Use Instrument instead */
export type TradingPairOption = Instrument;

/**
 * Get all instruments. Backward-compatible with TRADING_PAIRS static array.
 * @deprecated Use getInstruments() instead of accessing TRADING_PAIRS directly.
 */
export const TRADING_PAIRS: readonly Instrument[] = getInstruments();

/**
 * @deprecated Use getInstruments() instead
 */
export const tradingPairs: readonly Instrument[] = getInstruments();

/**
 * Get instrument by key. Backward-compatible with getPair().
 */
export const getPair = (key: string): Instrument => {
    const inst = findInstrument(key);
    if (!inst) throw new Error(`Pair not found: ${key}`);
    return inst;
};

/**
 * Find instrument by key. Backward-compatible with findPair().
 */
export const findPair = findInstrument;

/**
 * @deprecated Use findInstrument() instead
 */
export const findTradingPair = findInstrument;

/**
 * List instruments with optional network filter.
 * Backward-compatible with listPairs().
 */
export const listPairs = (options?: { network?: 'mainnet' | 'testnet' }): readonly Instrument[] => {
    const all = getInstruments();
    if (!options?.network || options.network === 'testnet') return all;
    return all.filter((i) => i.network === options.network);
};

/** @deprecated Use LegacyTradingPair from instrumentRegistry instead */
export type BotTradingPair = {
    baseCurrency: string;
    baseIssuer?: string | undefined;
    quoteCurrency: string;
    quoteIssuer?: string | undefined;
    issuer?: string | undefined;
    description?: string | undefined;
};

/** @deprecated Use toLegacyPair() instead */
export const toBotTradingPair = (option: Instrument): BotTradingPair => {
    return toLegacyPair(option);
};
