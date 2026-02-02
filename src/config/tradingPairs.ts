/**
 * Trading Pairs - Single Source of Truth
 * 
 * This module defines ALL valid trading pairs for both backend and frontend.
 * Any changes to trading pairs should be made HERE ONLY.
 * 
 * @module config/tradingPairs
 */

import { z } from 'zod';
import { isValidClassicAddress } from 'xrpl';

// =============================================================================
// Types
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
    baseIssuer?: string;
    quoteCurrency: string;
    quoteIssuer?: string;
    issuer?: string; // Legacy fallback
    description?: string;
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
        key: 'XRP/USDC',
        base: { currency: 'XRP' },
        quote: { currency: 'USDC', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
        description: 'XRP/USDC',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/EUR',
        base: { currency: 'XRP' },
        quote: { currency: 'EUR', issuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' },
        description: 'XRP/EUR',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/BTC',
        base: { currency: 'XRP' },
        quote: { currency: 'BTC', issuer: 'rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL' },
        description: 'XRP/BTC',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/ETH',
        base: { currency: 'XRP' },
        quote: { currency: 'ETH', issuer: 'rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h' },
        description: 'XRP/ETH',
        liquidity: 'high',
        network: 'mainnet',
    },
] as const);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get a trading pair by key.
 * @throws Error if pair not found
 */
export function getPair(key: string): TradingPair {
    const pair = TRADING_PAIRS.find((p) => p.key === key);
    if (!pair) {
        throw new Error(`Unknown trading pair: ${key}`);
    }
    return pair;
}

/**
 * Find a trading pair by key (returns undefined if not found).
 */
export function findPair(key: string): TradingPair | undefined {
    return TRADING_PAIRS.find((p) => p.key === key);
}

/**
 * List all pairs, optionally filtered by network.
 */
export function listPairs(options?: { network?: Network }): readonly TradingPair[] {
    if (!options?.network) {
        return TRADING_PAIRS;
    }
    // On mainnet, return only mainnet pairs
    // On testnet, return all pairs (they can be used but may have no liquidity)
    if (options.network === 'mainnet') {
        return TRADING_PAIRS.filter((p) => p.network === 'mainnet');
    }
    return TRADING_PAIRS; // All pairs available on testnet (for dev/testing)
}

/**
 * Check if a pair key is valid.
 */
export function isValidPairKey(key: string): boolean {
    return TRADING_PAIRS.some((p) => p.key === key);
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
    const result = tradingPairsArraySchema.safeParse(TRADING_PAIRS);
    if (!result.success) {
        const messages = result.error.errors.map((e) => `[${e.path.join('.')}] ${e.message}`).join('\n');
        throw new Error(`Trading pairs configuration invalid:\n${messages}`);
    }
}

/**
 * Convert a TradingPair to the legacy format used by the bot runtime.
 */
export function toLegacyPair(pair: TradingPair): LegacyTradingPair {
    const result: LegacyTradingPair = {
        baseCurrency: pair.base.currency,
        quoteCurrency: pair.quote.currency,
        description: pair.description,
    };

    if (pair.base.issuer) {
        result.baseIssuer = pair.base.issuer;
    }
    if (pair.quote.issuer) {
        result.quoteIssuer = pair.quote.issuer;
    }
    // Legacy fallback: use quote issuer or base issuer
    const legacyIssuer = pair.quote.issuer || pair.base.issuer;
    if (legacyIssuer) {
        result.issuer = legacyIssuer;
    }

    return result;
}

/**
 * Convert from legacy format back to TradingPair.
 * Useful for deserializing stored pair configs.
 */
export function fromLegacyPair(legacy: LegacyTradingPair): TradingPair {
    const base: CurrencySide = { currency: legacy.baseCurrency };
    if (legacy.baseIssuer) {
        base.issuer = legacy.baseIssuer;
    } else if (legacy.baseCurrency.toUpperCase() !== 'XRP' && legacy.issuer) {
        base.issuer = legacy.issuer;
    }

    const quote: CurrencySide = { currency: legacy.quoteCurrency };
    if (legacy.quoteIssuer) {
        quote.issuer = legacy.quoteIssuer;
    } else if (legacy.quoteCurrency.toUpperCase() !== 'XRP' && legacy.issuer) {
        quote.issuer = legacy.issuer;
    }

    return {
        key: `${legacy.baseCurrency}/${legacy.quoteCurrency}`,
        base,
        quote,
        description: legacy.description || `${legacy.baseCurrency}/${legacy.quoteCurrency}`,
        liquidity: 'medium', // Default for reconstructed pairs
        network: 'mainnet',
    };
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
