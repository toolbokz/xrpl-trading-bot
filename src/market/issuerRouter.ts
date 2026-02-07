/**
 * Issuer Routing Engine — Dynamic Issuer Resolution
 *
 * Replaces the static cascade pattern (pair.quoteIssuer ?? pair.baseIssuer ?? pair.issuer)
 * with a deterministic, tier-aware routing decision that produces an auditable trace.
 *
 * Routing priority:
 *   1. Explicit pair override (from TradingPair.baseIssuer / quoteIssuer)
 *   2. Registry lookup by (currency, network) → ranked by tier
 *   3. Trustline availability check (if enabled)
 *   4. Blacklist exclusion
 *
 * Every resolution produces a RoutingDecision containing:
 *   - The selected IssuerRecord
 *   - Confidence score (0–1)
 *   - Routing trace (why this issuer was selected)
 *   - Fallback chain (alternative issuers, ordered)
 *
 * @module market/issuerRouter
 */

import { isValidClassicAddress } from 'xrpl';
import {
    IssuerRecord,
    IssuerTier,
    Network,
} from './instrumentRegistry/schema';
import {
    getActiveIssuersForCurrency,
    getIssuer,
} from './instrumentRegistry/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Reason an issuer was selected or rejected. */
export interface RoutingTraceEntry {
    /** Candidate issuer address. */
    address: string;
    /** Currency code. */
    currency: string;
    /** Action taken. */
    action: 'SELECTED' | 'REJECTED' | 'FALLBACK';
    /** Why this action was taken. */
    reason: string;
    /** Issuer tier (if known). */
    tier?: IssuerTier | undefined;
    /** Step number in the routing evaluation. */
    step: number;
}

/** A fully resolved issuer for one side of a pair. */
export interface ResolvedIssuer {
    /** The selected issuer address. */
    address: string;
    /** The currency code. */
    currency: string;
    /** The issuer record (if from registry). */
    record: IssuerRecord | null;
    /** How the issuer was resolved. */
    source: 'pair-override' | 'registry' | 'legacy-fallback';
}

/** Full routing decision for execution. */
export interface RoutingDecision {
    /** Resolved base-side issuer (null for XRP). */
    base: ResolvedIssuer | null;
    /** Resolved quote-side issuer (null for XRP). */
    quote: ResolvedIssuer | null;
    /** Overall confidence (0–1). 1.0 = tier1 registry match, 0.0 = unresolved. */
    confidence: number;
    /** Ordered fallback chain (alternative issuers for the quote side). */
    fallbackChain: IssuerRecord[];
    /** Audit trace of the routing evaluation. */
    trace: RoutingTraceEntry[];
    /** Whether the decision is usable for execution. */
    executable: boolean;
    /** Reason if not executable. */
    blockReason?: string | undefined;
    /** Timestamp of the decision. */
    decidedAtMs: number;
}

/** Input to the routing engine. */
export interface RoutingRequest {
    /** Base currency code. */
    baseCurrency: string;
    /** Quote currency code. */
    quoteCurrency: string;
    /** Explicit base issuer override (from TradingPair config). */
    baseIssuerOverride?: string | undefined;
    /** Explicit quote issuer override (from TradingPair config). */
    quoteIssuerOverride?: string | undefined;
    /** Legacy issuer fallback (from TradingPair.issuer). */
    legacyIssuerFallback?: string | undefined;
    /** Target network for filtering. */
    network?: Network | undefined;
    /** Set of blacklisted issuer addresses. */
    blacklist?: ReadonlySet<string> | undefined;
    /** Wallet address for trustline checks (future use). */
    walletAddress?: string | undefined;
}

/** Configuration for the routing engine. */
export interface IssuerRouterConfig {
    /** Whether to use registry lookups (default: true). */
    useRegistry: boolean;
    /** Whether to allow legacy fallback cascade (default: true). */
    allowLegacyFallback: boolean;
    /** Minimum tier to accept (default: 'untrusted' = accept all). */
    minTier: IssuerTier;
    /** Whether to check trustline availability (future, default: false). */
    checkTrustlines: boolean;
}

const DEFAULT_CONFIG: IssuerRouterConfig = {
    useRegistry: true,
    allowLegacyFallback: true,
    minTier: 'untrusted',
    checkTrustlines: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tier Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TIER_RANK: Record<IssuerTier, number> = {
    tier1: 1,
    tier2: 2,
    tier3: 3,
    untrusted: 4,
};

const TIER_CONFIDENCE: Record<IssuerTier, number> = {
    tier1: 1.0,
    tier2: 0.8,
    tier3: 0.5,
    untrusted: 0.2,
};

/** Check if a tier meets the minimum requirement. */
function meetsTierMin(tier: IssuerTier, minTier: IssuerTier): boolean {
    return TIER_RANK[tier] <= TIER_RANK[minTier];
}

/** Sort issuers by tier (best first). */
function sortByTier(issuers: readonly IssuerRecord[]): IssuerRecord[] {
    return [...issuers].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Routing Logic
// ─────────────────────────────────────────────────────────────────────────────

const isXRP = (c: string): boolean => c.toUpperCase() === 'XRP';

/**
 * Resolve the issuer for one side of a pair.
 *
 * Priority order:
 *   1. Explicit override (from TradingPair config)
 *   2. Registry lookup (by currency, filtered by network + tier + blacklist)
 *   3. Legacy fallback (from TradingPair.issuer)
 */
function resolveOneSide(
    currency: string,
    override: string | undefined,
    legacyFallback: string | undefined,
    network: Network | undefined,
    blacklist: ReadonlySet<string> | undefined,
    config: IssuerRouterConfig,
    trace: RoutingTraceEntry[],
    stepOffset: number,
): ResolvedIssuer | null {
    // XRP is native — no issuer needed
    if (isXRP(currency)) {
        return null;
    }

    let step = stepOffset;

    // Step 1: Explicit override
    if (override && isValidClassicAddress(override)) {
        if (blacklist?.has(override)) {
            trace.push({
                address: override,
                currency,
                action: 'REJECTED',
                reason: 'pair-override-blacklisted',
                step: step++,
            });
        } else {
            // Check if override is in the registry for tier info
            const record = getIssuer(override, currency) ?? null;
            trace.push({
                address: override,
                currency,
                action: 'SELECTED',
                reason: 'pair-override',
                tier: record?.tier,
                step: step++,
            });
            return {
                address: override,
                currency,
                record,
                source: 'pair-override',
            };
        }
    }

    // Step 2: Registry lookup
    if (config.useRegistry) {
        const candidates = sortByTier(getActiveIssuersForCurrency(currency));

        for (const candidate of candidates) {
            // Network filter
            if (network && candidate.network !== network) {
                trace.push({
                    address: candidate.address,
                    currency,
                    action: 'REJECTED',
                    reason: `network-mismatch:${candidate.network}!=${network}`,
                    tier: candidate.tier,
                    step: step++,
                });
                continue;
            }

            // Tier filter
            if (!meetsTierMin(candidate.tier, config.minTier)) {
                trace.push({
                    address: candidate.address,
                    currency,
                    action: 'REJECTED',
                    reason: `tier-too-low:${candidate.tier}<${config.minTier}`,
                    tier: candidate.tier,
                    step: step++,
                });
                continue;
            }

            // Blacklist filter
            if (blacklist?.has(candidate.address)) {
                trace.push({
                    address: candidate.address,
                    currency,
                    action: 'REJECTED',
                    reason: 'blacklisted',
                    tier: candidate.tier,
                    step: step++,
                });
                continue;
            }

            // Candidate passes all filters — select it
            trace.push({
                address: candidate.address,
                currency,
                action: 'SELECTED',
                reason: 'registry-match',
                tier: candidate.tier,
                step: step++,
            });

            return {
                address: candidate.address,
                currency,
                record: candidate,
                source: 'registry',
            };
        }
    }

    // Step 3: Legacy fallback
    if (config.allowLegacyFallback && legacyFallback && isValidClassicAddress(legacyFallback)) {
        if (blacklist?.has(legacyFallback)) {
            trace.push({
                address: legacyFallback,
                currency,
                action: 'REJECTED',
                reason: 'legacy-fallback-blacklisted',
                step: step++,
            });
        } else {
            trace.push({
                address: legacyFallback,
                currency,
                action: 'SELECTED',
                reason: 'legacy-fallback',
                step: step++,
            });
            return {
                address: legacyFallback,
                currency,
                record: null,
                source: 'legacy-fallback',
            };
        }
    }

    // No issuer resolved
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve issuers for both sides of a trading pair.
 *
 * This is the primary entry point for the IssuerRoutingEngine.
 * Replaces the scattered cascade pattern:
 *   `pair.quoteIssuer ?? pair.baseIssuer ?? pair.issuer`
 *
 * @param request - The routing request containing currencies and overrides.
 * @param config - Optional routing configuration overrides.
 * @returns A RoutingDecision with resolved issuers, confidence, and trace.
 */
export function resolveIssuers(
    request: RoutingRequest,
    config?: Partial<IssuerRouterConfig>,
): RoutingDecision {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const trace: RoutingTraceEntry[] = [];
    const nowMs = Date.now();

    // Resolve base side
    const base = resolveOneSide(
        request.baseCurrency,
        request.baseIssuerOverride,
        request.legacyIssuerFallback,
        request.network,
        request.blacklist,
        cfg,
        trace,
        0,
    );

    // Resolve quote side
    const quote = resolveOneSide(
        request.quoteCurrency,
        request.quoteIssuerOverride,
        request.legacyIssuerFallback,
        request.network,
        request.blacklist,
        cfg,
        trace,
        trace.length,
    );

    // Build fallback chain for quote side (remaining candidates after selection)
    const fallbackChain: IssuerRecord[] = [];
    if (!isXRP(request.quoteCurrency)) {
        const allQuoteCandidates = sortByTier(getActiveIssuersForCurrency(request.quoteCurrency));
        for (const candidate of allQuoteCandidates) {
            if (candidate.address === quote?.address) continue;
            if (request.blacklist?.has(candidate.address)) continue;
            if (!meetsTierMin(candidate.tier, cfg.minTier)) continue;
            if (request.network && candidate.network !== request.network) continue;
            fallbackChain.push(candidate);
            trace.push({
                address: candidate.address,
                currency: request.quoteCurrency,
                action: 'FALLBACK',
                reason: 'alternative-candidate',
                tier: candidate.tier,
                step: trace.length,
            });
        }
    }

    // Calculate confidence
    let confidence = 1.0;
    const baseNeedsIssuer = !isXRP(request.baseCurrency);
    const quoteNeedsIssuer = !isXRP(request.quoteCurrency);

    if (baseNeedsIssuer && !base) {
        confidence = 0;
    } else if (quoteNeedsIssuer && !quote) {
        confidence = 0;
    } else {
        // Average the tier confidence of resolved issuers
        const scores: number[] = [];
        if (base?.record) scores.push(TIER_CONFIDENCE[base.record.tier]);
        else if (base && !base.record) scores.push(0.3); // legacy fallback, no tier
        if (quote?.record) scores.push(TIER_CONFIDENCE[quote.record.tier]);
        else if (quote && !quote.record) scores.push(0.3);
        if (scores.length > 0) {
            confidence = scores.reduce((a, b) => a + b, 0) / scores.length;
        }
    }

    // Determine executability
    let executable = true;
    let blockReason: string | undefined;

    if (baseNeedsIssuer && !base) {
        executable = false;
        blockReason = `No issuer resolved for base currency: ${request.baseCurrency}`;
    } else if (quoteNeedsIssuer && !quote) {
        executable = false;
        blockReason = `No issuer resolved for quote currency: ${request.quoteCurrency}`;
    }

    return {
        base,
        quote,
        confidence: Math.round(confidence * 100) / 100,
        fallbackChain,
        trace,
        executable,
        blockReason,
        decidedAtMs: nowMs,
    };
}

/**
 * Resolve a single issuer for a currency.
 * Convenience wrapper for simple lookups (e.g., trustline checks).
 */
export function resolveIssuerForCurrency(
    currency: string,
    options?: {
        override?: string | undefined;
        legacyFallback?: string | undefined;
        network?: Network | undefined;
        blacklist?: ReadonlySet<string> | undefined;
    },
): ResolvedIssuer | null {
    if (isXRP(currency)) return null;

    const trace: RoutingTraceEntry[] = [];
    return resolveOneSide(
        currency,
        options?.override,
        options?.legacyFallback,
        options?.network,
        options?.blacklist,
        DEFAULT_CONFIG,
        trace,
        0,
    );
}

/**
 * Build the issuer allowlist for risk engine approval.
 * Returns all active issuer addresses for the given currencies.
 *
 * This replaces the hardcoded `new Set([pair.baseIssuer, pair.quoteIssuer, pair.issuer])`.
 */
export function buildIssuerAllowlist(
    baseCurrency: string,
    quoteCurrency: string,
    additionalAddresses?: string[],
): Set<string> {
    const allowed = new Set<string>();

    // Add all registry issuers for both currencies
    if (!isXRP(baseCurrency)) {
        for (const issuer of getActiveIssuersForCurrency(baseCurrency)) {
            allowed.add(issuer.address);
        }
    }
    if (!isXRP(quoteCurrency)) {
        for (const issuer of getActiveIssuersForCurrency(quoteCurrency)) {
            allowed.add(issuer.address);
        }
    }

    // Include any additional addresses (e.g., from pair config)
    if (additionalAddresses) {
        for (const addr of additionalAddresses) {
            if (addr && isValidClassicAddress(addr)) {
                allowed.add(addr);
            }
        }
    }

    return allowed;
}

/**
 * Get the confidence score for an issuer address.
 * Uses the registry tier if available, otherwise returns a low score.
 */
export function getIssuerConfidence(address: string, currency: string): number {
    const record = getIssuer(address, currency);
    if (!record) return 0.1;
    if (record.status !== 'active') return 0;
    return TIER_CONFIDENCE[record.tier];
}

/**
 * Load issuer router config from environment variables.
 */
export function loadIssuerRouterConfig(): Partial<IssuerRouterConfig> {
    const config: Partial<IssuerRouterConfig> = {};

    if (process.env.ISSUER_ROUTER_USE_REGISTRY === 'false') {
        config.useRegistry = false;
    }
    if (process.env.ISSUER_ROUTER_ALLOW_LEGACY === 'false') {
        config.allowLegacyFallback = false;
    }
    if (process.env.ISSUER_ROUTER_MIN_TIER) {
        const tier = process.env.ISSUER_ROUTER_MIN_TIER as IssuerTier;
        if (['tier1', 'tier2', 'tier3', 'untrusted'].includes(tier)) {
            config.minTier = tier;
        }
    }

    return config;
}
