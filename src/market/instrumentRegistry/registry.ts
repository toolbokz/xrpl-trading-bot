/**
 * Instrument Registry — Public API
 *
 * The single source of truth for trading pair definitions.
 * Replaces the static TRADING_PAIRS array from config/tradingPairs.ts
 * with a SQLite-backed, runtime-mutable registry.
 *
 * Provides full backward-compatible API surface so existing consumers
 * can be migrated incrementally:
 *   - TRADING_PAIRS       → getInstruments()   (lazy, cached)
 *   - isValidPairKey()    → isValidPairKey()    (same name, DB-backed)
 *   - findPair()          → findInstrument()    (same shape)
 *   - getPair()           → getInstrument()     (throws if missing)
 *   - listPairs()         → listInstruments()   (with filters)
 *   - toLegacyPair()      → re-exported from schema
 *   - fromLegacyPair()    → re-exported from schema
 *
 * @module market/instrumentRegistry/registry
 */

import { isValidClassicAddress } from 'xrpl';
import {
    Instrument,
    IssuerRecord,
    CurrencySide,
    LiquidityLevel,
    Network,
    RegistryStatus,
    IssuerTier,
    InstrumentFilter,
    IssuerFilter,
    LegacyTradingPair,
    toLegacyPair,
    fromLegacyPair,
    SEED_INSTRUMENTS,
    SEED_ISSUERS,
} from './schema';
import {
    getRegistryDb,
    closeRegistryDb,
    resetRegistryDb,
    dbUpsertInstrument,
    dbListInstruments,
    dbUpdateInstrumentStatus,
    dbUpdateInstrumentLiquidity,
    dbDeleteInstrument,
    dbGetIssuer,
    dbUpsertIssuer,
    dbListIssuers,
    dbUpdateIssuerStatus,
    dbUpdateIssuerTier,
    dbDeleteIssuer,
} from './db';
import { logger } from '../../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for consumers
// ─────────────────────────────────────────────────────────────────────────────

export type {
    Instrument,
    IssuerRecord,
    CurrencySide,
    LiquidityLevel,
    Network,
    RegistryStatus,
    IssuerTier,
    InstrumentFilter,
    IssuerFilter,
    LegacyTradingPair,
};

export { toLegacyPair, fromLegacyPair, SEED_INSTRUMENTS, SEED_ISSUERS };

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight in-memory cache for hot-path lookups.
 * Invalidated on any write operation.
 */
let cachedInstruments: Instrument[] | null = null;
let cachedInstrumentMap: Map<string, Instrument> | null = null;

function invalidateCache(): void {
    cachedInstruments = null;
    cachedInstrumentMap = null;
}

function ensureCache(): void {
    if (cachedInstruments && cachedInstrumentMap) return;

    // Initialize DB on first access (lazy)
    getRegistryDb();

    const instruments = dbListInstruments();
    cachedInstruments = instruments;
    cachedInstrumentMap = new Map(instruments.map((i) => [i.key, i]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Instrument API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all instruments (cached, active + disabled).
 * This replaces the static TRADING_PAIRS array.
 */
export function getInstruments(): readonly Instrument[] {
    ensureCache();
    return cachedInstruments!;
}

/**
 * Get all active instruments (the ones eligible for trading).
 */
export function getActiveInstruments(filter?: { network?: Network | undefined }): readonly Instrument[] {
    ensureCache();
    let result = cachedInstruments!.filter((i) => i.status === 'active');
    if (filter?.network) {
        if (filter.network === 'mainnet') {
            result = result.filter((i) => i.network === 'mainnet');
        }
        // Testnet: return all active instruments (for dev/testing)
    }
    return result;
}

/**
 * Find an instrument by key. Returns undefined if not found.
 * This is the DB-backed replacement for findPair().
 */
export function findInstrument(key: string): Instrument | undefined {
    ensureCache();
    return cachedInstrumentMap!.get(key);
}

/**
 * Get an instrument by key. Throws if not found.
 * This is the DB-backed replacement for getPair().
 */
export function getInstrument(key: string): Instrument {
    const inst = findInstrument(key);
    if (!inst) {
        throw new Error(`Unknown trading pair: ${key}`);
    }
    return inst;
}

/**
 * Check if a pair key is valid (exists in the registry).
 * This is the DB-backed replacement for isValidPairKey().
 */
export function isValidPairKey(key: string): boolean {
    ensureCache();
    return cachedInstrumentMap!.has(key);
}

/**
 * List instruments with optional filtering.
 * This is the DB-backed replacement for listPairs().
 */
export function listInstruments(options?: {
    network?: Network | undefined;
    activeOnly?: boolean | undefined;
}): readonly Instrument[] {
    if (options?.activeOnly) {
        return getActiveInstruments({ network: options.network });
    }
    if (options?.network) {
        ensureCache();
        if (options.network === 'mainnet') {
            return cachedInstruments!.filter((i) => i.network === 'mainnet');
        }
        return cachedInstruments!;
    }
    return getInstruments();
}

/**
 * Register a new instrument. Validates structure before persisting.
 * Invalidates cache.
 */
export function registerInstrument(inst: Instrument): void {
    validateInstrumentStructure(inst);
    dbUpsertInstrument(inst);
    invalidateCache();
    logger.info({ key: inst.key, network: inst.network }, 'Instrument registered');
}

/**
 * Update an instrument's status.
 */
export function setInstrumentStatus(key: string, status: RegistryStatus): boolean {
    const ok = dbUpdateInstrumentStatus(key, status);
    if (ok) invalidateCache();
    return ok;
}

/**
 * Update an instrument's liquidity level.
 */
export function setInstrumentLiquidity(key: string, liquidity: LiquidityLevel): boolean {
    const ok = dbUpdateInstrumentLiquidity(key, liquidity);
    if (ok) invalidateCache();
    return ok;
}

/**
 * Remove an instrument from the registry.
 */
export function removeInstrument(key: string): boolean {
    const ok = dbDeleteInstrument(key);
    if (ok) invalidateCache();
    return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issuer API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get an issuer by address and currency.
 */
export function getIssuer(address: string, currency: string): IssuerRecord | undefined {
    return dbGetIssuer(address, currency) ?? undefined;
}

/**
 * List issuers with optional filtering.
 */
export function listIssuers(filter?: IssuerFilter): readonly IssuerRecord[] {
    const opts: { currency?: string; network?: Network; activeOnly?: boolean } = {};
    if (filter?.currency) opts.currency = filter.currency;
    if (filter?.network) opts.network = filter.network;
    if (filter?.status === 'active') opts.activeOnly = true;
    return dbListIssuers(opts);
}

/**
 * Get active issuers for a specific currency, ordered by tier.
 */
export function getActiveIssuersForCurrency(currency: string): readonly IssuerRecord[] {
    return dbListIssuers({ currency, activeOnly: true });
}

/**
 * Register or update an issuer.
 */
export function registerIssuer(issuer: IssuerRecord): void {
    if (!issuer.address || !isValidClassicAddress(issuer.address)) {
        throw new Error(`Invalid issuer address: ${issuer.address}`);
    }
    if (!issuer.currency || issuer.currency.length === 0) {
        throw new Error('Issuer currency is required');
    }
    dbUpsertIssuer(issuer);
    logger.info({ address: issuer.address, currency: issuer.currency, tier: issuer.tier }, 'Issuer registered');
}

/**
 * Update an issuer's status.
 */
export function setIssuerStatus(address: string, currency: string, status: RegistryStatus): boolean {
    return dbUpdateIssuerStatus(address, currency, status);
}

/**
 * Update an issuer's tier.
 */
export function setIssuerTier(address: string, currency: string, tier: IssuerTier): boolean {
    return dbUpdateIssuerTier(address, currency, tier);
}

/**
 * Remove an issuer.
 */
export function removeIssuer(address: string, currency: string): boolean {
    return dbDeleteIssuer(address, currency);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an instrument's structure.
 * Throws if invalid.
 */
export function validateInstrumentStructure(inst: Instrument): void {
    if (!inst.key || inst.key.length === 0) {
        throw new Error('Instrument key is required');
    }
    if (!inst.base?.currency) {
        throw new Error('Base currency is required');
    }
    if (!inst.quote?.currency) {
        throw new Error('Quote currency is required');
    }
    if (inst.base.currency.toUpperCase() === inst.quote.currency.toUpperCase()) {
        throw new Error('Base and quote currency must differ');
    }
    // XRP must not have issuer
    if (inst.base.currency.toUpperCase() === 'XRP' && inst.base.issuer) {
        throw new Error('XRP must not have an issuer');
    }
    if (inst.quote.currency.toUpperCase() === 'XRP' && inst.quote.issuer) {
        throw new Error('XRP must not have an issuer');
    }
    // Non-XRP must have valid issuer
    if (inst.base.currency.toUpperCase() !== 'XRP') {
        if (!inst.base.issuer || !isValidClassicAddress(inst.base.issuer)) {
            throw new Error(`Base currency ${inst.base.currency} requires a valid issuer address`);
        }
    }
    if (inst.quote.currency.toUpperCase() !== 'XRP') {
        if (!inst.quote.issuer || !isValidClassicAddress(inst.quote.issuer)) {
            throw new Error(`Quote currency ${inst.quote.currency} requires a valid issuer address`);
        }
    }
    // Key must match currencies
    const expectedKey = `${inst.base.currency}/${inst.quote.currency}`;
    if (inst.key !== expectedKey) {
        throw new Error(`Key "${inst.key}" does not match currencies "${expectedKey}"`);
    }
}

/**
 * Validate that an instrument key is in the registry and active.
 * Throws with detailed message if not.
 * This replaces assertAllowedPair() from tradingRuntime.ts.
 */
export function assertAllowedInstrument(key: string): void {
    const inst = findInstrument(key);
    if (!inst) {
        const activeKeys = getActiveInstruments().map((i) => i.key).join(', ');
        throw new Error(
            `Instrument "${key}" is not in the registry. Available: ${activeKeys}`
        );
    }
    if (inst.status !== 'active') {
        throw new Error(
            `Instrument "${key}" is ${inst.status} and cannot be traded`
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward Compatibility — drop-in replacements for config/tradingPairs.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for the static TRADING_PAIRS array.
 * Returns all instruments as a readonly array (same shape as before).
 *
 * @deprecated Prefer getInstruments() or getActiveInstruments().
 */
export function getTradingPairs(): readonly Instrument[] {
    return getInstruments();
}

/**
 * Backward-compatible alias for findInstrument.
 * Same signature as the old findPair().
 */
export const findPair = findInstrument;

/**
 * Backward-compatible alias for getInstrument.
 * Same signature as the old getPair().
 */
export const getPair = getInstrument;

/**
 * Backward-compatible alias for listInstruments.
 * Same signature as the old listPairs().
 */
export function listPairs(options?: { network?: Network }): readonly Instrument[] {
    if (!options?.network) return getInstruments();
    if (options.network === 'mainnet') {
        return getActiveInstruments({ network: 'mainnet' });
    }
    return getInstruments(); // testnet: all pairs
}

/**
 * Backward-compatible assertValidPair.
 * Validates structure (not registry membership).
 */
export function assertValidPair(pair: unknown): asserts pair is Instrument {
    if (!pair || typeof pair !== 'object') {
        throw new Error('Invalid instrument: not an object');
    }
    const p = pair as Record<string, unknown>;
    if (typeof p.key !== 'string') throw new Error('Invalid instrument: missing key');
    if (!p.base || typeof p.base !== 'object') throw new Error('Invalid instrument: missing base');
    if (!p.quote || typeof p.quote !== 'object') throw new Error('Invalid instrument: missing quote');
    validateInstrumentStructure(pair as unknown as Instrument);
}

/**
 * Backward-compatible validateAllPairs.
 * Validates all instruments in the registry.
 */
export function validateAllPairs(): void {
    const instruments = getInstruments();
    for (const inst of instruments) {
        try {
            validateInstrumentStructure(inst);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'unknown';
            throw new Error(`Instrument ${inst.key} validation failed: ${msg}`);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the registry (creates DB, seeds if empty).
 * Safe to call multiple times (idempotent).
 */
export function initRegistry(): void {
    getRegistryDb();
    ensureCache();
    logger.info({ instrumentCount: cachedInstruments!.length }, 'Instrument registry ready');
}

/**
 * Close the registry database.
 */
export function closeRegistry(): void {
    invalidateCache();
    closeRegistryDb();
}

/**
 * Reset the registry (for testing).
 */
export function resetRegistry(): void {
    invalidateCache();
    resetRegistryDb();
}
