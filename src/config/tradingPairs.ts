/**
 * Trading Pairs — Backward-Compatible Delegation Layer
 *
 * This module now delegates to the Instrument Registry
 * (src/market/instrumentRegistry/) for all pair data.
 *
 * All existing exports are preserved for backward compatibility.
 * New code should import directly from the registry.
 *
 * @module config/tradingPairs
 * @see market/instrumentRegistry
 */

import { z } from 'zod';
import { isValidClassicAddress } from 'xrpl';

// Import registry functions (used for delegation)
import {
    getInstruments,
    findInstrument,
    getInstrument,
    isValidPairKey as registryIsValidPairKey,
    listInstruments as registryListInstruments,
    validateAllPairs as registryValidateAllPairs,
    toLegacyPair as registryToLegacyPair,
    fromLegacyPair as registryFromLegacyPair,
    type Instrument,
} from '../market/instrumentRegistry';

// =============================================================================
// Types (kept for backward compatibility — same shapes as before)
// =============================================================================

export type Network = 'mainnet' | 'testnet';
export type LiquidityLevel = 'high' | 'medium' | 'low';

export interface CurrencySide {
    currency: string;
    issuer?: string;
}

export interface TradingPair {
    /** Unique key like "XRP/RLUSD" */
    key: string;
    /** Base currency (left side of pair) */
    base: CurrencySide;
    /** Quote currency (right side of pair) */
    quote: CurrencySide;
    /** Human-readable description */
    description: string;
    /** Liquidity level indicator */
    liquidity: LiquidityLevel;
    /** Primary network for this pair (mainnet issuers) */
    network: Network;
}

/** Legacy format for backward compatibility with existing bot code */
export interface LegacyTradingPair {
    baseCurrency: string;
    baseIssuer?: string | undefined;
    quoteCurrency: string;
    quoteIssuer?: string | undefined;
    issuer?: string | undefined; // Legacy fallback
    description?: string | undefined;
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

// XRPL currency codes:
// - Standard: 3 alphanumeric chars (ISO 4217-like), e.g., "USD", "EUR", "XRP"
// - Non-standard: up to 20 bytes, commonly encoded as hex (40 hex chars) or ASCII
// For UI purposes, we allow alphanumeric codes 1-20 chars OR 40-char hex
const XRPL_CURRENCY_REGEX = /^[A-Za-z0-9]{1,20}$|^[A-Fa-f0-9]{40}$/;

export const currencySideSchema = z.object({
    currency: z.string()
        .min(1, 'Currency code required')
        .max(40, 'Currency code too long')
        .refine(
            (c) => c === 'XRP' || XRPL_CURRENCY_REGEX.test(c),
            'Invalid XRPL currency code'
        ),
    issuer: z.string().optional(),
}).refine(
    (side) => {
        // XRP must NOT have issuer
        if (side.currency.toUpperCase() === 'XRP') {
            return !side.issuer;
        }
        // Non-XRP must have valid issuer
        return side.issuer && isValidClassicAddress(side.issuer);
    },
    {
        message: 'XRP must not have issuer; issued currencies require valid issuer address',
    }
);

export const tradingPairSchema = z.object({
    key: z.string().min(1).max(50),
    base: currencySideSchema,
    quote: currencySideSchema,
    description: z.string().min(1).max(100),
    liquidity: z.enum(['high', 'medium', 'low']),
    network: z.enum(['mainnet', 'testnet']),
}).refine(
    (pair) => pair.base.currency !== pair.quote.currency,
    { message: 'Base and quote currency must differ' }
);

export const tradingPairsArraySchema = z.array(tradingPairSchema);

// =============================================================================
// TRADING PAIRS - SOURCE OF TRUTH
// =============================================================================

/**
 * The canonical list of trading pairs.
 * DO NOT ADD MORE PAIRS without explicit approval.
 * These are mainnet issuers but can be used on testnet (with graceful fallback).
 */
export const TRADING_PAIRS: readonly TradingPair[] = Object.freeze([
    {
        key: 'XRP/RLUSD',
        base: { currency: 'XRP' },
        quote: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        description: 'XRP/RLUSD',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/USDT',
        base: { currency: 'XRP' },
        quote: { currency: 'USDT', issuer: 'rcvxE9PS9YBwxtGg1qNeewV6ZB3wGubZq' },
        description: 'XRP/USDT',
        liquidity: 'medium',
        network: 'mainnet',
    },
] as const);

// =============================================================================
// Helper Functions — Delegate to Instrument Registry
// =============================================================================

/**
 * Get a trading pair by key.
 * @throws Error if pair not found
 */
export function getPair(key: string): TradingPair {
    const inst = getInstrument(key);
    // Cast Instrument → TradingPair (they are structurally compatible)
    return inst as unknown as TradingPair;
}

/**
 * Find a trading pair by key (returns undefined if not found).
 */
export function findPair(key: string): TradingPair | undefined {
    const inst = findInstrument(key);
    return inst as unknown as TradingPair | undefined;
}

/**
 * List all pairs, optionally filtered by network.
 */
export function listPairs(options?: { network?: Network }): readonly TradingPair[] {
    if (!options?.network) {
        return getInstruments() as unknown as readonly TradingPair[];
    }
    // On mainnet, return only mainnet pairs
    // On testnet, return all pairs (they can be used but may have no liquidity)
    if (options.network === 'mainnet') {
        return registryListInstruments({ network: 'mainnet', activeOnly: true }) as unknown as readonly TradingPair[];
    }
    return getInstruments() as unknown as readonly TradingPair[]; // All pairs available on testnet (for dev/testing)
}

/**
 * Check if a pair key is valid.
 */
export function isValidPairKey(key: string): boolean {
    return registryIsValidPairKey(key);
}

/**
 * Validate a trading pair at runtime.
 * @throws Error with detailed message if invalid
 */
export function assertValidPair(pair: unknown): asserts pair is TradingPair {
    const result = tradingPairSchema.safeParse(pair);
    if (!result.success) {
        const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        throw new Error(`Invalid trading pair: ${messages}`);
    }
}

/**
 * Validate all pairs at startup (fail fast).
 * Call this once during application initialization.
 */
export function validateAllPairs(): void {
    // Validate the static TRADING_PAIRS array via Zod
    const result = tradingPairsArraySchema.safeParse(TRADING_PAIRS);
    if (!result.success) {
        const messages = result.error.errors.map((e) => `[${e.path.join('.')}] ${e.message}`).join('\n');
        throw new Error(`Trading pairs configuration invalid:\n${messages}`);
    }
    // Also validate registry instruments structurally
    registryValidateAllPairs();
}

/**
 * Convert a TradingPair to the legacy format used by the bot runtime.
 */
export function toLegacyPair(pair: TradingPair): LegacyTradingPair {
    return registryToLegacyPair(pair as unknown as Instrument);
}

/**
 * Convert from legacy format back to TradingPair.
 * Useful for deserializing stored pair configs.
 */
export function fromLegacyPair(legacy: LegacyTradingPair): TradingPair {
    const inst = registryFromLegacyPair(legacy);
    return inst as unknown as TradingPair;
}

// =============================================================================
// Runtime Initialization
// =============================================================================

// Validate pairs on module load (fail fast in development)
try {
    validateAllPairs();
} catch (error) {
    console.error('FATAL: Trading pairs configuration invalid', error);
    if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
    }
}
