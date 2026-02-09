/**
 * Trading Pairs Configuration Tests
 * 
 * Tests for the shared trading pairs module validation and helpers.
 */

import { describe, it, expect } from 'vitest';
import {
    TRADING_PAIRS,
    TradingPair,
    tradingPairSchema,
    currencySideSchema,
    getPair,
    findPair,
    listPairs,
    isValidPairKey,
    assertValidPair,
    validateAllPairs,
    toLegacyPair,
    fromLegacyPair,
} from '../tradingPairs';

describe('TRADING_PAIRS', () => {
    it('should have exactly 2 pairs', () => {
        expect(TRADING_PAIRS).toHaveLength(2);
    });

    it('should have unique keys', () => {
        const keys = TRADING_PAIRS.map((p) => p.key);
        const uniqueKeys = new Set(keys);
        expect(uniqueKeys.size).toBe(keys.length);
    });

    it('should have all required pairs', () => {
        const expectedKeys = [
            'XRP/RLUSD',
            'XRP/USDT',
        ];
        expectedKeys.forEach((key) => {
            expect(TRADING_PAIRS.some((p) => p.key === key)).toBe(true);
        });
    });

    it('should be frozen (immutable)', () => {
        expect(Object.isFrozen(TRADING_PAIRS)).toBe(true);
    });
});

describe('Zod Schema Validation', () => {
    describe('currencySideSchema', () => {
        it('should accept XRP without issuer', () => {
            const result = currencySideSchema.safeParse({ currency: 'XRP' });
            expect(result.success).toBe(true);
        });

        it('should reject XRP with issuer', () => {
            const result = currencySideSchema.safeParse({
                currency: 'XRP',
                issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
            });
            expect(result.success).toBe(false);
        });

        it('should require issuer for non-XRP currencies', () => {
            const result = currencySideSchema.safeParse({ currency: 'USD' });
            expect(result.success).toBe(false);
        });

        it('should accept valid issuer for non-XRP currencies', () => {
            const result = currencySideSchema.safeParse({
                currency: 'USD',
                issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
            });
            expect(result.success).toBe(true);
        });

        it('should reject invalid issuer address', () => {
            const result = currencySideSchema.safeParse({
                currency: 'USD',
                issuer: 'invalid-address',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('tradingPairSchema', () => {
        it('should accept valid trading pair', () => {
            const pair: TradingPair = {
                key: 'XRP/USD',
                base: { currency: 'XRP' },
                quote: { currency: 'USD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
                description: 'XRP/USD',
                liquidity: 'high',
                network: 'mainnet',
            };
            const result = tradingPairSchema.safeParse(pair);
            expect(result.success).toBe(true);
        });

        it('should reject same base and quote currency', () => {
            const pair = {
                key: 'XRP/XRP',
                base: { currency: 'XRP' },
                quote: { currency: 'XRP' },
                description: 'XRP/XRP',
                liquidity: 'high',
                network: 'mainnet',
            };
            const result = tradingPairSchema.safeParse(pair);
            expect(result.success).toBe(false);
        });
    });
});

describe('Helper Functions', () => {
    describe('getPair', () => {
        it('should return pair for valid key', () => {
            const pair = getPair('XRP/RLUSD');
            expect(pair).toBeDefined();
            expect(pair.key).toBe('XRP/RLUSD');
        });

        it('should throw for invalid key', () => {
            expect(() => getPair('INVALID/PAIR')).toThrow('Unknown trading pair');
        });
    });

    describe('findPair', () => {
        it('should return pair for valid key', () => {
            const pair = findPair('XRP/USDT');
            expect(pair).toBeDefined();
            expect(pair?.key).toBe('XRP/USDT');
        });

        it('should return undefined for invalid key', () => {
            const pair = findPair('INVALID/PAIR');
            expect(pair).toBeUndefined();
        });
    });

    describe('listPairs', () => {
        it('should return all pairs when no filter', () => {
            const pairs = listPairs();
            expect(pairs.length).toBe(TRADING_PAIRS.length);
        });

        it('should return all pairs for mainnet', () => {
            const pairs = listPairs({ network: 'mainnet' });
            expect(pairs.every((p) => p.network === 'mainnet')).toBe(true);
        });

        it('should return all pairs for testnet (dev mode)', () => {
            const pairs = listPairs({ network: 'testnet' });
            // All pairs available on testnet for development
            expect(pairs.length).toBe(TRADING_PAIRS.length);
        });
    });

    describe('isValidPairKey', () => {
        it('should return true for valid keys', () => {
            expect(isValidPairKey('XRP/RLUSD')).toBe(true);
            expect(isValidPairKey('XRP/USDT')).toBe(true);
        });

        it('should return false for invalid keys', () => {
            expect(isValidPairKey('INVALID/PAIR')).toBe(false);
            expect(isValidPairKey('')).toBe(false);
            expect(isValidPairKey('XRP')).toBe(false);
        });
    });

    describe('assertValidPair', () => {
        it('should not throw for valid pair', () => {
            const pair = TRADING_PAIRS[0];
            expect(() => assertValidPair(pair)).not.toThrow();
        });

        it('should throw for invalid pair', () => {
            const invalidPair = {
                key: 'BAD',
                base: { currency: 'XRP' },
                quote: { currency: 'XRP' }, // Same as base
                description: 'Bad pair',
                liquidity: 'high',
                network: 'mainnet',
            };
            expect(() => assertValidPair(invalidPair)).toThrow();
        });
    });

    describe('validateAllPairs', () => {
        it('should not throw for TRADING_PAIRS', () => {
            expect(() => validateAllPairs()).not.toThrow();
        });
    });
});

describe('Legacy Format Conversion', () => {
    describe('toLegacyPair', () => {
        it('should convert XRP base pair correctly', () => {
            const pair = getPair('XRP/RLUSD');
            const legacy = toLegacyPair(pair);

            expect(legacy.baseCurrency).toBe('XRP');
            expect(legacy.baseIssuer).toBeUndefined();
            expect(legacy.quoteCurrency).toBe('RLUSD');
            expect(legacy.quoteIssuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
            expect(legacy.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
        });

        it('should convert non-XRP base pair correctly', () => {
            // Test with a legacy pair format (no longer in TRADING_PAIRS but testing the conversion function)
            const legacyInput = {
                baseCurrency: 'RLUSD',
                baseIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                quoteCurrency: 'USD',
                quoteIssuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq',
            };
            const pair = fromLegacyPair(legacyInput);
            const legacy = toLegacyPair(pair);

            expect(legacy.baseCurrency).toBe('RLUSD');
            expect(legacy.baseIssuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
            expect(legacy.quoteCurrency).toBe('USD');
            expect(legacy.quoteIssuer).toBe('rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq');
        });
    });

    describe('fromLegacyPair', () => {
        it('should convert legacy pair to new format', () => {
            const legacy = {
                baseCurrency: 'XRP',
                quoteCurrency: 'USD',
                quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
            };
            const pair = fromLegacyPair(legacy);

            expect(pair.key).toBe('XRP/USD');
            expect(pair.base.currency).toBe('XRP');
            expect(pair.base.issuer).toBeUndefined();
            expect(pair.quote.currency).toBe('USD');
            expect(pair.quote.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
        });

        it('should handle legacy issuer fallback', () => {
            const legacy = {
                baseCurrency: 'XRP',
                quoteCurrency: 'USD',
                issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', // Legacy single issuer
            };
            const pair = fromLegacyPair(legacy);

            expect(pair.quote.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
        });
    });

    it('should roundtrip toLegacy -> fromLegacy', () => {
        const original = getPair('XRP/USDT');
        const legacy = toLegacyPair(original);
        const restored = fromLegacyPair(legacy);

        expect(restored.base.currency).toBe(original.base.currency);
        expect(restored.quote.currency).toBe(original.quote.currency);
        expect(restored.quote.issuer).toBe(original.quote.issuer);
    });
});

describe('Pair Configuration Integrity', () => {
    it('all XRP base pairs should have no base issuer', () => {
        const xrpBasePairs = TRADING_PAIRS.filter((p) => p.base.currency === 'XRP');
        xrpBasePairs.forEach((pair) => {
            expect(pair.base.issuer).toBeUndefined();
        });
    });

    it('all non-XRP currencies should have valid issuers', () => {
        TRADING_PAIRS.forEach((pair) => {
            if (pair.base.currency !== 'XRP') {
                expect(pair.base.issuer).toBeDefined();
                expect(pair.base.issuer).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
            }
            if (pair.quote.currency !== 'XRP') {
                expect(pair.quote.issuer).toBeDefined();
                expect(pair.quote.issuer).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
            }
        });
    });

    it('all pairs should be on mainnet', () => {
        TRADING_PAIRS.forEach((pair) => {
            expect(pair.network).toBe('mainnet');
        });
    });
});
