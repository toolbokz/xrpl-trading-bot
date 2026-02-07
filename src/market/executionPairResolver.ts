/**
 * Execution Pair Resolver — Single-Entry-Point Pair→XRPL Translation
 *
 * Centralizes the duplicated issuer resolution cascade and currency
 * formatting that was previously scattered across 4+ modules:
 *   - offerBuilder.ts: normalizePair() with pair.quoteIssuer ?? pair.issuer
 *   - scalper.ts: pair.quoteIssuer || pair.baseIssuer || pair.issuer
 *   - ammArbitrage.ts: same cascade for AMM API calls
 *   - pathArbitrage.ts: same cascade + toXrplCurrency() for path_find
 *
 * This module replaces ALL of those with a deterministic, auditable
 * resolution that delegates to the IssuerRouter (Phase 2) and produces
 * pre-formatted XRPL-ready amounts and offer parameters.
 *
 * Architecture:
 *   resolve(pair | pairKey) → ResolvedPair
 *     ├── calls IssuerRouter.resolveIssuers()
 *     ├── validates currencies via toXrplCurrency()
 *     ├── caches result for tick-lifetime reuse
 *     └── produces ResolvedLeg with pre-formatted amount helpers
 *
 *   ResolvedPair.formatAmount(side, value) → XRPL Amount
 *   ResolvedPair.buildOfferAmounts(side, price, amount) → TakerGets/TakerPays
 *
 * @module market/executionPairResolver
 */

import { xrpToDrops, isValidClassicAddress, type OfferCreate } from 'xrpl';
import type { TradingPair } from '../config';
import { toXrplCurrency, type XrplCurrency } from '../xrpl/currency';
import {
    resolveIssuers,
    type RoutingDecision,
    type RoutingRequest,
    type IssuerRouterConfig,
    type RoutingTraceEntry,
    loadIssuerRouterConfig,
} from './issuerRouter';
import {
    findInstrument,
    type Network,
    type IssuerTier,
} from './instrumentRegistry';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A fully resolved leg ready for XRPL transaction construction. */
export interface ResolvedLeg {
    /** Original currency code (human-readable, e.g., "XRP", "RLUSD"). */
    currency: string;
    /** XRPL-encoded currency code (hex-padded for >3 chars). */
    xrplCurrency: string;
    /** Issuer address (undefined for XRP). */
    issuer: string | undefined;
    /** Whether this leg is XRP (native). */
    isXRP: boolean;
    /** The validated XrplCurrency object for direct use. */
    xrplCurrencyObj: XrplCurrency;
    /** How the issuer was resolved (null for XRP). */
    source: 'pair-override' | 'registry' | 'legacy-fallback' | null;
    /** Issuer tier from registry (null for XRP or unregistered). */
    tier: IssuerTier | null;
}

/** Pre-computed XRPL offer construction data. */
export interface ResolvedPair {
    /** Pair key (e.g., "XRP/RLUSD"). */
    pairKey: string;
    /** Resolved base leg. */
    base: ResolvedLeg;
    /** Resolved quote leg. */
    quote: ResolvedLeg;
    /** Overall resolution confidence (0–1). */
    confidence: number;
    /** Whether the resolution is valid for execution. */
    executable: boolean;
    /** Reason if not executable. */
    blockReason: string | undefined;
    /** Routing audit trail. */
    routingTrace: RoutingTraceEntry[];
    /** Timestamp of resolution (ms epoch). */
    resolvedAtMs: number;
    /** Network context used for resolution. */
    network: Network | undefined;
}

/** Configuration for the ExecutionPairResolver. */
export interface ExecutionPairResolverConfig {
    /** Network to filter issuers by (default: undefined = all). */
    network: Network | undefined;
    /** Issuer blacklist for filtering (default: empty). */
    blacklist: ReadonlySet<string>;
    /** Wallet address for potential trustline checks (default: undefined). */
    walletAddress: string | undefined;
    /** Cache TTL in ms (default: 30000). 0 = no caching. */
    cacheTtlMs: number;
    /** Whether to fail hard on unresolvable issuers (default: true). */
    failOnUnresolvable: boolean;
    /** IssuerRouter config overrides. */
    routerConfig: Partial<IssuerRouterConfig>;
}

/** Input to resolve — accepts either a TradingPair or a pair key string. */
export type ResolveInput = TradingPair | string;

/** XRPL Amount type — either drops string (XRP) or issued currency object. */
export type XrplAmount = string | { currency: string; issuer: string; value: string };

/** Pre-built offer amounts for direct use in OfferCreate. */
export interface OfferAmounts {
    TakerGets: OfferCreate['TakerGets'];
    TakerPays: OfferCreate['TakerPays'];
}

/** Trade side for offer construction. */
export type TradeSide = 'BUY' | 'SELL';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ExecutionPairResolverConfig = {
    network: undefined,
    blacklist: new Set<string>(),
    walletAddress: undefined,
    cacheTtlMs: 30_000,
    failOnUnresolvable: true,
    routerConfig: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure Helpers
// ─────────────────────────────────────────────────────────────────────────────

const isXRP = (code: string): boolean => code.toUpperCase() === 'XRP';

/**
 * Convert a numeric value to a precision string suitable for XRPL.
 * Throws on non-positive / non-finite values.
 */
export function toPrecisionString(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Amount must be positive finite, got ${value}`);
    }
    // Use 15 significant figures (XRPL precision limit)
    const str = value.toPrecision(15);
    // Strip trailing zeros after decimal point
    return str.replace(/\.0+$|(?<=\.\d*?)0+$/g, '').replace(/\.$/, '');
}

/**
 * Format a value as an XRPL amount for a given resolved leg.
 *
 * - XRP: returns drops as string (e.g., "1000000" for 1 XRP)
 * - Issued: returns { currency, issuer, value } object
 */
export function formatAmount(leg: ResolvedLeg, value: number): XrplAmount {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Amount must be positive finite, got ${value}`);
    }

    if (leg.isXRP) {
        return xrpToDrops(value);
    }

    if (!leg.issuer) {
        throw new Error(`Cannot format issued amount without issuer for ${leg.currency}`);
    }

    return {
        currency: leg.xrplCurrency,
        issuer: leg.issuer,
        value: toPrecisionString(value),
    };
}

/**
 * Build TakerGets/TakerPays for an OfferCreate transaction.
 *
 * XRPL OfferCreate semantics:
 *   - TakerGets = what you are SELLING (what the taker receives from you)
 *   - TakerPays = what you are BUYING (what the taker pays to you)
 *
 * BUY base: you sell quote, receive base
 *   → TakerGets = quote amount, TakerPays = base amount
 *
 * SELL base: you sell base, receive quote
 *   → TakerGets = base amount, TakerPays = quote amount
 */
export function buildOfferAmounts(
    resolved: ResolvedPair,
    side: TradeSide,
    baseAmount: number,
    price: number,
): OfferAmounts {
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
        throw new Error(`Base amount must be positive finite, got ${baseAmount}`);
    }
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Price must be positive finite, got ${price}`);
    }
    if (!resolved.executable) {
        throw new Error(`Cannot build offer for non-executable pair: ${resolved.blockReason}`);
    }

    const quoteAmount = baseAmount * price;

    if (side === 'BUY') {
        // BUY base: TakerGets = quote (selling), TakerPays = base (buying)
        return {
            TakerGets: formatAmount(resolved.quote, quoteAmount),
            TakerPays: formatAmount(resolved.base, baseAmount),
        };
    }

    // SELL base: TakerGets = base (selling), TakerPays = quote (buying)
    return {
        TakerGets: formatAmount(resolved.base, baseAmount),
        TakerPays: formatAmount(resolved.quote, quoteAmount),
    };
}

/**
 * Extract the primary issuer address for risk engine approval.
 *
 * Replaces the scattered pattern:
 *   pair.quoteIssuer || pair.baseIssuer || pair.issuer
 *
 * Returns the quote issuer if available (most common for XRP/TOKEN pairs),
 * falling back to base issuer for TOKEN/TOKEN pairs.
 */
export function extractPrimaryIssuer(resolved: ResolvedPair): string | undefined {
    return resolved.quote.issuer ?? resolved.base.issuer;
}

/**
 * Build the set of all issuer addresses for a resolved pair.
 * Used by risk engine's allowlist check.
 */
export function extractIssuerSet(resolved: ResolvedPair): Set<string> {
    const set = new Set<string>();
    if (resolved.base.issuer) set.add(resolved.base.issuer);
    if (resolved.quote.issuer) set.add(resolved.quote.issuer);
    return set;
}

/**
 * Build the XRPL currency object for a resolved leg.
 * Used by strategies that need to pass currency to XRPL APIs
 * (e.g., ripple_path_find, amm_info).
 */
export function legToXrplCurrency(leg: ResolvedLeg): XrplCurrency {
    return leg.xrplCurrencyObj;
}

/**
 * Build a resolved leg from an XRPL currency and resolution metadata.
 */
function buildResolvedLeg(
    originalCurrency: string,
    routingSource: 'pair-override' | 'registry' | 'legacy-fallback' | null,
    issuerAddress: string | undefined,
    issuerTier: IssuerTier | null,
): ResolvedLeg {
    const xrp = isXRP(originalCurrency);

    // Validate and normalize via the existing currency module
    let xrplCurrencyObj: XrplCurrency;
    if (xrp) {
        xrplCurrencyObj = { currency: 'XRP' };
    } else {
        if (!issuerAddress) {
            throw new Error(`Issued currency ${originalCurrency} requires an issuer address`);
        }
        xrplCurrencyObj = toXrplCurrency({ currency: originalCurrency, issuer: issuerAddress });
    }

    return {
        currency: originalCurrency,
        xrplCurrency: xrplCurrencyObj.currency,
        issuer: xrp ? undefined : issuerAddress,
        isXRP: xrp,
        xrplCurrencyObj,
        source: xrp ? null : routingSource,
        tier: xrp ? null : issuerTier,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a pair key string into base/quote currencies.
 * e.g., "XRP/RLUSD" → { base: "XRP", quote: "RLUSD" }
 */
export function parsePairKey(pairKey: string): { base: string; quote: string } {
    const parts = pairKey.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid pair key format: "${pairKey}" (expected "BASE/QUOTE")`);
    }
    return { base: parts[0].toUpperCase(), quote: parts[1].toUpperCase() };
}

/**
 * Resolve a TradingPair or pair key into a fully validated ResolvedPair.
 *
 * This is the SINGLE ENTRY POINT that replaces all scattered issuer
 * resolution cascades throughout the codebase.
 *
 * Resolution flow:
 *   1. Parse input (TradingPair or string key)
 *   2. Attempt registry lookup for instrument metadata
 *   3. Delegate to IssuerRouter.resolveIssuers() for tier-aware resolution
 *   4. Validate currencies via toXrplCurrency() (hex encoding, etc.)
 *   5. Build ResolvedPair with pre-validated legs
 *
 * @throws Error if failOnUnresolvable=true and issuer cannot be resolved
 */
export function resolvePair(
    input: ResolveInput,
    config?: Partial<ExecutionPairResolverConfig>,
): ResolvedPair {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const nowMs = Date.now();

    // ── Step 1: Parse input ──────────────────────────────────────────────
    let baseCurrency: string;
    let quoteCurrency: string;
    let baseIssuerOverride: string | undefined;
    let quoteIssuerOverride: string | undefined;
    let legacyIssuerFallback: string | undefined;
    let pairKey: string;

    if (typeof input === 'string') {
        // Pair key string — lookup overrides from registry
        const parsed = parsePairKey(input);
        baseCurrency = parsed.base;
        quoteCurrency = parsed.quote;
        pairKey = input;

        // Try to get issuer overrides from the instrument registry
        const instrument = findInstrument(input);
        if (instrument) {
            baseIssuerOverride = instrument.base.issuer;
            quoteIssuerOverride = instrument.quote.issuer;
        }
    } else {
        // TradingPair object — extract overrides directly
        baseCurrency = input.baseCurrency.toUpperCase();
        quoteCurrency = input.quoteCurrency.toUpperCase();
        pairKey = `${baseCurrency}/${quoteCurrency}`;

        baseIssuerOverride = input.baseIssuer;
        quoteIssuerOverride = input.quoteIssuer;
        legacyIssuerFallback = input.issuer;
    }

    // ── Step 2: Validate same-currency guard ─────────────────────────────
    if (baseCurrency === quoteCurrency) {
        throw new Error(`Base and quote currency must differ: ${baseCurrency}/${quoteCurrency}`);
    }

    // ── Step 3: Delegate to IssuerRouter ─────────────────────────────────
    const routerConfig = { ...loadIssuerRouterConfig(), ...cfg.routerConfig };

    const routingRequest: RoutingRequest = {
        baseCurrency,
        quoteCurrency,
        baseIssuerOverride,
        quoteIssuerOverride,
        legacyIssuerFallback,
        network: cfg.network,
        blacklist: cfg.blacklist,
    };

    const routing: RoutingDecision = resolveIssuers(routingRequest, routerConfig);

    // ── Step 4: Check executability ──────────────────────────────────────
    if (!routing.executable) {
        if (cfg.failOnUnresolvable) {
            throw new Error(
                `Pair ${pairKey} is not executable: ${routing.blockReason}. ` +
                'Ensure the issuer is registered or provide explicit overrides.'
            );
        }
        return {
            pairKey,
            base: buildSafeLeg(baseCurrency),
            quote: buildSafeLeg(quoteCurrency),
            confidence: 0,
            executable: false,
            blockReason: routing.blockReason,
            routingTrace: routing.trace,
            resolvedAtMs: nowMs,
            network: cfg.network,
        };
    }

    // ── Step 5: Build resolved legs ──────────────────────────────────────
    const base = buildResolvedLeg(
        baseCurrency,
        routing.base?.source ?? null,
        routing.base?.address,
        routing.base?.record?.tier ?? null,
    );

    const quote = buildResolvedLeg(
        quoteCurrency,
        routing.quote?.source ?? null,
        routing.quote?.address,
        routing.quote?.record?.tier ?? null,
    );

    return {
        pairKey,
        base,
        quote,
        confidence: routing.confidence,
        executable: true,
        blockReason: undefined,
        routingTrace: routing.trace,
        resolvedAtMs: nowMs,
        network: cfg.network,
    };
}

/**
 * Build a safe (non-executable) leg for error paths.
 */
function buildSafeLeg(currency: string): ResolvedLeg {
    const xrp = isXRP(currency);
    return {
        currency,
        xrplCurrency: xrp ? 'XRP' : currency,
        issuer: undefined,
        isXRP: xrp,
        xrplCurrencyObj: xrp ? { currency: 'XRP' } : { currency, issuer: '' } as any,
        source: null,
        tier: null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached Resolver (stateful, for runtime use)
// ─────────────────────────────────────────────────────────────────────────────

/** Cache entry for a resolved pair. */
interface CacheEntry {
    resolved: ResolvedPair;
    expiresAtMs: number;
}

/**
 * Stateful resolver with per-pair caching.
 *
 * Use this in the TradingRuntime to avoid re-resolving on every tick.
 * Cache is invalidated on pair switch or explicit invalidation.
 */
export class ExecutionPairResolver {
    private readonly config: ExecutionPairResolverConfig;
    private readonly cache = new Map<string, CacheEntry>();

    constructor(config?: Partial<ExecutionPairResolverConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Resolve a pair (cached).
     * Returns the cached result if still valid, otherwise re-resolves.
     */
    resolve(input: ResolveInput): ResolvedPair {
        const key = typeof input === 'string'
            ? input
            : `${input.baseCurrency}/${input.quoteCurrency}`;

        const now = Date.now();

        // Check cache
        if (this.config.cacheTtlMs > 0) {
            const cached = this.cache.get(key);
            if (cached && cached.expiresAtMs > now) {
                return cached.resolved;
            }
        }

        // Resolve
        const resolved = resolvePair(input, this.config);

        // Cache the result
        if (this.config.cacheTtlMs > 0) {
            this.cache.set(key, {
                resolved,
                expiresAtMs: now + this.config.cacheTtlMs,
            });
        }

        return resolved;
    }

    /**
     * Resolve and build offer amounts in one call.
     * Convenience for the common pattern in strategies.
     */
    resolveAndBuildOffer(
        input: ResolveInput,
        side: TradeSide,
        baseAmount: number,
        price: number,
    ): { resolved: ResolvedPair; offer: OfferAmounts } {
        const resolved = this.resolve(input);
        const offer = buildOfferAmounts(resolved, side, baseAmount, price);
        return { resolved, offer };
    }

    /**
     * Get the primary issuer for a pair (cached resolution).
     * Replaces: pair.quoteIssuer || pair.baseIssuer || pair.issuer
     */
    getPrimaryIssuer(input: ResolveInput): string | undefined {
        const resolved = this.resolve(input);
        return extractPrimaryIssuer(resolved);
    }

    /**
     * Get all issuer addresses for a pair (cached resolution).
     */
    getIssuerSet(input: ResolveInput): Set<string> {
        const resolved = this.resolve(input);
        return extractIssuerSet(resolved);
    }

    /**
     * Invalidate the cache for a specific pair or all pairs.
     */
    invalidate(pairKey?: string): void {
        if (pairKey) {
            this.cache.delete(pairKey);
        } else {
            this.cache.clear();
        }
    }

    /**
     * Get the current cache size (for observability).
     */
    getCacheSize(): number {
        return this.cache.size;
    }

    /**
     * Reset all state.
     */
    reset(): void {
        this.cache.clear();
    }

    /**
     * Get the resolver config (for observability / testing).
     */
    getConfig(): ExecutionPairResolverConfig {
        return { ...this.config };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge Functions — Connect to Legacy Code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a TradingPair using the new resolver and return a NormalizedPair
 * in the format expected by offerBuilder.ts.
 *
 * This is the bridge function that allows offerBuilder's normalizePair()
 * to be replaced with resolver-backed resolution.
 */
export function resolveToNormalizedPair(
    pair: TradingPair,
    opts?: { invert?: boolean; config?: Partial<ExecutionPairResolverConfig> },
): { base: XrplCurrency; quote: XrplCurrency; symbol: string } {
    const inverted = !!opts?.invert;

    // Resolve the pair (non-inverted)
    const resolved = resolvePair(pair, opts?.config);

    // Select legs based on inversion
    const baseLeg = inverted ? resolved.quote : resolved.base;
    const quoteLeg = inverted ? resolved.base : resolved.quote;

    return {
        base: baseLeg.xrplCurrencyObj,
        quote: quoteLeg.xrplCurrencyObj,
        symbol: `${baseLeg.xrplCurrency}/${quoteLeg.xrplCurrency}`,
    };
}

/**
 * Resolve a pair from a TradingPair and extract the issuer for risk engine.
 *
 * Replaces the 3-way cascade in strategies:
 *   pair.quoteIssuer || pair.baseIssuer || pair.issuer
 */
export function resolveIssuerForRisk(
    pair: TradingPair,
    config?: Partial<ExecutionPairResolverConfig>,
): string | undefined {
    const resolved = resolvePair(pair, { ...config, failOnUnresolvable: false });
    return extractPrimaryIssuer(resolved);
}

/**
 * Resolve a pair and return XRPL currency objects for both legs.
 *
 * Replaces the scattered toXrplCurrency() calls in strategies
 * that do their own issuer cascade first.
 */
export function resolveLegsForApi(
    pair: TradingPair,
    config?: Partial<ExecutionPairResolverConfig>,
): { base: XrplCurrency; quote: XrplCurrency } {
    const resolved = resolvePair(pair, config);
    return {
        base: resolved.base.xrplCurrencyObj,
        quote: resolved.quote.xrplCurrencyObj,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load ExecutionPairResolver config from environment variables.
 */
export function loadExecutionPairResolverConfig(): Partial<ExecutionPairResolverConfig> {
    const config: Partial<ExecutionPairResolverConfig> = {};

    const network = process.env.XRPL_NETWORK;
    if (network === 'mainnet' || network === 'testnet' || network === 'devnet') {
        config.network = network;
    }

    const ttl = process.env.PAIR_RESOLVER_CACHE_TTL_MS;
    if (ttl !== undefined) {
        const parsed = parseInt(ttl, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
            config.cacheTtlMs = parsed;
        }
    }

    const failHard = process.env.PAIR_RESOLVER_FAIL_ON_UNRESOLVABLE;
    if (failHard === 'false') {
        config.failOnUnresolvable = false;
    }

    // Load nested router config
    config.routerConfig = loadIssuerRouterConfig();

    return config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that a ResolvedPair is safe for execution.
 * Performs deeper checks than the basic executable flag.
 *
 * Checks:
 *   1. Both legs have valid XRPL currencies
 *   2. Issued currencies have valid classic addresses
 *   3. No NaN/Infinity in the confidence score
 *   4. Pair key matches the resolved currencies
 */
export function validateResolvedPair(resolved: ResolvedPair): {
    valid: boolean;
    reasons: string[];
} {
    const reasons: string[] = [];

    // Check executable flag
    if (!resolved.executable) {
        reasons.push(`not-executable: ${resolved.blockReason}`);
    }

    // Check base leg
    if (!resolved.base.isXRP && !resolved.base.issuer) {
        reasons.push('base-missing-issuer');
    }
    if (!resolved.base.isXRP && resolved.base.issuer && !isValidClassicAddress(resolved.base.issuer)) {
        reasons.push('base-invalid-issuer-address');
    }
    if (!resolved.base.xrplCurrency || resolved.base.xrplCurrency.length === 0) {
        reasons.push('base-empty-currency');
    }

    // Check quote leg
    if (!resolved.quote.isXRP && !resolved.quote.issuer) {
        reasons.push('quote-missing-issuer');
    }
    if (!resolved.quote.isXRP && resolved.quote.issuer && !isValidClassicAddress(resolved.quote.issuer)) {
        reasons.push('quote-invalid-issuer-address');
    }
    if (!resolved.quote.xrplCurrency || resolved.quote.xrplCurrency.length === 0) {
        reasons.push('quote-empty-currency');
    }

    // Check confidence
    if (!Number.isFinite(resolved.confidence) || resolved.confidence < 0 || resolved.confidence > 1) {
        reasons.push('invalid-confidence');
    }

    // Check pair key consistency
    const expectedKey = `${resolved.base.currency}/${resolved.quote.currency}`;
    if (resolved.pairKey.toUpperCase() !== expectedKey.toUpperCase()) {
        reasons.push(`pair-key-mismatch: ${resolved.pairKey} !== ${expectedKey}`);
    }

    // Check same-currency guard
    if (resolved.base.currency.toUpperCase() === resolved.quote.currency.toUpperCase()) {
        reasons.push('same-currency');
    }

    return {
        valid: reasons.length === 0,
        reasons,
    };
}

/**
 * Assert a resolved pair is valid. Throws on failure.
 */
export function assertResolvedPairValid(resolved: ResolvedPair): void {
    const validation = validateResolvedPair(resolved);
    if (!validation.valid) {
        throw new Error(
            `ResolvedPair validation failed for ${resolved.pairKey}: ${validation.reasons.join(', ')}`
        );
    }
}
