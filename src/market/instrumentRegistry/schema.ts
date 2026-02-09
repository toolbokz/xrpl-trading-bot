/**
 * Instrument Registry — Schema & Types
 *
 * Canonical type definitions for the instrument registry.
 * All market layer components consume these types.
 *
 * @module market/instrumentRegistry/schema
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

/** XRPL network identifier. */
export type Network = 'mainnet' | 'testnet' | 'devnet';

/** Liquidity classification for UI display and routing decisions. */
export type LiquidityLevel = 'high' | 'medium' | 'low' | 'unknown';

/** Issuer trust tier — drives routing priority and risk gates. */
export type IssuerTier = 'tier1' | 'tier2' | 'tier3' | 'untrusted';

/** Status of an instrument or issuer in the registry. */
export type RegistryStatus = 'active' | 'disabled' | 'delisted';

/**
 * One side of a trading pair (base or quote).
 * XRP has no issuer; issued currencies require one.
 */
export interface CurrencySide {
    currency: string;
    issuer?: string | undefined;
}

/**
 * An issuer record — tracks a single XRPL issuer address.
 *
 * Multiple issuers can provide the same currency code.
 * The IssuerRoutingEngine selects the best issuer at execution time.
 */
export interface IssuerRecord {
    /** XRPL classic address (r...). */
    address: string;
    /** Human-readable label (e.g., "Ripple Labs"). */
    label: string;
    /** Currency code this issuer provides. */
    currency: string;
    /** Trust tier for routing priority. */
    tier: IssuerTier;
    /** Primary network. */
    network: Network;
    /** Whether this issuer is currently active. */
    status: RegistryStatus;
    /** Optional notes / reason for status. */
    notes?: string | undefined;
    /** ISO timestamp of creation. */
    createdAt: string;
    /** ISO timestamp of last update. */
    updatedAt: string;
}

/**
 * An instrument (trading pair) in the registry.
 *
 * This is the canonical representation that replaces the static
 * TRADING_PAIRS array from config/tradingPairs.ts.
 */
export interface Instrument {
    /** Unique key like "XRP/RLUSD". */
    key: string;
    /** Base currency side. */
    base: CurrencySide;
    /** Quote currency side. */
    quote: CurrencySide;
    /** Human-readable description. */
    description: string;
    /** Liquidity level indicator. */
    liquidity: LiquidityLevel;
    /** Primary network for this instrument. */
    network: Network;
    /** Whether this instrument is currently tradeable. */
    status: RegistryStatus;
    /** Optional ordering priority (lower = higher priority in UI). */
    sortOrder: number;
    /** ISO timestamp of creation. */
    createdAt: string;
    /** ISO timestamp of last update. */
    updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward Compatibility — Legacy TradingPair type alias
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy trading pair format used by the bot runtime.
 * The registry transparently converts Instruments to this format.
 */
export interface LegacyTradingPair {
    baseCurrency: string;
    baseIssuer?: string | undefined;
    quoteCurrency: string;
    quoteIssuer?: string | undefined;
    issuer?: string | undefined;
    description?: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an Instrument to the legacy TradingPair format.
 * Used by runtime code that still expects the old shape.
 */
export function toLegacyPair(instrument: Instrument): LegacyTradingPair {
    const result: LegacyTradingPair = {
        baseCurrency: instrument.base.currency,
        quoteCurrency: instrument.quote.currency,
        description: instrument.description,
    };
    if (instrument.base.issuer) result.baseIssuer = instrument.base.issuer;
    if (instrument.quote.issuer) result.quoteIssuer = instrument.quote.issuer;
    // Legacy fallback: use quote issuer or base issuer
    const legacyIssuer = instrument.quote.issuer || instrument.base.issuer;
    if (legacyIssuer) result.issuer = legacyIssuer;
    return result;
}

/**
 * Convert from legacy TradingPair format to an Instrument.
 * Useful for deserializing stored configs or env var data.
 */
export function fromLegacyPair(legacy: LegacyTradingPair): Instrument {
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

    const now = new Date().toISOString();
    return {
        key: `${legacy.baseCurrency}/${legacy.quoteCurrency}`,
        base,
        quote,
        description: legacy.description || `${legacy.baseCurrency}/${legacy.quoteCurrency}`,
        liquidity: 'medium',
        network: 'mainnet',
        status: 'active',
        sortOrder: 999,
        createdAt: now,
        updatedAt: now,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Query / Filter Types
// ─────────────────────────────────────────────────────────────────────────────

/** Filter criteria for listing instruments. */
export interface InstrumentFilter {
    /** Filter by network. */
    network?: Network | undefined;
    /** Filter by status (default: 'active'). */
    status?: RegistryStatus | undefined;
    /** Filter by base currency code. */
    baseCurrency?: string | undefined;
    /** Filter by quote currency code. */
    quoteCurrency?: string | undefined;
    /** Filter by liquidity level. */
    liquidity?: LiquidityLevel | undefined;
}

/** Filter criteria for listing issuers. */
export interface IssuerFilter {
    /** Filter by currency code. */
    currency?: string | undefined;
    /** Filter by network. */
    network?: Network | undefined;
    /** Filter by tier. */
    tier?: IssuerTier | undefined;
    /** Filter by status (default: 'active'). */
    status?: RegistryStatus | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed Data — the canonical instrument list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in instruments seeded on first startup.
 * Matches the existing TRADING_PAIRS from config/tradingPairs.ts.
 */
export const SEED_INSTRUMENTS: readonly Instrument[] = Object.freeze([
    {
        key: 'XRP/RLUSD',
        base: { currency: 'XRP' },
        quote: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        description: 'XRP/RLUSD',
        liquidity: 'high' as LiquidityLevel,
        network: 'mainnet' as Network,
        status: 'active' as RegistryStatus,
        sortOrder: 1,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
    },
    {
        key: 'XRP/USDT',
        base: { currency: 'XRP' },
        quote: { currency: 'USDT', issuer: 'rcvxE9PS9YBwxtGg1qNeewV6ZB3wGubZq' },
        description: 'XRP/USDT',
        liquidity: 'medium' as LiquidityLevel,
        network: 'mainnet' as Network,
        status: 'active' as RegistryStatus,
        sortOrder: 6,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
    },
]);

/**
 * Built-in issuers seeded on first startup.
 */
export const SEED_ISSUERS: readonly IssuerRecord[] = Object.freeze([
    {
        address: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        label: 'Ripple (RLUSD)',
        currency: 'RLUSD',
        tier: 'tier1' as IssuerTier,
        network: 'mainnet' as Network,
        status: 'active' as RegistryStatus,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
    },
    {
        address: 'rcvxE9PS9YBwxtGg1qNeewV6ZB3wGubZq',
        label: 'Bitstamp (USDT)',
        currency: 'USDT',
        tier: 'tier2' as IssuerTier,
        network: 'mainnet' as Network,
        status: 'active' as RegistryStatus,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
    },
]);
