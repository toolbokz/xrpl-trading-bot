/**
 * Issuer Router — Test Suite
 *
 * Covers:
 *   - resolveIssuers: full pair routing with trace + confidence
 *   - resolveOneSide: pair override, registry, legacy fallback
 *   - Blacklist filtering
 *   - Tier-based ranking & min-tier filtering
 *   - Network filtering
 *   - Fallback chain generation
 *   - buildIssuerAllowlist
 *   - getIssuerConfidence
 *   - Edge cases: XRP sides, missing issuers, empty registry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import {
    resolveIssuers,
    resolveIssuerForCurrency,
    buildIssuerAllowlist,
    getIssuerConfidence,
    loadIssuerRouterConfig,
    type RoutingRequest,
    type RoutingDecision,
} from '../issuerRouter';
import {
    resetRegistry,
    registerIssuer,
    registerInstrument,
} from '../instrumentRegistry/registry';
import type { IssuerRecord, Instrument } from '../instrumentRegistry/schema';

// ─── Test Fixtures ────────────────────────────────────────────────────────

// Valid XRPL addresses for testing
const RIPPLE_RLUSD = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const CIRCLE_USDC = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE';
const GATEHUB_EUR = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const BLACKLISTED_ADDR = 'rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL';
const GATEHUB_ETH = 'rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h';

function makeIssuer(overrides: Partial<IssuerRecord> = {}): IssuerRecord {
    const now = new Date().toISOString();
    return {
        address: RIPPLE_RLUSD,
        label: 'Test Issuer',
        currency: 'RLUSD',
        tier: 'tier1',
        network: 'mainnet',
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function makeInstrument(overrides: Partial<Instrument> = {}): Instrument {
    const now = new Date().toISOString();
    return {
        key: 'XRP/RLUSD',
        base: { currency: 'XRP' },
        quote: { currency: 'RLUSD', issuer: RIPPLE_RLUSD },
        description: 'XRP/RLUSD',
        liquidity: 'high',
        network: 'mainnet',
        status: 'active',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

// ─── Setup/Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
    // Use temp directory for each test
    const tempDir = mkdtempSync(join(tmpdir(), 'issuer-router-test-'));
    process.env.INSTRUMENT_DB_PATH = join(tempDir, 'test.sqlite');
    resetRegistry();
});

afterEach(() => {
    resetRegistry();
    delete process.env.INSTRUMENT_DB_PATH;
    delete process.env.ISSUER_ROUTER_USE_REGISTRY;
    delete process.env.ISSUER_ROUTER_ALLOW_LEGACY;
    delete process.env.ISSUER_ROUTER_MIN_TIER;
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('resolveIssuers', () => {
    describe('XRP base pairs (XRP/*)', () => {
        it('should resolve XRP base as null (native)', () => {
            registerIssuer(makeIssuer());
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
            });
            expect(decision.base).toBeNull();
            expect(decision.executable).toBe(true);
        });

        it('should resolve quote issuer from registry', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'RLUSD',
                tier: 'tier1',
            }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
            });
            expect(decision.quote).not.toBeNull();
            expect(decision.quote!.address).toBe(RIPPLE_RLUSD);
            expect(decision.quote!.source).toBe('registry');
            expect(decision.confidence).toBe(1.0);
            expect(decision.executable).toBe(true);
        });

        it('should prefer pair override over registry', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'RLUSD',
                tier: 'tier1',
            }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
                quoteIssuerOverride: CIRCLE_USDC, // different address
            });
            expect(decision.quote!.address).toBe(CIRCLE_USDC);
            expect(decision.quote!.source).toBe('pair-override');
        });
    });

    describe('Tier-based ranking', () => {
        it('should select tier1 over tier2 issuer', () => {
            registerIssuer(makeIssuer({
                address: CIRCLE_USDC,
                currency: 'USD',
                tier: 'tier2',
            }));
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'USD',
                tier: 'tier1',
            }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'USD',
            });
            expect(decision.quote!.address).toBe(RIPPLE_RLUSD);
            expect(decision.quote!.record!.tier).toBe('tier1');
        });

        it('should place non-selected issuers in fallback chain', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'USD',
                tier: 'tier1',
            }));
            registerIssuer(makeIssuer({
                address: CIRCLE_USDC,
                currency: 'USD',
                tier: 'tier2',
            }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'USD',
            });
            expect(decision.fallbackChain).toHaveLength(1);
            expect(decision.fallbackChain[0]!.address).toBe(CIRCLE_USDC);
        });

        it('should enforce minTier filter', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'USD',
                tier: 'tier3',
            }));
            const decision = resolveIssuers(
                { baseCurrency: 'XRP', quoteCurrency: 'USD' },
                { minTier: 'tier2' },
            );
            // tier3 doesn't meet tier2 minimum
            expect(decision.quote).toBeNull();
            expect(decision.executable).toBe(false);
        });
    });

    describe('Blacklist filtering', () => {
        it('should reject blacklisted issuer from registry', () => {
            registerIssuer(makeIssuer({
                address: BLACKLISTED_ADDR,
                currency: 'BTC',
                tier: 'tier1',
            }));
            const blacklist = new Set([BLACKLISTED_ADDR]);
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'BTC',
                blacklist,
            });
            expect(decision.quote).toBeNull();
            expect(decision.executable).toBe(false);
            // Trace should show rejection
            const rejected = decision.trace.find(t => t.action === 'REJECTED');
            expect(rejected).toBeDefined();
            expect(rejected!.reason).toBe('blacklisted');
        });

        it('should reject blacklisted pair override', () => {
            const blacklist = new Set([RIPPLE_RLUSD]);
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
                quoteIssuerOverride: RIPPLE_RLUSD,
                blacklist,
            });
            // Override was rejected, falls through to registry/legacy
            const rejected = decision.trace.find(
                t => t.action === 'REJECTED' && t.reason === 'pair-override-blacklisted'
            );
            expect(rejected).toBeDefined();
        });

        it('should skip blacklisted issuer and pick next', () => {
            registerIssuer(makeIssuer({
                address: BLACKLISTED_ADDR,
                currency: 'USD',
                tier: 'tier1',
            }));
            registerIssuer(makeIssuer({
                address: CIRCLE_USDC,
                currency: 'USD',
                tier: 'tier2',
            }));
            const blacklist = new Set([BLACKLISTED_ADDR]);
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'USD',
                blacklist,
            });
            expect(decision.quote!.address).toBe(CIRCLE_USDC);
        });
    });

    describe('Network filtering', () => {
        it('should filter by network', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'RLUSD',
                tier: 'tier1',
                network: 'mainnet',
            }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
                network: 'testnet', // doesn't match
            });
            expect(decision.quote).toBeNull();
            expect(decision.executable).toBe(false);
        });

        it('should select matching network issuer', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'RLUSD',
                tier: 'tier1',
                network: 'mainnet',
            }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
                network: 'mainnet',
            });
            expect(decision.quote!.address).toBe(RIPPLE_RLUSD);
        });
    });

    describe('Legacy fallback', () => {
        it('should use legacy fallback when registry has no match', () => {
            // No issuers registered
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'NZD',
                legacyIssuerFallback: GATEHUB_EUR,
            });
            expect(decision.quote!.address).toBe(GATEHUB_EUR);
            expect(decision.quote!.source).toBe('legacy-fallback');
            expect(decision.quote!.record).toBeNull();
            // Lower confidence for legacy
            expect(decision.confidence).toBeLessThan(0.5);
        });

        it('should not use legacy fallback when disabled', () => {
            const decision = resolveIssuers(
                {
                    baseCurrency: 'XRP',
                    quoteCurrency: 'NZD',
                    legacyIssuerFallback: GATEHUB_EUR,
                },
                { allowLegacyFallback: false },
            );
            expect(decision.quote).toBeNull();
            expect(decision.executable).toBe(false);
        });
    });

    describe('Confidence scoring', () => {
        it('should give 1.0 confidence for tier1 registry match', () => {
            registerIssuer(makeIssuer({ tier: 'tier1' }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
            });
            expect(decision.confidence).toBe(1.0);
        });

        it('should give 0.8 confidence for tier2 registry match', () => {
            registerIssuer(makeIssuer({ tier: 'tier2' }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
            });
            expect(decision.confidence).toBe(0.8);
        });

        it('should give 0.0 confidence when no issuer resolved', () => {
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'UNKNOWN_CURRENCY',
            });
            expect(decision.confidence).toBe(0);
            expect(decision.executable).toBe(false);
        });

        it('should average confidence for two-sided issued pair', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'RLUSD',
                tier: 'tier1', // 1.0
            }));
            registerIssuer(makeIssuer({
                address: GATEHUB_EUR,
                currency: 'EUR',
                tier: 'tier2', // 0.8
            }));
            const decision = resolveIssuers({
                baseCurrency: 'RLUSD',
                quoteCurrency: 'EUR',
            });
            // Average of 1.0 and 0.8
            expect(decision.confidence).toBe(0.9);
        });
    });

    describe('Trace & observability', () => {
        it('should produce trace entries for all evaluated candidates', () => {
            registerIssuer(makeIssuer({
                address: RIPPLE_RLUSD,
                currency: 'RLUSD',
                tier: 'tier1',
            }));
            registerIssuer(makeIssuer({
                address: CIRCLE_USDC,
                currency: 'RLUSD',
                tier: 'tier2',
            }));
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
            });
            // Should have SELECTED + FALLBACK trace entries
            const selected = decision.trace.filter(t => t.action === 'SELECTED');
            const fallback = decision.trace.filter(t => t.action === 'FALLBACK');
            expect(selected).toHaveLength(1);
            expect(fallback).toHaveLength(1);
        });

        it('should include decidedAtMs timestamp', () => {
            const before = Date.now();
            registerIssuer(makeIssuer());
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
            });
            expect(decision.decidedAtMs).toBeGreaterThanOrEqual(before);
            expect(decision.decidedAtMs).toBeLessThanOrEqual(Date.now());
        });
    });

    describe('Executability', () => {
        it('should be executable when all sides resolved', () => {
            registerIssuer(makeIssuer());
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'RLUSD',
            });
            expect(decision.executable).toBe(true);
            expect(decision.blockReason).toBeUndefined();
        });

        it('should not be executable when quote side unresolved', () => {
            const decision = resolveIssuers({
                baseCurrency: 'XRP',
                quoteCurrency: 'UNKNOWN',
            });
            expect(decision.executable).toBe(false);
            expect(decision.blockReason).toContain('No issuer resolved');
            expect(decision.blockReason).toContain('UNKNOWN');
        });

        it('should not be executable when base side (issued) unresolved', () => {
            const decision = resolveIssuers({
                baseCurrency: 'DOGE', // issued, needs issuer, not in seed data
                quoteCurrency: 'XRP',
            });
            expect(decision.executable).toBe(false);
            expect(decision.blockReason).toContain('base currency');
        });
    });

    describe('Config override', () => {
        it('should skip registry when useRegistry=false', () => {
            registerIssuer(makeIssuer());
            const decision = resolveIssuers(
                { baseCurrency: 'XRP', quoteCurrency: 'RLUSD' },
                { useRegistry: false },
            );
            // No registry lookup, no legacy fallback → unresolved
            expect(decision.quote).toBeNull();
            expect(decision.executable).toBe(false);
        });

        it('should use legacy fallback even with registry disabled', () => {
            const decision = resolveIssuers(
                {
                    baseCurrency: 'XRP',
                    quoteCurrency: 'RLUSD',
                    legacyIssuerFallback: RIPPLE_RLUSD,
                },
                { useRegistry: false, allowLegacyFallback: true },
            );
            expect(decision.quote!.address).toBe(RIPPLE_RLUSD);
            expect(decision.quote!.source).toBe('legacy-fallback');
        });
    });
});

describe('resolveIssuerForCurrency', () => {
    it('should return null for XRP', () => {
        expect(resolveIssuerForCurrency('XRP')).toBeNull();
    });

    it('should resolve from registry', () => {
        registerIssuer(makeIssuer({
            address: RIPPLE_RLUSD,
            currency: 'RLUSD',
            tier: 'tier1',
        }));
        const result = resolveIssuerForCurrency('RLUSD');
        expect(result).not.toBeNull();
        expect(result!.address).toBe(RIPPLE_RLUSD);
        expect(result!.source).toBe('registry');
    });

    it('should use explicit override', () => {
        registerIssuer(makeIssuer({
            address: RIPPLE_RLUSD,
            currency: 'RLUSD',
            tier: 'tier1',
        }));
        const result = resolveIssuerForCurrency('RLUSD', {
            override: CIRCLE_USDC,
        });
        expect(result!.address).toBe(CIRCLE_USDC);
        expect(result!.source).toBe('pair-override');
    });

    it('should use legacy fallback when no registry match', () => {
        const result = resolveIssuerForCurrency('NZD', {
            legacyFallback: GATEHUB_EUR,
        });
        expect(result!.address).toBe(GATEHUB_EUR);
        expect(result!.source).toBe('legacy-fallback');
    });

    it('should return null when nothing resolves', () => {
        const result = resolveIssuerForCurrency('UNKNOWN');
        expect(result).toBeNull();
    });
});

describe('buildIssuerAllowlist', () => {
    it('should include all active issuers for both currencies', () => {
        registerIssuer(makeIssuer({
            address: RIPPLE_RLUSD,
            currency: 'RLUSD',
        }));
        registerIssuer(makeIssuer({
            address: CIRCLE_USDC,
            currency: 'RLUSD',
            tier: 'tier2',
        }));
        const allowlist = buildIssuerAllowlist('XRP', 'RLUSD');
        expect(allowlist.has(RIPPLE_RLUSD)).toBe(true);
        expect(allowlist.has(CIRCLE_USDC)).toBe(true);
    });

    it('should skip XRP side', () => {
        const allowlist = buildIssuerAllowlist('XRP', 'XRP');
        expect(allowlist.size).toBe(0);
    });

    it('should include additional addresses', () => {
        const allowlist = buildIssuerAllowlist('XRP', 'RLUSD', [GATEHUB_EUR]);
        expect(allowlist.has(GATEHUB_EUR)).toBe(true);
    });

    it('should reject invalid additional addresses', () => {
        const allowlist = buildIssuerAllowlist('XRP', 'RLUSD', ['not-valid']);
        expect(allowlist.has('not-valid')).toBe(false);
    });
});

describe('getIssuerConfidence', () => {
    it('should return 1.0 for tier1 active issuer', () => {
        registerIssuer(makeIssuer({
            address: RIPPLE_RLUSD,
            currency: 'RLUSD',
            tier: 'tier1',
        }));
        expect(getIssuerConfidence(RIPPLE_RLUSD, 'RLUSD')).toBe(1.0);
    });

    it('should return 0.8 for tier2 active issuer', () => {
        registerIssuer(makeIssuer({
            address: CIRCLE_USDC,
            currency: 'USD',
            tier: 'tier2',
        }));
        expect(getIssuerConfidence(CIRCLE_USDC, 'USD')).toBe(0.8);
    });

    it('should return 0.1 for unknown issuer', () => {
        expect(getIssuerConfidence('rUnKnownAddress123456789012', 'XYZ')).toBe(0.1);
    });

    it('should return 0 for disabled issuer', () => {
        registerIssuer(makeIssuer({
            address: RIPPLE_RLUSD,
            currency: 'RLUSD',
            status: 'disabled',
        }));
        expect(getIssuerConfidence(RIPPLE_RLUSD, 'RLUSD')).toBe(0);
    });
});

describe('loadIssuerRouterConfig', () => {
    it('should return empty config by default', () => {
        const config = loadIssuerRouterConfig();
        expect(config).toEqual({});
    });

    it('should read ISSUER_ROUTER_USE_REGISTRY=false', () => {
        process.env.ISSUER_ROUTER_USE_REGISTRY = 'false';
        const config = loadIssuerRouterConfig();
        expect(config.useRegistry).toBe(false);
    });

    it('should read ISSUER_ROUTER_ALLOW_LEGACY=false', () => {
        process.env.ISSUER_ROUTER_ALLOW_LEGACY = 'false';
        const config = loadIssuerRouterConfig();
        expect(config.allowLegacyFallback).toBe(false);
    });

    it('should read ISSUER_ROUTER_MIN_TIER', () => {
        process.env.ISSUER_ROUTER_MIN_TIER = 'tier2';
        const config = loadIssuerRouterConfig();
        expect(config.minTier).toBe('tier2');
    });

    it('should ignore invalid ISSUER_ROUTER_MIN_TIER', () => {
        process.env.ISSUER_ROUTER_MIN_TIER = 'invalid';
        const config = loadIssuerRouterConfig();
        expect(config.minTier).toBeUndefined();
    });
});

describe('Edge cases', () => {
    it('should handle both sides being XRP (no issuers needed)', () => {
        const decision = resolveIssuers({
            baseCurrency: 'XRP',
            quoteCurrency: 'XRP',
        });
        expect(decision.base).toBeNull();
        expect(decision.quote).toBeNull();
        expect(decision.executable).toBe(true);
        expect(decision.confidence).toBe(1.0);
    });

    it('should handle unseeded currency gracefully', () => {
        // Registry auto-seeds with RLUSD, USDC, EUR, BTC, ETH
        // Using an unseeded currency tests the "no match" path
        const decision = resolveIssuers({
            baseCurrency: 'XRP',
            quoteCurrency: 'DOGE', // not in seed data
        });
        expect(decision.quote).toBeNull();
        expect(decision.executable).toBe(false);
    });

    it('should handle case-insensitive XRP', () => {
        const decision = resolveIssuers({
            baseCurrency: 'xrp',
            quoteCurrency: 'RLUSD',
            legacyIssuerFallback: RIPPLE_RLUSD,
        });
        expect(decision.base).toBeNull(); // xrp is still XRP
    });

    it('should handle issued/issued pair (both sides need resolution)', () => {
        registerIssuer(makeIssuer({
            address: RIPPLE_RLUSD,
            currency: 'RLUSD',
            tier: 'tier1',
        }));
        registerIssuer(makeIssuer({
            address: GATEHUB_EUR,
            currency: 'EUR',
            tier: 'tier2',
        }));
        const decision = resolveIssuers({
            baseCurrency: 'RLUSD',
            quoteCurrency: 'EUR',
        });
        expect(decision.base!.address).toBe(RIPPLE_RLUSD);
        expect(decision.quote!.address).toBe(GATEHUB_EUR);
        expect(decision.executable).toBe(true);
    });

    it('should include override issuer record from registry if it exists', () => {
        registerIssuer(makeIssuer({
            address: RIPPLE_RLUSD,
            currency: 'RLUSD',
            tier: 'tier1',
        }));
        const decision = resolveIssuers({
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuerOverride: RIPPLE_RLUSD,
        });
        // Override is used, but record is attached from registry
        expect(decision.quote!.source).toBe('pair-override');
        expect(decision.quote!.record).not.toBeNull();
        expect(decision.quote!.record!.tier).toBe('tier1');
    });
});
