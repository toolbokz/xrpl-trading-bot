/**
 * Execution Pair Resolver — Comprehensive Tests
 *
 * Tests the single-entry-point pair→XRPL translation layer that
 * replaces the 4× duplicated issuer resolution cascade.
 *
 * Coverage:
 *   - resolvePair(): XRP/issued, issued/issued, XRP/XRP edge
 *   - formatAmount(): drops vs issued object
 *   - buildOfferAmounts(): BUY/SELL → TakerGets/TakerPays
 *   - IssuerRouter integration: tier-aware resolution, blacklist
 *   - Error handling: missing issuer, invalid currency
 *   - Legacy elimination: resolver replaces pair.issuer cascade
 *   - ExecutionPairResolver class: caching, invalidation
 *   - Bridge functions: resolveToNormalizedPair, resolveIssuerForRisk
 *   - Validation: validateResolvedPair, assertResolvedPairValid
 *
 * @module market/__tests__/executionPairResolver.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    resolvePair,
    formatAmount,
    buildOfferAmounts,
    extractPrimaryIssuer,
    extractIssuerSet,
    legToXrplCurrency,
    parsePairKey,
    toPrecisionString,
    ExecutionPairResolver,
    resolveToNormalizedPair,
    resolveIssuerForRisk,
    resolveLegsForApi,
    validateResolvedPair,
    assertResolvedPairValid,
    loadExecutionPairResolverConfig,
    type ResolvedPair,
    type ResolvedLeg,
    type TradeSide,
    type XrplAmount,
} from '../executionPairResolver';
import type { TradingPair } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const USDC_ISSUER = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE';
const EUR_ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const BTC_ISSUER = 'rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL';
const ETH_ISSUER = 'rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h';

/** XRP/RLUSD pair — most common case. */
const xrpRlusd: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: RLUSD_ISSUER,
};

/** XRP/RLUSD with explicit issuers and legacy fallback. */
const xrpRlusdExplicit: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    baseIssuer: undefined,
    quoteIssuer: RLUSD_ISSUER,
    issuer: RLUSD_ISSUER,
};

/** XRP/USDC pair. */
const xrpUsdc: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'USDC',
    quoteIssuer: USDC_ISSUER,
};

/** XRP/EUR pair. */
const xrpEur: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'EUR',
    quoteIssuer: EUR_ISSUER,
};

/** XRP/BTC pair. */
const xrpBtc: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'BTC',
    quoteIssuer: BTC_ISSUER,
};

/** Pair with only legacy issuer (the pattern we're eliminating). */
const xrpRlusdLegacyOnly: TradingPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    issuer: RLUSD_ISSUER,
};

// ─────────────────────────────────────────────────────────────────────────────
// parsePairKey
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePairKey', () => {
    it('parses XRP/RLUSD', () => {
        const result = parsePairKey('XRP/RLUSD');
        expect(result.base).toBe('XRP');
        expect(result.quote).toBe('RLUSD');
    });

    it('uppercases both sides', () => {
        const result = parsePairKey('xrp/rlusd');
        expect(result.base).toBe('XRP');
        expect(result.quote).toBe('RLUSD');
    });

    it('handles standard 3-char codes', () => {
        const result = parsePairKey('XRP/EUR');
        expect(result.base).toBe('XRP');
        expect(result.quote).toBe('EUR');
    });

    it('throws on missing separator', () => {
        expect(() => parsePairKey('XRPRLUSD')).toThrow('Invalid pair key format');
    });

    it('throws on empty base', () => {
        expect(() => parsePairKey('/RLUSD')).toThrow('Invalid pair key format');
    });

    it('throws on empty quote', () => {
        expect(() => parsePairKey('XRP/')).toThrow('Invalid pair key format');
    });

    it('throws on triple-segment key', () => {
        expect(() => parsePairKey('XRP/RLUSD/USD')).toThrow('Invalid pair key format');
    });

    it('throws on empty string', () => {
        expect(() => parsePairKey('')).toThrow('Invalid pair key format');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// toPrecisionString
// ─────────────────────────────────────────────────────────────────────────────

describe('toPrecisionString', () => {
    it('converts integer to string', () => {
        expect(toPrecisionString(100)).toBe('100');
    });

    it('converts decimal to string', () => {
        expect(toPrecisionString(1.5)).toBe('1.5');
    });

    it('handles small decimal', () => {
        const result = toPrecisionString(0.000001);
        expect(parseFloat(result)).toBeCloseTo(0.000001);
    });

    it('strips trailing zeros', () => {
        expect(toPrecisionString(1.0)).toBe('1');
    });

    it('throws on zero', () => {
        expect(() => toPrecisionString(0)).toThrow('positive finite');
    });

    it('throws on negative', () => {
        expect(() => toPrecisionString(-1)).toThrow('positive finite');
    });

    it('throws on NaN', () => {
        expect(() => toPrecisionString(NaN)).toThrow('positive finite');
    });

    it('throws on Infinity', () => {
        expect(() => toPrecisionString(Infinity)).toThrow('positive finite');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePair — XRP/Issued Currency
// ─────────────────────────────────────────────────────────────────────────────

describe('resolvePair — XRP/Issued', () => {
    it('resolves XRP/RLUSD with explicit quoteIssuer', () => {
        const result = resolvePair(xrpRlusd);
        expect(result.pairKey).toBe('XRP/RLUSD');
        expect(result.executable).toBe(true);
        expect(result.blockReason).toBeUndefined();
        expect(result.confidence).toBeGreaterThan(0);

        // Base = XRP
        expect(result.base.isXRP).toBe(true);
        expect(result.base.currency).toBe('XRP');
        expect(result.base.xrplCurrency).toBe('XRP');
        expect(result.base.issuer).toBeUndefined();
        expect(result.base.source).toBeNull();

        // Quote = RLUSD
        expect(result.quote.isXRP).toBe(false);
        expect(result.quote.currency).toBe('RLUSD');
        expect(result.quote.issuer).toBe(RLUSD_ISSUER);
        expect(result.quote.xrplCurrency).toHaveLength(40); // hex-encoded
    });

    it('resolves XRP/RLUSD from pair key string', () => {
        const result = resolvePair('XRP/RLUSD');
        expect(result.pairKey).toBe('XRP/RLUSD');
        expect(result.executable).toBe(true);
        expect(result.base.isXRP).toBe(true);
        expect(result.quote.isXRP).toBe(false);
        expect(result.quote.issuer).toBe(RLUSD_ISSUER);
    });

    it('resolves XRP/USDC', () => {
        const result = resolvePair(xrpUsdc);
        expect(result.executable).toBe(true);
        expect(result.quote.issuer).toBe(USDC_ISSUER);
    });

    it('resolves XRP/EUR', () => {
        const result = resolvePair(xrpEur);
        expect(result.executable).toBe(true);
        expect(result.quote.issuer).toBe(EUR_ISSUER);
        expect(result.quote.xrplCurrency).toBe('EUR'); // 3-char, no hex encoding
    });

    it('resolves XRP/BTC', () => {
        const result = resolvePair(xrpBtc);
        expect(result.executable).toBe(true);
        expect(result.quote.issuer).toBe(BTC_ISSUER);
        expect(result.quote.xrplCurrency).toBe('BTC');
    });

    it('produces routing trace entries', () => {
        const result = resolvePair(xrpRlusd);
        expect(result.routingTrace.length).toBeGreaterThan(0);
        // At least one SELECTED action for the quote side
        const selectedEntries = result.routingTrace.filter(e => e.action === 'SELECTED');
        expect(selectedEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('has valid resolvedAtMs timestamp', () => {
        const before = Date.now();
        const result = resolvePair(xrpRlusd);
        const after = Date.now();
        expect(result.resolvedAtMs).toBeGreaterThanOrEqual(before);
        expect(result.resolvedAtMs).toBeLessThanOrEqual(after);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePair — Legacy Issuer Fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('resolvePair — Legacy Issuer Fallback', () => {
    it('resolves via legacy pair.issuer when no explicit quoteIssuer', () => {
        const result = resolvePair(xrpRlusdLegacyOnly);
        expect(result.executable).toBe(true);
        expect(result.quote.issuer).toBe(RLUSD_ISSUER);
    });

    it('prefers explicit quoteIssuer over legacy issuer', () => {
        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuer: RLUSD_ISSUER,
            issuer: 'rSomeOtherAddress999999999999999999', // Different legacy
        };
        const result = resolvePair(pair);
        expect(result.executable).toBe(true);
        // Should use the explicit quoteIssuer, not the legacy
        expect(result.quote.issuer).toBe(RLUSD_ISSUER);
    });

    it('prefers registry over legacy when no explicit override', () => {
        // Resolve from key string — no override, should use registry
        const result = resolvePair('XRP/RLUSD');
        expect(result.executable).toBe(true);
        expect(result.quote.issuer).toBe(RLUSD_ISSUER);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePair — Error Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('resolvePair — Error Cases', () => {
    it('throws on same currency pair', () => {
        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'XRP',
        };
        expect(() => resolvePair(pair)).toThrow('must differ');
    });

    it('throws on unresolvable issuer when failOnUnresolvable=true', () => {
        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'FAKECOIN',
            // No issuer, not in registry
        };
        expect(() => resolvePair(pair, { failOnUnresolvable: true })).toThrow('not executable');
    });

    it('returns non-executable when failOnUnresolvable=false', () => {
        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'FAKECOIN',
        };
        const result = resolvePair(pair, { failOnUnresolvable: false });
        expect(result.executable).toBe(false);
        expect(result.confidence).toBe(0);
        expect(result.blockReason).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePair — Blacklist
// ─────────────────────────────────────────────────────────────────────────────

describe('resolvePair — Blacklist', () => {
    it('blocks blacklisted issuer', () => {
        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            quoteIssuer: RLUSD_ISSUER,
        };
        const blacklist = new Set([RLUSD_ISSUER]);

        // With failOnUnresolvable=false, should get non-executable
        const result = resolvePair(pair, {
            blacklist,
            failOnUnresolvable: false,
            routerConfig: { allowLegacyFallback: false, useRegistry: false },
        });
        expect(result.executable).toBe(false);

        // Trace should show REJECTED
        const rejected = result.routingTrace.filter(e => e.action === 'REJECTED');
        expect(rejected.length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePair — Network Filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('resolvePair — Network Filtering', () => {
    it('resolves on mainnet network', () => {
        const result = resolvePair('XRP/RLUSD', { network: 'mainnet' });
        expect(result.executable).toBe(true);
        expect(result.network).toBe('mainnet');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatAmount
// ─────────────────────────────────────────────────────────────────────────────

describe('formatAmount', () => {
    let resolvedXrpRlusd: ResolvedPair;

    beforeEach(() => {
        resolvedXrpRlusd = resolvePair(xrpRlusd);
    });

    describe('XRP (drops)', () => {
        it('formats 1 XRP as 1000000 drops', () => {
            const result = formatAmount(resolvedXrpRlusd.base, 1);
            expect(result).toBe('1000000');
        });

        it('formats 10 XRP as 10000000 drops', () => {
            const result = formatAmount(resolvedXrpRlusd.base, 10);
            expect(result).toBe('10000000');
        });

        it('formats 0.001 XRP as 1000 drops', () => {
            const result = formatAmount(resolvedXrpRlusd.base, 0.001);
            expect(result).toBe('1000');
        });

        it('returns string type for XRP', () => {
            const result = formatAmount(resolvedXrpRlusd.base, 1);
            expect(typeof result).toBe('string');
        });
    });

    describe('Issued Currency', () => {
        it('formats RLUSD as object with currency, issuer, value', () => {
            const result = formatAmount(resolvedXrpRlusd.quote, 100) as { currency: string; issuer: string; value: string };
            expect(typeof result).toBe('object');
            expect(result.currency).toBe(resolvedXrpRlusd.quote.xrplCurrency);
            expect(result.issuer).toBe(RLUSD_ISSUER);
            expect(result.value).toBe('100');
        });

        it('preserves decimal precision', () => {
            const result = formatAmount(resolvedXrpRlusd.quote, 1.5) as { currency: string; issuer: string; value: string };
            expect(result.value).toBe('1.5');
        });
    });

    describe('Error cases', () => {
        it('throws on zero', () => {
            expect(() => formatAmount(resolvedXrpRlusd.base, 0)).toThrow('positive finite');
        });

        it('throws on negative', () => {
            expect(() => formatAmount(resolvedXrpRlusd.base, -1)).toThrow('positive finite');
        });

        it('throws on NaN', () => {
            expect(() => formatAmount(resolvedXrpRlusd.base, NaN)).toThrow('positive finite');
        });

        it('throws on Infinity', () => {
            expect(() => formatAmount(resolvedXrpRlusd.base, Infinity)).toThrow('positive finite');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildOfferAmounts
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOfferAmounts', () => {
    let resolved: ResolvedPair;

    beforeEach(() => {
        resolved = resolvePair(xrpRlusd);
    });

    describe('BUY base (buy XRP, sell RLUSD)', () => {
        it('TakerGets = quote (RLUSD), TakerPays = base (XRP)', () => {
            const result = buildOfferAmounts(resolved, 'BUY', 10, 2.5);
            // TakerGets = quote amount = 10 * 2.5 = 25 RLUSD (issued object)
            expect(typeof result.TakerGets).toBe('object');
            const gets = result.TakerGets as { currency: string; issuer: string; value: string };
            expect(gets.issuer).toBe(RLUSD_ISSUER);
            expect(gets.value).toBe('25');

            // TakerPays = base amount = 10 XRP (drops string)
            expect(typeof result.TakerPays).toBe('string');
            expect(result.TakerPays).toBe('10000000'); // 10 XRP in drops
        });
    });

    describe('SELL base (sell XRP, buy RLUSD)', () => {
        it('TakerGets = base (XRP), TakerPays = quote (RLUSD)', () => {
            const result = buildOfferAmounts(resolved, 'SELL', 10, 2.5);
            // TakerGets = base amount = 10 XRP (drops string)
            expect(typeof result.TakerGets).toBe('string');
            expect(result.TakerGets).toBe('10000000');

            // TakerPays = quote amount = 10 * 2.5 = 25 RLUSD (issued object)
            expect(typeof result.TakerPays).toBe('object');
            const pays = result.TakerPays as { currency: string; issuer: string; value: string };
            expect(pays.issuer).toBe(RLUSD_ISSUER);
            expect(pays.value).toBe('25');
        });
    });

    describe('BUY/SELL symmetry', () => {
        it('BUY and SELL swap TakerGets and TakerPays', () => {
            const buy = buildOfferAmounts(resolved, 'BUY', 5, 2.0);
            const sell = buildOfferAmounts(resolved, 'SELL', 5, 2.0);

            // BUY.TakerGets (quote) === SELL.TakerPays (quote)
            expect(buy.TakerGets).toEqual(sell.TakerPays);
            // BUY.TakerPays (base) === SELL.TakerGets (base)
            expect(buy.TakerPays).toEqual(sell.TakerGets);
        });
    });

    describe('Error cases', () => {
        it('throws on zero baseAmount', () => {
            expect(() => buildOfferAmounts(resolved, 'BUY', 0, 1)).toThrow('positive finite');
        });

        it('throws on negative price', () => {
            expect(() => buildOfferAmounts(resolved, 'BUY', 1, -1)).toThrow('positive finite');
        });

        it('throws on non-executable pair', () => {
            const nonExec: ResolvedPair = {
                ...resolved,
                executable: false,
                blockReason: 'test-block',
            };
            expect(() => buildOfferAmounts(nonExec, 'BUY', 1, 1)).toThrow('non-executable');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractPrimaryIssuer
// ─────────────────────────────────────────────────────────────────────────────

describe('extractPrimaryIssuer', () => {
    it('returns quote issuer for XRP/RLUSD', () => {
        const resolved = resolvePair(xrpRlusd);
        const issuer = extractPrimaryIssuer(resolved);
        expect(issuer).toBe(RLUSD_ISSUER);
    });

    it('returns undefined for XRP/XRP (hypothetical)', () => {
        // Build a synthetic resolved pair with both legs XRP
        const synth: ResolvedPair = {
            pairKey: 'XRP/FAKE',
            base: { currency: 'XRP', xrplCurrency: 'XRP', issuer: undefined, isXRP: true, xrplCurrencyObj: { currency: 'XRP' }, source: null, tier: null },
            quote: { currency: 'FAKE', xrplCurrency: 'FAKE', issuer: undefined, isXRP: false, xrplCurrencyObj: { currency: 'FAKE' } as any, source: null, tier: null },
            confidence: 0,
            executable: false,
            blockReason: 'test',
            routingTrace: [],
            resolvedAtMs: Date.now(),
            network: undefined,
        };
        expect(extractPrimaryIssuer(synth)).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractIssuerSet
// ─────────────────────────────────────────────────────────────────────────────

describe('extractIssuerSet', () => {
    it('returns set with quote issuer for XRP/RLUSD', () => {
        const resolved = resolvePair(xrpRlusd);
        const set = extractIssuerSet(resolved);
        expect(set.has(RLUSD_ISSUER)).toBe(true);
        expect(set.size).toBe(1);
    });

    it('returns empty set when both legs are XRP-like (no issuers)', () => {
        const synth: ResolvedPair = {
            pairKey: 'XRP/XRP2',
            base: { currency: 'XRP', xrplCurrency: 'XRP', issuer: undefined, isXRP: true, xrplCurrencyObj: { currency: 'XRP' }, source: null, tier: null },
            quote: { currency: 'XRP2', xrplCurrency: 'XRP2', issuer: undefined, isXRP: false, xrplCurrencyObj: { currency: 'XRP2' } as any, source: null, tier: null },
            confidence: 0,
            executable: false,
            blockReason: 'test',
            routingTrace: [],
            resolvedAtMs: Date.now(),
            network: undefined,
        };
        const set = extractIssuerSet(synth);
        expect(set.size).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// legToXrplCurrency
// ─────────────────────────────────────────────────────────────────────────────

describe('legToXrplCurrency', () => {
    it('returns { currency: "XRP" } for XRP leg', () => {
        const resolved = resolvePair(xrpRlusd);
        const xrplCurrency = legToXrplCurrency(resolved.base);
        expect(xrplCurrency).toEqual({ currency: 'XRP' });
    });

    it('returns { currency, issuer } for issued leg', () => {
        const resolved = resolvePair(xrpRlusd);
        const xrplCurrency = legToXrplCurrency(resolved.quote);
        expect(xrplCurrency).toHaveProperty('currency');
        expect(xrplCurrency).toHaveProperty('issuer');
        expect((xrplCurrency as any).issuer).toBe(RLUSD_ISSUER);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveToNormalizedPair — Bridge to legacy offerBuilder
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveToNormalizedPair', () => {
    it('returns base/quote/symbol matching offerBuilder shape', () => {
        const result = resolveToNormalizedPair(xrpRlusd);
        expect(result.base).toEqual({ currency: 'XRP' });
        expect(result.quote).toHaveProperty('currency');
        expect(result.quote).toHaveProperty('issuer');
        expect((result.quote as any).issuer).toBe(RLUSD_ISSUER);
        expect(result.symbol).toContain('/');
    });

    it('inverts legs when invert=true', () => {
        const normal = resolveToNormalizedPair(xrpRlusd);
        const inverted = resolveToNormalizedPair(xrpRlusd, { invert: true });

        // Inverted: base becomes quote, quote becomes base
        expect(inverted.base).toEqual(normal.quote);
        expect(inverted.quote).toEqual(normal.base);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveIssuerForRisk
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveIssuerForRisk', () => {
    it('returns RLUSD issuer for XRP/RLUSD', () => {
        const issuer = resolveIssuerForRisk(xrpRlusd);
        expect(issuer).toBe(RLUSD_ISSUER);
    });

    it('returns USDC issuer for XRP/USDC', () => {
        const issuer = resolveIssuerForRisk(xrpUsdc);
        expect(issuer).toBe(USDC_ISSUER);
    });

    it('returns undefined for unresolvable pair', () => {
        const pair: TradingPair = {
            baseCurrency: 'XRP',
            quoteCurrency: 'FAKECOIN',
        };
        const issuer = resolveIssuerForRisk(pair);
        expect(issuer).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveLegsForApi
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveLegsForApi', () => {
    it('returns both legs as XrplCurrency objects', () => {
        const result = resolveLegsForApi(xrpRlusd);
        expect(result.base).toEqual({ currency: 'XRP' });
        expect(result.quote).toHaveProperty('issuer');
    });

    it('returns EUR as 3-char code (no hex)', () => {
        const result = resolveLegsForApi(xrpEur);
        expect(result.quote).toHaveProperty('currency');
        expect((result.quote as any).currency).toBe('EUR');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateResolvedPair
// ─────────────────────────────────────────────────────────────────────────────

describe('validateResolvedPair', () => {
    it('valid for well-formed XRP/RLUSD', () => {
        const resolved = resolvePair(xrpRlusd);
        const validation = validateResolvedPair(resolved);
        expect(validation.valid).toBe(true);
        expect(validation.reasons).toHaveLength(0);
    });

    it('invalid for non-executable pair', () => {
        const resolved: ResolvedPair = {
            pairKey: 'XRP/FAKE',
            base: { currency: 'XRP', xrplCurrency: 'XRP', issuer: undefined, isXRP: true, xrplCurrencyObj: { currency: 'XRP' }, source: null, tier: null },
            quote: { currency: 'FAKE', xrplCurrency: 'FAKE', issuer: undefined, isXRP: false, xrplCurrencyObj: { currency: 'FAKE' } as any, source: null, tier: null },
            confidence: 0,
            executable: false,
            blockReason: 'test-block',
            routingTrace: [],
            resolvedAtMs: Date.now(),
            network: undefined,
        };
        const validation = validateResolvedPair(resolved);
        expect(validation.valid).toBe(false);
        expect(validation.reasons).toContain('not-executable: test-block');
        expect(validation.reasons).toContain('quote-missing-issuer');
    });

    it('detects NaN confidence', () => {
        const resolved = resolvePair(xrpRlusd);
        const modified = { ...resolved, confidence: NaN };
        const validation = validateResolvedPair(modified);
        expect(validation.valid).toBe(false);
        expect(validation.reasons).toContain('invalid-confidence');
    });

    it('detects pair key mismatch', () => {
        const resolved = resolvePair(xrpRlusd);
        const modified = { ...resolved, pairKey: 'WRONG/KEY' };
        const validation = validateResolvedPair(modified);
        expect(validation.valid).toBe(false);
        expect(validation.reasons.some(r => r.startsWith('pair-key-mismatch'))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertResolvedPairValid
// ─────────────────────────────────────────────────────────────────────────────

describe('assertResolvedPairValid', () => {
    it('does not throw for valid pair', () => {
        const resolved = resolvePair(xrpRlusd);
        expect(() => assertResolvedPairValid(resolved)).not.toThrow();
    });

    it('throws for invalid pair with details', () => {
        const resolved = resolvePair(xrpRlusd);
        const modified = { ...resolved, confidence: NaN };
        expect(() => assertResolvedPairValid(modified)).toThrow('invalid-confidence');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionPairResolver (stateful class)
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionPairResolver', () => {
    let resolver: ExecutionPairResolver;

    beforeEach(() => {
        resolver = new ExecutionPairResolver({ cacheTtlMs: 5_000 });
    });

    afterEach(() => {
        resolver.reset();
    });

    it('resolves XRP/RLUSD', () => {
        const result = resolver.resolve(xrpRlusd);
        expect(result.executable).toBe(true);
        expect(result.pairKey).toBe('XRP/RLUSD');
    });

    it('resolves from pair key string', () => {
        const result = resolver.resolve('XRP/RLUSD');
        expect(result.executable).toBe(true);
    });

    it('caches resolved pair', () => {
        const first = resolver.resolve('XRP/RLUSD');
        const second = resolver.resolve('XRP/RLUSD');
        // Same reference (cached)
        expect(first).toBe(second);
    });

    it('returns different references after cache invalidation', () => {
        const first = resolver.resolve('XRP/RLUSD');
        resolver.invalidate('XRP/RLUSD');
        const second = resolver.resolve('XRP/RLUSD');
        expect(first).not.toBe(second);
    });

    it('invalidate() with no arg clears all', () => {
        resolver.resolve('XRP/RLUSD');
        resolver.resolve('XRP/USDC');
        expect(resolver.getCacheSize()).toBe(2);
        resolver.invalidate();
        expect(resolver.getCacheSize()).toBe(0);
    });

    it('reset() clears cache', () => {
        resolver.resolve('XRP/RLUSD');
        expect(resolver.getCacheSize()).toBe(1);
        resolver.reset();
        expect(resolver.getCacheSize()).toBe(0);
    });

    it('resolveAndBuildOffer returns both resolved and offer', () => {
        const { resolved, offer } = resolver.resolveAndBuildOffer('XRP/RLUSD', 'BUY', 10, 2.5);
        expect(resolved.executable).toBe(true);
        expect(offer).toHaveProperty('TakerGets');
        expect(offer).toHaveProperty('TakerPays');
    });

    it('getPrimaryIssuer returns quote issuer', () => {
        const issuer = resolver.getPrimaryIssuer('XRP/RLUSD');
        expect(issuer).toBe(RLUSD_ISSUER);
    });

    it('getIssuerSet returns set with issuers', () => {
        const set = resolver.getIssuerSet('XRP/RLUSD');
        expect(set.has(RLUSD_ISSUER)).toBe(true);
    });

    it('getConfig returns config copy', () => {
        const config = resolver.getConfig();
        expect(config.cacheTtlMs).toBe(5_000);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionPairResolver — Cache Expiry
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionPairResolver — Cache Expiry', () => {
    it('returns fresh result after TTL expires', () => {
        vi.useFakeTimers();
        try {
            const resolver = new ExecutionPairResolver({ cacheTtlMs: 100 });
            const first = resolver.resolve('XRP/RLUSD');

            // Advance past TTL
            vi.advanceTimersByTime(150);

            const second = resolver.resolve('XRP/RLUSD');
            expect(first).not.toBe(second);

            resolver.reset();
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns cached result before TTL expires', () => {
        vi.useFakeTimers();
        try {
            const resolver = new ExecutionPairResolver({ cacheTtlMs: 1000 });
            const first = resolver.resolve('XRP/RLUSD');

            vi.advanceTimersByTime(500);

            const second = resolver.resolve('XRP/RLUSD');
            expect(first).toBe(second);

            resolver.reset();
        } finally {
            vi.useRealTimers();
        }
    });

    it('no caching when cacheTtlMs=0', () => {
        const resolver = new ExecutionPairResolver({ cacheTtlMs: 0 });
        const first = resolver.resolve('XRP/RLUSD');
        const second = resolver.resolve('XRP/RLUSD');
        expect(first).not.toBe(second);
        expect(resolver.getCacheSize()).toBe(0);
        resolver.reset();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// All Registered Pairs Resolve
// ─────────────────────────────────────────────────────────────────────────────

describe('All Registered Pairs', () => {
    const pairs = ['XRP/RLUSD', 'XRP/USDC', 'XRP/EUR', 'XRP/BTC', 'XRP/ETH'];

    for (const pairKey of pairs) {
        it(`resolves ${pairKey} from key string`, () => {
            const result = resolvePair(pairKey);
            expect(result.executable).toBe(true);
            expect(result.pairKey).toBe(pairKey);
            expect(result.base.isXRP).toBe(true);
            expect(result.quote.isXRP).toBe(false);
            expect(result.quote.issuer).toBeDefined();
            expect(result.confidence).toBeGreaterThan(0);
        });
    }

    for (const pairKey of pairs) {
        it(`validates ${pairKey} after resolution`, () => {
            const result = resolvePair(pairKey);
            const validation = validateResolvedPair(result);
            expect(validation.valid).toBe(true);
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Offer Construction End-to-End
// ─────────────────────────────────────────────────────────────────────────────

describe('Offer Construction E2E', () => {
    it('XRP/RLUSD BUY 100 XRP at 2.5 produces correct TakerGets/TakerPays', () => {
        const resolved = resolvePair('XRP/RLUSD');
        const offer = buildOfferAmounts(resolved, 'BUY', 100, 2.5);

        // TakerPays = 100 XRP = 100000000 drops
        expect(offer.TakerPays).toBe('100000000');

        // TakerGets = 250 RLUSD
        const gets = offer.TakerGets as { currency: string; issuer: string; value: string };
        expect(gets.value).toBe('250');
        expect(gets.issuer).toBe(RLUSD_ISSUER);
    });

    it('XRP/EUR SELL 50 XRP at 1.8 produces correct TakerGets/TakerPays', () => {
        const resolved = resolvePair('XRP/EUR');
        const offer = buildOfferAmounts(resolved, 'SELL', 50, 1.8);

        // TakerGets = 50 XRP = 50000000 drops
        expect(offer.TakerGets).toBe('50000000');

        // TakerPays = 90 EUR
        const pays = offer.TakerPays as { currency: string; issuer: string; value: string };
        expect(pays.value).toBe('90');
        expect(pays.currency).toBe('EUR'); // 3-char, no hex
        expect(pays.issuer).toBe(EUR_ISSUER);
    });

    it('XRP/BTC BUY 1000 XRP at 0.00004 produces correct tiny quote amount', () => {
        const resolved = resolvePair('XRP/BTC');
        const offer = buildOfferAmounts(resolved, 'BUY', 1000, 0.00004);

        // TakerGets = 1000 * 0.00004 = 0.04 BTC
        const gets = offer.TakerGets as { currency: string; issuer: string; value: string };
        expect(parseFloat(gets.value)).toBeCloseTo(0.04);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadExecutionPairResolverConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('loadExecutionPairResolverConfig', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('loads network from XRPL_NETWORK', () => {
        process.env.XRPL_NETWORK = 'testnet';
        const config = loadExecutionPairResolverConfig();
        expect(config.network).toBe('testnet');
    });

    it('loads cache TTL', () => {
        process.env.PAIR_RESOLVER_CACHE_TTL_MS = '10000';
        const config = loadExecutionPairResolverConfig();
        expect(config.cacheTtlMs).toBe(10000);
    });

    it('loads failOnUnresolvable=false', () => {
        process.env.PAIR_RESOLVER_FAIL_ON_UNRESOLVABLE = 'false';
        const config = loadExecutionPairResolverConfig();
        expect(config.failOnUnresolvable).toBe(false);
    });

    it('returns empty for unset env vars', () => {
        delete process.env.XRPL_NETWORK;
        delete process.env.PAIR_RESOLVER_CACHE_TTL_MS;
        delete process.env.PAIR_RESOLVER_FAIL_ON_UNRESOLVABLE;
        const config = loadExecutionPairResolverConfig();
        expect(config.network).toBeUndefined();
        expect(config.cacheTtlMs).toBeUndefined();
        expect(config.failOnUnresolvable).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hex Encoding for Non-Standard Currencies
// ─────────────────────────────────────────────────────────────────────────────

describe('Hex Encoding', () => {
    it('RLUSD is hex-encoded (40 chars)', () => {
        const resolved = resolvePair(xrpRlusd);
        expect(resolved.quote.xrplCurrency).toHaveLength(40);
        // Should be the hex of "RLUSD" padded to 40 chars
        expect(resolved.quote.xrplCurrency).toMatch(/^[0-9A-F]{40}$/);
    });

    it('EUR is NOT hex-encoded (3 chars)', () => {
        const resolved = resolvePair(xrpEur);
        expect(resolved.quote.xrplCurrency).toBe('EUR');
        expect(resolved.quote.xrplCurrency).toHaveLength(3);
    });

    it('BTC is NOT hex-encoded (3 chars)', () => {
        const resolved = resolvePair(xrpBtc);
        expect(resolved.quote.xrplCurrency).toBe('BTC');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Replaces Legacy Cascade
// ─────────────────────────────────────────────────────────────────────────────

describe('Replaces Legacy Cascade', () => {
    it('resolves same issuer as legacy cascade for XRP/RLUSD', () => {
        // Legacy: pair.quoteIssuer || pair.baseIssuer || pair.issuer
        const legacyResult = xrpRlusd.quoteIssuer || (xrpRlusd as any).baseIssuer || xrpRlusd.issuer;

        // New: resolver
        const resolved = resolvePair(xrpRlusd);
        const resolverResult = extractPrimaryIssuer(resolved);

        expect(resolverResult).toBe(legacyResult);
    });

    it('resolves same issuer as legacy cascade for pair with only legacy issuer', () => {
        // Legacy: pair.quoteIssuer || pair.baseIssuer || pair.issuer
        const legacyResult = (xrpRlusdLegacyOnly as any).quoteIssuer || (xrpRlusdLegacyOnly as any).baseIssuer || xrpRlusdLegacyOnly.issuer;

        // New: resolver
        const resolved = resolvePair(xrpRlusdLegacyOnly);
        const resolverResult = extractPrimaryIssuer(resolved);

        expect(resolverResult).toBe(legacyResult);
    });

    it('resolves same issuer for all explicitly configured pairs', () => {
        const pairs = [xrpRlusdExplicit, xrpUsdc, xrpEur, xrpBtc];
        for (const pair of pairs) {
            const legacy = pair.quoteIssuer || pair.baseIssuer || pair.issuer;
            const resolved = resolvePair(pair);
            const resolverResult = extractPrimaryIssuer(resolved);
            expect(resolverResult).toBe(legacy);
        }
    });
});
