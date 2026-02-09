/**
 * Instrument Registry — Comprehensive Test Suite
 *
 * Tests the SQLite-backed registry, CRUD operations, seed data,
 * backward compatibility, and structural validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers — use temp DB per test to avoid singleton interference
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inst-reg-test-'));
    process.env.INSTRUMENT_DB_PATH = join(tmpDir, 'test-instruments.sqlite');
});

afterEach(async () => {
    // Reset the singleton to avoid cross-test pollution
    const { resetRegistry } = await import('../registry');
    resetRegistry();
    delete process.env.INSTRUMENT_DB_PATH;

    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        // Best-effort cleanup
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema / Types
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema Types', () => {
    it('SEED_INSTRUMENTS should have exactly 2 instruments', async () => {
        const { SEED_INSTRUMENTS } = await import('../schema');
        expect(SEED_INSTRUMENTS).toHaveLength(2);
    });

    it('SEED_ISSUERS should have exactly 2 issuers', async () => {
        const { SEED_ISSUERS } = await import('../schema');
        expect(SEED_ISSUERS).toHaveLength(2);
    });

    it('seed instruments should have expected keys', async () => {
        const { SEED_INSTRUMENTS } = await import('../schema');
        const keys = SEED_INSTRUMENTS.map((i) => i.key);
        expect(keys).toContain('XRP/RLUSD');
        expect(keys).toContain('XRP/USDT');
    });

    it('seed instruments should be frozen', async () => {
        const { SEED_INSTRUMENTS } = await import('../schema');
        expect(Object.isFrozen(SEED_INSTRUMENTS)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversion Helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('toLegacyPair', () => {
    it('should convert XRP base pair correctly', async () => {
        const { SEED_INSTRUMENTS, toLegacyPair } = await import('../schema');
        const rlusd = SEED_INSTRUMENTS.find((i) => i.key === 'XRP/RLUSD')!;
        const legacy = toLegacyPair(rlusd);

        expect(legacy.baseCurrency).toBe('XRP');
        expect(legacy.baseIssuer).toBeUndefined();
        expect(legacy.quoteCurrency).toBe('RLUSD');
        expect(legacy.quoteIssuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
        expect(legacy.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    });
});

describe('fromLegacyPair', () => {
    it('should convert legacy pair to Instrument', async () => {
        const { fromLegacyPair } = await import('../schema');
        const legacy = {
            baseCurrency: 'XRP',
            quoteCurrency: 'USD',
            quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        };
        const inst = fromLegacyPair(legacy);

        expect(inst.key).toBe('XRP/USD');
        expect(inst.base.currency).toBe('XRP');
        expect(inst.base.issuer).toBeUndefined();
        expect(inst.quote.currency).toBe('USD');
        expect(inst.quote.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    });

    it('should handle legacy issuer fallback', async () => {
        const { fromLegacyPair } = await import('../schema');
        const legacy = {
            baseCurrency: 'XRP',
            quoteCurrency: 'USD',
            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        };
        const inst = fromLegacyPair(legacy);
        expect(inst.quote.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    });

    it('should roundtrip toLegacy → fromLegacy', async () => {
        const { SEED_INSTRUMENTS, toLegacyPair, fromLegacyPair } = await import('../schema');
        const original = SEED_INSTRUMENTS.find((i) => i.key === 'XRP/USDT')!;
        const legacy = toLegacyPair(original);
        const restored = fromLegacyPair(legacy);

        expect(restored.base.currency).toBe(original.base.currency);
        expect(restored.quote.currency).toBe(original.quote.currency);
        expect(restored.quote.issuer).toBe(original.quote.issuer);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Database Layer
// ─────────────────────────────────────────────────────────────────────────────

describe('Database Layer', () => {
    it('should auto-seed instruments on first access', async () => {
        const { getRegistryDb } = await import('../db');
        const db = getRegistryDb();
        const count = (db.prepare('SELECT COUNT(*) as count FROM instruments').get() as { count: number }).count;
        expect(count).toBe(2);
    });

    it('should auto-seed issuers on first access', async () => {
        const { getRegistryDb } = await import('../db');
        const db = getRegistryDb();
        const count = (db.prepare('SELECT COUNT(*) as count FROM issuers').get() as { count: number }).count;
        expect(count).toBe(2);
    });

    it('should use WAL journal mode', async () => {
        const { getRegistryDb } = await import('../db');
        const db = getRegistryDb();
        const mode = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
        expect(mode[0]?.journal_mode).toBe('wal');
    });

    it('should not re-seed when data already exists', async () => {
        const { getRegistryDb, resetRegistryDb, dbListInstruments } = await import('../db');
        // First access: seeds
        getRegistryDb();
        expect(dbListInstruments()).toHaveLength(2);

        // Reset and reopen — should not duplicate
        resetRegistryDb();
        getRegistryDb();
        expect(dbListInstruments()).toHaveLength(2);
    });
});

describe('Instrument CRUD', () => {
    it('should get instrument by key', async () => {
        const { getRegistryDb, dbGetInstrument } = await import('../db');
        getRegistryDb();
        const inst = dbGetInstrument('XRP/RLUSD');
        expect(inst).not.toBeNull();
        expect(inst!.key).toBe('XRP/RLUSD');
        expect(inst!.base.currency).toBe('XRP');
        expect(inst!.quote.currency).toBe('RLUSD');
        expect(inst!.quote.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    });

    it('should return null for missing instrument', async () => {
        const { getRegistryDb, dbGetInstrument } = await import('../db');
        getRegistryDb();
        const inst = dbGetInstrument('MISSING/PAIR');
        expect(inst).toBeNull();
    });

    it('should list all instruments sorted by sortOrder', async () => {
        const { getRegistryDb, dbListInstruments } = await import('../db');
        getRegistryDb();
        const instruments = dbListInstruments();
        expect(instruments).toHaveLength(2);
        // First should be XRP/RLUSD (sortOrder=1)
        expect(instruments[0]!.key).toBe('XRP/RLUSD');
        expect(instruments[1]!.key).toBe('XRP/USDT');
    });

    it('should list active instruments only', async () => {
        const { getRegistryDb, dbListInstruments, dbUpdateInstrumentStatus } = await import('../db');
        getRegistryDb();

        // Disable one
        dbUpdateInstrumentStatus('XRP/USDT', 'disabled');

        const active = dbListInstruments({ activeOnly: true });
        expect(active).toHaveLength(1);
        expect(active.find((i) => i.key === 'XRP/USDT')).toBeUndefined();
    });

    it('should list by network', async () => {
        const { getRegistryDb, dbListInstruments } = await import('../db');
        getRegistryDb();
        const mainnet = dbListInstruments({ network: 'mainnet' });
        expect(mainnet).toHaveLength(2);

        const testnet = dbListInstruments({ network: 'testnet' });
        expect(testnet).toHaveLength(0); // all pairs are mainnet
    });

    it('should upsert instrument', async () => {
        const { getRegistryDb, dbUpsertInstrument, dbGetInstrument } = await import('../db');
        getRegistryDb();

        const now = new Date().toISOString();
        dbUpsertInstrument({
            key: 'XRP/NZD',
            base: { currency: 'XRP' },
            quote: { currency: 'NZD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            description: 'XRP/NZD',
            liquidity: 'low',
            network: 'testnet',
            status: 'active',
            sortOrder: 10,
            createdAt: now,
            updatedAt: now,
        });

        const inst = dbGetInstrument('XRP/NZD');
        expect(inst).not.toBeNull();
        expect(inst!.quote.currency).toBe('NZD');
        expect(inst!.liquidity).toBe('low');
    });

    it('should update instrument status', async () => {
        const { getRegistryDb, dbUpdateInstrumentStatus, dbGetInstrument } = await import('../db');
        getRegistryDb();

        const ok = dbUpdateInstrumentStatus('XRP/USDT', 'disabled');
        expect(ok).toBe(true);

        const inst = dbGetInstrument('XRP/USDT');
        expect(inst!.status).toBe('disabled');
    });

    it('should update instrument liquidity', async () => {
        const { getRegistryDb, dbUpdateInstrumentLiquidity, dbGetInstrument } = await import('../db');
        getRegistryDb();

        const ok = dbUpdateInstrumentLiquidity('XRP/USDT', 'low');
        expect(ok).toBe(true);

        const inst = dbGetInstrument('XRP/USDT');
        expect(inst!.liquidity).toBe('low');
    });

    it('should delete instrument', async () => {
        const { getRegistryDb, dbDeleteInstrument, dbGetInstrument, dbListInstruments } = await import('../db');
        getRegistryDb();

        const ok = dbDeleteInstrument('XRP/USDT');
        expect(ok).toBe(true);
        expect(dbGetInstrument('XRP/USDT')).toBeNull();
        expect(dbListInstruments()).toHaveLength(1);
    });
});

describe('Issuer CRUD', () => {
    it('should get issuer by address+currency', async () => {
        const { getRegistryDb, dbGetIssuer } = await import('../db');
        getRegistryDb();

        const issuer = dbGetIssuer('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', 'RLUSD');
        expect(issuer).not.toBeNull();
        expect(issuer!.label).toBe('Ripple (RLUSD)');
        expect(issuer!.tier).toBe('tier1');
    });

    it('should list issuers by currency', async () => {
        const { getRegistryDb, dbListIssuers } = await import('../db');
        getRegistryDb();

        const rlusdIssuers = dbListIssuers({ currency: 'RLUSD' });
        expect(rlusdIssuers).toHaveLength(1);
    });

    it('should update issuer tier', async () => {
        const { getRegistryDb, dbUpdateIssuerTier, dbGetIssuer } = await import('../db');
        getRegistryDb();

        const ok = dbUpdateIssuerTier('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', 'RLUSD', 'tier2');
        expect(ok).toBe(true);

        const issuer = dbGetIssuer('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', 'RLUSD');
        expect(issuer!.tier).toBe('tier2');
    });

    it('should delete issuer', async () => {
        const { getRegistryDb, dbDeleteIssuer, dbGetIssuer } = await import('../db');
        getRegistryDb();

        const ok = dbDeleteIssuer('rcvxE9PS9YBwxtGg1qNeewV6ZB3wGubZq', 'USDT');
        expect(ok).toBe(true);
        expect(dbGetIssuer('rcvxE9PS9YBwxtGg1qNeewV6ZB3wGubZq', 'USDT')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry Public API
// ─────────────────────────────────────────────────────────────────────────────

describe('Registry API', () => {
    describe('getInstruments', () => {
        it('should return all instruments', async () => {
            const { getInstruments } = await import('../registry');
            const instruments = getInstruments();
            expect(instruments).toHaveLength(2);
        });

        it('should return same reference on repeated calls (cached)', async () => {
            const { getInstruments } = await import('../registry');
            const a = getInstruments();
            const b = getInstruments();
            expect(a).toBe(b);
        });
    });

    describe('findInstrument / getInstrument', () => {
        it('should find instrument by key', async () => {
            const { findInstrument } = await import('../registry');
            const inst = findInstrument('XRP/USDT');
            expect(inst).toBeDefined();
            expect(inst!.base.currency).toBe('XRP');
            expect(inst!.quote.currency).toBe('USDT');
        });

        it('should return undefined for missing key', async () => {
            const { findInstrument } = await import('../registry');
            expect(findInstrument('MISSING/PAIR')).toBeUndefined();
        });

        it('should throw for missing key (getInstrument)', async () => {
            const { getInstrument } = await import('../registry');
            expect(() => getInstrument('MISSING/PAIR')).toThrow('Unknown trading pair');
        });
    });

    describe('isValidPairKey', () => {
        it('should return true for valid keys', async () => {
            const { isValidPairKey } = await import('../registry');
            expect(isValidPairKey('XRP/RLUSD')).toBe(true);
            expect(isValidPairKey('XRP/USDT')).toBe(true);
        });

        it('should return false for invalid keys', async () => {
            const { isValidPairKey } = await import('../registry');
            expect(isValidPairKey('INVALID/PAIR')).toBe(false);
            expect(isValidPairKey('')).toBe(false);
        });
    });

    describe('listInstruments', () => {
        it('should return all when no filter', async () => {
            const { listInstruments } = await import('../registry');
            expect(listInstruments()).toHaveLength(2);
        });

        it('should filter by network', async () => {
            const { listInstruments } = await import('../registry');
            const mainnet = listInstruments({ network: 'mainnet', activeOnly: true });
            expect(mainnet.length).toBeGreaterThan(0);
            mainnet.forEach((i) => expect(i.network).toBe('mainnet'));
        });
    });

    describe('registerInstrument', () => {
        it('should add a new instrument', async () => {
            const { registerInstrument, findInstrument, getInstruments } = await import('../registry');
            const now = new Date().toISOString();
            registerInstrument({
                key: 'XRP/NZD',
                base: { currency: 'XRP' },
                quote: { currency: 'NZD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
                description: 'XRP/NZD',
                liquidity: 'low',
                network: 'testnet',
                status: 'active',
                sortOrder: 10,
                createdAt: now,
                updatedAt: now,
            });

            expect(findInstrument('XRP/NZD')).toBeDefined();
            expect(getInstruments().length).toBe(3);
        });

        it('should reject invalid instrument structure', async () => {
            const { registerInstrument } = await import('../registry');
            const now = new Date().toISOString();
            expect(() => registerInstrument({
                key: 'XRP/XRP',
                base: { currency: 'XRP' },
                quote: { currency: 'XRP' },
                description: 'Bad',
                liquidity: 'low',
                network: 'mainnet',
                status: 'active',
                sortOrder: 99,
                createdAt: now,
                updatedAt: now,
            })).toThrow('Base and quote currency must differ');
        });
    });

    describe('setInstrumentStatus', () => {
        it('should disable an instrument', async () => {
            const { setInstrumentStatus, findInstrument, getActiveInstruments } = await import('../registry');
            const ok = setInstrumentStatus('XRP/USDT', 'disabled');
            expect(ok).toBe(true);
            expect(findInstrument('XRP/USDT')!.status).toBe('disabled');
            expect(getActiveInstruments().find((i) => i.key === 'XRP/USDT')).toBeUndefined();
        });
    });

    describe('removeInstrument', () => {
        it('should remove an instrument', async () => {
            const { removeInstrument, findInstrument, getInstruments } = await import('../registry');
            const ok = removeInstrument('XRP/USDT');
            expect(ok).toBe(true);
            expect(findInstrument('XRP/USDT')).toBeUndefined();
            expect(getInstruments()).toHaveLength(1);
        });
    });

    describe('assertAllowedInstrument', () => {
        it('should not throw for active instrument', async () => {
            const { assertAllowedInstrument } = await import('../registry');
            expect(() => assertAllowedInstrument('XRP/RLUSD')).not.toThrow();
        });

        it('should throw for missing instrument', async () => {
            const { assertAllowedInstrument } = await import('../registry');
            expect(() => assertAllowedInstrument('MISSING/PAIR')).toThrow('not in the registry');
        });

        it('should throw for disabled instrument', async () => {
            const { assertAllowedInstrument, setInstrumentStatus } = await import('../registry');
            setInstrumentStatus('XRP/USDT', 'disabled');
            expect(() => assertAllowedInstrument('XRP/USDT')).toThrow('disabled');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issuer API
// ─────────────────────────────────────────────────────────────────────────────

describe('Issuer API', () => {
    it('should get active issuers for currency', async () => {
        const { getActiveIssuersForCurrency } = await import('../registry');
        const issuers = getActiveIssuersForCurrency('RLUSD');
        expect(issuers).toHaveLength(1);
        expect(issuers[0]!.address).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    });

    it('should register a new issuer', async () => {
        const { registerIssuer, getActiveIssuersForCurrency } = await import('../registry');
        const now = new Date().toISOString();
        // Use an existing valid address from seed data for a different currency
        registerIssuer({
            address: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq',
            label: 'GateHub (GBP)',
            currency: 'GBP',
            tier: 'tier2',
            network: 'mainnet',
            status: 'active',
            createdAt: now,
            updatedAt: now,
        });

        const issuers = getActiveIssuersForCurrency('GBP');
        expect(issuers).toHaveLength(1);
    });

    it('should reject invalid issuer address', async () => {
        const { registerIssuer } = await import('../registry');
        const now = new Date().toISOString();
        expect(() => registerIssuer({
            address: 'invalid',
            label: 'Bad',
            currency: 'BAD',
            tier: 'untrusted',
            network: 'mainnet',
            status: 'active',
            createdAt: now,
            updatedAt: now,
        })).toThrow('Invalid issuer address');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation', () => {
    it('should validate XRP must not have issuer', async () => {
        const { validateInstrumentStructure } = await import('../registry');
        const now = new Date().toISOString();
        expect(() => validateInstrumentStructure({
            key: 'XRP/USD',
            base: { currency: 'XRP', issuer: 'rSomeAddress1234567890' },
            quote: { currency: 'USD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            description: 'XRP/USD',
            liquidity: 'low',
            network: 'mainnet',
            status: 'active',
            sortOrder: 1,
            createdAt: now,
            updatedAt: now,
        })).toThrow('XRP must not have an issuer');
    });

    it('should validate key matches currencies', async () => {
        const { validateInstrumentStructure } = await import('../registry');
        const now = new Date().toISOString();
        expect(() => validateInstrumentStructure({
            key: 'WRONG/KEY',
            base: { currency: 'XRP' },
            quote: { currency: 'USD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            description: 'WRONG',
            liquidity: 'low',
            network: 'mainnet',
            status: 'active',
            sortOrder: 1,
            createdAt: now,
            updatedAt: now,
        })).toThrow('does not match currencies');
    });

    it('validateAllPairs should pass for seeded instruments', async () => {
        const { validateAllPairs } = await import('../registry');
        expect(() => validateAllPairs()).not.toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward Compat
// ─────────────────────────────────────────────────────────────────────────────

describe('Backward Compatibility', () => {
    it('findPair alias should work', async () => {
        const { findPair } = await import('../registry');
        const pair = findPair('XRP/USDT');
        expect(pair).toBeDefined();
        expect(pair!.key).toBe('XRP/USDT');
    });

    it('getPair alias should work', async () => {
        const { getPair } = await import('../registry');
        const pair = getPair('XRP/RLUSD');
        expect(pair.key).toBe('XRP/RLUSD');
    });

    it('getPair alias should throw for unknown', async () => {
        const { getPair } = await import('../registry');
        expect(() => getPair('MISSING')).toThrow();
    });

    it('listPairs should work', async () => {
        const { listPairs } = await import('../registry');
        const all = listPairs();
        expect(all.length).toBeGreaterThanOrEqual(2);
        const mainnet = listPairs({ network: 'mainnet' });
        expect(mainnet.length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('Lifecycle', () => {
    it('initRegistry is idempotent', async () => {
        const { initRegistry, getInstruments } = await import('../registry');
        initRegistry();
        initRegistry();
        initRegistry();
        expect(getInstruments()).toHaveLength(2);
    });

    it('closeRegistry then reopen works', async () => {
        const { initRegistry, closeRegistry, getInstruments } = await import('../registry');
        initRegistry();
        expect(getInstruments()).toHaveLength(2);
        closeRegistry();
        // Should lazily reopen
        expect(getInstruments()).toHaveLength(2);
    });
});
