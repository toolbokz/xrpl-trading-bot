/**
 * Trustline Governance — Registry-Backed Trustline Policy Enforcement
 *
 * Provides pre-trade trustline validation and automated trustline
 * management that integrates with:
 *   - Instrument Registry (Phase 1): issuer tier + metadata
 *   - Issuer Router (Phase 2): deterministic issuer resolution
 *   - Availability Scanner (Phase 4): issuer health probes
 *   - Execution Pair Resolver (Phase 5): resolved pair legs
 *
 * Features:
 *   1. Pre-trade gate: block execution if required trustlines are missing
 *   2. Auto-ensure: create trustlines for registered issuers on pair switch
 *   3. Tier-based limits: different trustline limits per issuer tier
 *   4. Blacklist enforcement: never create trustlines to blacklisted issuers
 *   5. Governance audit trail: log all trustline decisions
 *
 * @module market/trustlineGovernance
 */

import type { Client, Wallet } from 'xrpl';
import type { TradingPair, RiskConfig } from '../config';
import { TrustlineManager, type TrustlineParams } from '../xrpl/trustlines';
import {
    resolvePair,
    type ResolvedPair,
    type ResolvedLeg,
    type ExecutionPairResolverConfig,
} from './executionPairResolver';
import {
    findInstrument,
    type IssuerTier,
} from './instrumentRegistry';
import { logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TrustlineDecision = 'ALLOW' | 'CREATE' | 'BLOCK' | 'SKIP';

export interface TrustlineCheckResult {
    /** The decision taken. */
    decision: TrustlineDecision;
    /** Pair key. */
    pairKey: string;
    /** Whether the base leg needs a trustline. */
    baseNeeded: boolean;
    /** Whether the quote leg needs a trustline. */
    quoteNeeded: boolean;
    /** Whether existing trustlines are present. */
    baseExists: boolean;
    /** Whether existing trustlines are present. */
    quoteExists: boolean;
    /** Reasons for blocking (empty if not blocked). */
    blockReasons: string[];
    /** The resolved pair used for the check. */
    resolved: ResolvedPair;
    /** Timestamp of the check. */
    checkedAtMs: number;
}

export interface TrustlineGovernanceConfig {
    /** Enable auto-creation of missing trustlines (default: true). */
    autoEnsure: boolean;
    /** Maximum trustline limit per issuer tier. */
    tierLimits: Record<IssuerTier, string>;
    /** Default trustline limit when tier is unknown (default: "1000000"). */
    defaultLimit: string;
    /** Block trustlines to issuers not in the instrument registry (default: false). */
    requireRegistered: boolean;
    /** Resolver config overrides. */
    resolverConfig: Partial<ExecutionPairResolverConfig>;
}

const DEFAULT_CONFIG: TrustlineGovernanceConfig = {
    autoEnsure: true,
    tierLimits: {
        tier1: '1000000000', // 1B — stablecoins, major tokens
        tier2: '100000000',  // 100M — established tokens
        tier3: '10000000',   // 10M — newer tokens
        untrusted: '1000000', // 1M — minimum viable limit
    },
    defaultLimit: '1000000',
    requireRegistered: false,
    resolverConfig: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine the trustline limit for a given issuer tier.
 */
export function getTrustlineLimit(
    tier: IssuerTier | null,
    config: TrustlineGovernanceConfig = DEFAULT_CONFIG,
): string {
    if (!tier) return config.defaultLimit;
    return config.tierLimits[tier] ?? config.defaultLimit;
}

/**
 * Check whether a leg requires a trustline.
 * XRP legs never need trustlines. Issued currency legs always do.
 */
export function legNeedsTrustline(leg: ResolvedLeg): boolean {
    return !leg.isXRP && !!leg.issuer;
}

/**
 * Check if an issuer is blocked by the risk config blacklist.
 */
function isIssuerBlocked(issuer: string, blacklist: ReadonlySet<string>): boolean {
    return blacklist.has(issuer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance Engine
// ─────────────────────────────────────────────────────────────────────────────

export class TrustlineGovernance {
    private readonly config: TrustlineGovernanceConfig;
    private readonly trustlineManager: TrustlineManager;
    private readonly blacklist: ReadonlySet<string>;

    constructor(
        client: Client,
        risk: RiskConfig,
        paperMode: boolean,
        config?: Partial<TrustlineGovernanceConfig>,
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.trustlineManager = new TrustlineManager(client, risk, paperMode);
        this.blacklist = risk.issuerBlacklist;
    }

    /**
     * Pre-trade gate: check if all required trustlines are in place.
     *
     * Does NOT create trustlines — only checks. Use `ensureForPair()`
     * to create missing trustlines.
     *
     * @returns TrustlineCheckResult with decision and details
     */
    async checkForPair(
        pair: TradingPair,
        walletAddress: string,
    ): Promise<TrustlineCheckResult> {
        const nowMs = Date.now();
        const resolved = resolvePair(pair, {
            ...this.config.resolverConfig,
            failOnUnresolvable: false,
        });

        const pairKey = resolved.pairKey;
        const blockReasons: string[] = [];

        // Check if pair is executable
        if (!resolved.executable) {
            blockReasons.push(`pair-not-executable: ${resolved.blockReason}`);
            return {
                decision: 'BLOCK',
                pairKey,
                baseNeeded: false,
                quoteNeeded: false,
                baseExists: false,
                quoteExists: false,
                blockReasons,
                resolved,
                checkedAtMs: nowMs,
            };
        }

        const baseNeeded = legNeedsTrustline(resolved.base);
        const quoteNeeded = legNeedsTrustline(resolved.quote);

        // Check blacklist
        if (baseNeeded && resolved.base.issuer && isIssuerBlocked(resolved.base.issuer, this.blacklist)) {
            blockReasons.push(`base-issuer-blacklisted: ${resolved.base.issuer}`);
        }
        if (quoteNeeded && resolved.quote.issuer && isIssuerBlocked(resolved.quote.issuer, this.blacklist)) {
            blockReasons.push(`quote-issuer-blacklisted: ${resolved.quote.issuer}`);
        }

        if (blockReasons.length > 0) {
            return {
                decision: 'BLOCK',
                pairKey,
                baseNeeded,
                quoteNeeded,
                baseExists: false,
                quoteExists: false,
                blockReasons,
                resolved,
                checkedAtMs: nowMs,
            };
        }

        // Check registry requirement
        if (this.config.requireRegistered) {
            const instrument = findInstrument(pairKey);
            if (!instrument) {
                blockReasons.push('pair-not-registered');
                return {
                    decision: 'BLOCK',
                    pairKey,
                    baseNeeded,
                    quoteNeeded,
                    baseExists: false,
                    quoteExists: false,
                    blockReasons,
                    resolved,
                    checkedAtMs: nowMs,
                };
            }
        }

        // If no trustlines needed (e.g., XRP/XRP — shouldn't happen but defensive)
        if (!baseNeeded && !quoteNeeded) {
            return {
                decision: 'SKIP',
                pairKey,
                baseNeeded: false,
                quoteNeeded: false,
                baseExists: true,
                quoteExists: true,
                blockReasons: [],
                resolved,
                checkedAtMs: nowMs,
            };
        }

        // Check existing trustlines via TrustlineManager
        // Build a synthetic TradingPair for each leg that needs checking
        let baseExists = !baseNeeded; // true if not needed
        let quoteExists = !quoteNeeded; // true if not needed

        if (baseNeeded && resolved.base.issuer) {
            try {
                baseExists = await this.hasTrustlineForLeg(
                    walletAddress,
                    resolved.base.currency,
                    resolved.base.issuer,
                );
            } catch {
                baseExists = false;
            }
        }

        if (quoteNeeded && resolved.quote.issuer) {
            try {
                quoteExists = await this.hasTrustlineForLeg(
                    walletAddress,
                    resolved.quote.currency,
                    resolved.quote.issuer,
                );
            } catch {
                quoteExists = false;
            }
        }

        const allExist = baseExists && quoteExists;
        const decision: TrustlineDecision = allExist
            ? 'ALLOW'
            : (this.config.autoEnsure ? 'CREATE' : 'BLOCK');

        if (!allExist && !this.config.autoEnsure) {
            if (!baseExists) blockReasons.push('base-trustline-missing');
            if (!quoteExists) blockReasons.push('quote-trustline-missing');
        }

        return {
            decision,
            pairKey,
            baseNeeded,
            quoteNeeded,
            baseExists,
            quoteExists,
            blockReasons,
            resolved,
            checkedAtMs: nowMs,
        };
    }

    /**
     * Ensure all required trustlines are in place for a pair.
     *
     * Creates missing trustlines using tier-appropriate limits.
     * Respects blacklist and registry requirements.
     *
     * @returns true if all trustlines are in place (or created successfully)
     */
    async ensureForPair(
        pair: TradingPair,
        wallet: Wallet,
    ): Promise<{ success: boolean; created: string[]; errors: string[] }> {
        const check = await this.checkForPair(pair, wallet.classicAddress);
        const created: string[] = [];
        const errors: string[] = [];

        if (check.decision === 'BLOCK') {
            logger.warn({
                pairKey: check.pairKey,
                reasons: check.blockReasons,
            }, 'Trustline governance: BLOCKED — cannot ensure trustlines');
            return { success: false, created, errors: check.blockReasons };
        }

        if (check.decision === 'SKIP' || check.decision === 'ALLOW') {
            return { success: true, created, errors };
        }

        // decision === 'CREATE' — create missing trustlines
        const resolved = check.resolved;

        if (check.baseNeeded && !check.baseExists && resolved.base.issuer) {
            const limit = getTrustlineLimit(resolved.base.tier, this.config);
            const basePair: TradingPair = {
                baseCurrency: 'XRP',
                quoteCurrency: resolved.base.currency,
                quoteIssuer: resolved.base.issuer,
                issuer: resolved.base.issuer,
            };
            const params: TrustlineParams = { limit };

            logger.info({
                currency: resolved.base.currency,
                issuer: resolved.base.issuer,
                limit,
                tier: resolved.base.tier,
            }, 'Trustline governance: creating base trustline');

            const ok = await this.trustlineManager.ensure(basePair, wallet, params);
            if (ok) {
                created.push(`${resolved.base.currency}:${resolved.base.issuer}`);
            } else {
                errors.push(`failed-base-trustline:${resolved.base.currency}`);
            }
        }

        if (check.quoteNeeded && !check.quoteExists && resolved.quote.issuer) {
            const limit = getTrustlineLimit(resolved.quote.tier, this.config);
            const quotePair: TradingPair = {
                baseCurrency: 'XRP',
                quoteCurrency: resolved.quote.currency,
                quoteIssuer: resolved.quote.issuer,
                issuer: resolved.quote.issuer,
            };
            const params: TrustlineParams = { limit };

            logger.info({
                currency: resolved.quote.currency,
                issuer: resolved.quote.issuer,
                limit,
                tier: resolved.quote.tier,
            }, 'Trustline governance: creating quote trustline');

            const ok = await this.trustlineManager.ensure(quotePair, wallet, params);
            if (ok) {
                created.push(`${resolved.quote.currency}:${resolved.quote.issuer}`);
            } else {
                errors.push(`failed-quote-trustline:${resolved.quote.currency}`);
            }
        }

        const success = errors.length === 0;
        if (success) {
            logger.info({
                pairKey: check.pairKey,
                created,
            }, 'Trustline governance: all trustlines ensured');
        } else {
            logger.warn({
                pairKey: check.pairKey,
                created,
                errors,
            }, 'Trustline governance: some trustlines failed');
        }

        return { success, created, errors };
    }

    /**
     * Check if a trustline exists for a specific leg.
     * Uses raw account_lines instead of TrustlineManager for direct checking.
     */
    private async hasTrustlineForLeg(
        account: string,
        currency: string,
        issuer: string,
    ): Promise<boolean> {
        try {
            const client = (this.trustlineManager as any).client as Client;
            const lines = await client.request({
                command: 'account_lines',
                account,
                peer: issuer,
            });
            return lines.result.lines.some(
                (line) => line.currency === currency && line.account === issuer,
            );
        } catch {
            return false;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loader
// ─────────────────────────────────────────────────────────────────────────────

export function loadTrustlineGovernanceConfig(): Partial<TrustlineGovernanceConfig> {
    const config: Partial<TrustlineGovernanceConfig> = {};

    if (process.env.TRUSTLINE_AUTO_ENSURE === 'false') {
        config.autoEnsure = false;
    }

    if (process.env.TRUSTLINE_REQUIRE_REGISTERED === 'true') {
        config.requireRegistered = true;
    }

    const defaultLimit = process.env.TRUSTLINE_DEFAULT_LIMIT;
    if (defaultLimit && /^\d+$/.test(defaultLimit)) {
        config.defaultLimit = defaultLimit;
    }

    return config;
}
