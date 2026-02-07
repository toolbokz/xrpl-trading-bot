/**
 * Tests for src/market/trustlineGovernance.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    getTrustlineLimit,
    legNeedsTrustline,
    loadTrustlineGovernanceConfig,
    TrustlineGovernance,
    type TrustlineGovernanceConfig,
} from '../trustlineGovernance';
import type { ResolvedLeg, ResolvedPair } from '../executionPairResolver';
import type { TradingPair, RiskConfig } from '../../config';
import type { Client, Wallet } from 'xrpl';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the executionPairResolver
vi.mock('../executionPairResolver', () => ({
    resolvePair: vi.fn(),
    extractPrimaryIssuer: vi.fn(),
}));

// Mock the instrumentRegistry
vi.mock('../instrumentRegistry', () => ({
    findInstrument: vi.fn(),
}));

// Mock the trustlines module with a class-style mock
vi.mock('../../xrpl/trustlines', () => {
    return {
        TrustlineManager: class MockTrustlineManager {
            client: any;
            constructor(client: any, _risk: any, _paper: any) {
                this.client = client;
            }
            async ensure() { return true; }
            async remove() { return true; }
            async hasTrustline() { return false; }
        },
    };
});

// Mock the logger
vi.mock('../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { resolvePair } from '../executionPairResolver';
import { findInstrument } from '../instrumentRegistry';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResolvedLeg(overrides: Partial<ResolvedLeg> = {}): ResolvedLeg {
    return {
        currency: 'RLUSD',
        xrplCurrency: 'RLUSD',
        issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        isXRP: false,
        xrplCurrencyObj: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        source: 'registry',
        tier: 'tier1',
        ...overrides,
    };
}

function makeXrpLeg(): ResolvedLeg {
    return {
        currency: 'XRP',
        xrplCurrency: 'XRP',
        issuer: undefined,
        isXRP: true,
        xrplCurrencyObj: { currency: 'XRP' },
        source: null,
        tier: null,
    };
}

function makeResolvedPair(overrides: Partial<ResolvedPair> = {}): ResolvedPair {
    return {
        pairKey: 'XRP/RLUSD',
        base: makeXrpLeg(),
        quote: makeResolvedLeg(),
        confidence: 1,
        executable: true,
        blockReason: undefined,
        routingTrace: [],
        resolvedAtMs: Date.now(),
        network: 'mainnet',
        ...overrides,
    };
}

function makeRiskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
    return {
        maxExposurePerIssuer: 5000,
        maxTradeSize: 1000,
        maxDailyLoss: 500,
        consecutiveFailureKillSwitch: 5,
        issuerBlacklist: new Set<string>(),
        emergencyShutdown: false,
        reserveFloorXRP: 25,
        ...overrides,
    };
}

function makePair(overrides: Partial<TradingPair> = {}): TradingPair {
    return {
        baseCurrency: 'XRP',
        quoteCurrency: 'RLUSD',
        quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        ...overrides,
    };
}

function makeMockClient(): Client {
    return {
        request: vi.fn().mockResolvedValue({
            result: { lines: [] },
        }),
    } as unknown as Client;
}

// ─── Pure Function Tests ─────────────────────────────────────────────────────

describe('getTrustlineLimit', () => {
    it('returns tier1 limit for tier1', () => {
        expect(getTrustlineLimit('tier1')).toBe('1000000000');
    });

    it('returns tier2 limit for tier2', () => {
        expect(getTrustlineLimit('tier2')).toBe('100000000');
    });

    it('returns tier3 limit for tier3', () => {
        expect(getTrustlineLimit('tier3')).toBe('10000000');
    });

    it('returns untrusted limit for untrusted', () => {
        expect(getTrustlineLimit('untrusted')).toBe('1000000');
    });

    it('returns defaultLimit for null tier', () => {
        expect(getTrustlineLimit(null)).toBe('1000000');
    });

    it('respects custom config', () => {
        const config: TrustlineGovernanceConfig = {
            autoEnsure: true,
            tierLimits: {
                tier1: '999',
                tier2: '888',
                tier3: '777',
                untrusted: '666',
            },
            defaultLimit: '555',
            requireRegistered: false,
            resolverConfig: {},
        };
        expect(getTrustlineLimit('tier1', config)).toBe('999');
        expect(getTrustlineLimit(null, config)).toBe('555');
    });
});

describe('legNeedsTrustline', () => {
    it('returns false for XRP leg', () => {
        expect(legNeedsTrustline(makeXrpLeg())).toBe(false);
    });

    it('returns true for issued currency leg', () => {
        expect(legNeedsTrustline(makeResolvedLeg())).toBe(true);
    });

    it('returns false for issued currency leg without issuer', () => {
        expect(legNeedsTrustline(makeResolvedLeg({ issuer: undefined, isXRP: false }))).toBe(false);
    });
});

// ─── Governance Engine Tests ─────────────────────────────────────────────────

describe('TrustlineGovernance', () => {
    let governance: TrustlineGovernance;
    let mockClient: Client;
    let risk: RiskConfig;
    const mockResolvePair = resolvePair as ReturnType<typeof vi.fn>;
    const mockFindInstrument = findInstrument as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = makeMockClient();
        risk = makeRiskConfig();
        governance = new TrustlineGovernance(mockClient, risk, true);
    });

    describe('checkForPair', () => {
        it('returns BLOCK when pair is not executable', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair({
                executable: false,
                blockReason: 'no-issuer-found',
            }));

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('BLOCK');
            expect(result.blockReasons).toContain('pair-not-executable: no-issuer-found');
        });

        it('returns BLOCK when base issuer is blacklisted', async () => {
            risk = makeRiskConfig({
                issuerBlacklist: new Set(['rBlacklistedIssuer']),
            });
            governance = new TrustlineGovernance(mockClient, risk, true);

            mockResolvePair.mockReturnValue(makeResolvedPair({
                base: makeResolvedLeg({ currency: 'FOO', issuer: 'rBlacklistedIssuer', isXRP: false }),
                quote: makeXrpLeg(),
            }));

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('BLOCK');
            expect(result.blockReasons[0]).toContain('base-issuer-blacklisted');
        });

        it('returns BLOCK when quote issuer is blacklisted', async () => {
            risk = makeRiskConfig({
                issuerBlacklist: new Set(['rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De']),
            });
            governance = new TrustlineGovernance(mockClient, risk, true);

            mockResolvePair.mockReturnValue(makeResolvedPair());

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('BLOCK');
            expect(result.blockReasons[0]).toContain('quote-issuer-blacklisted');
        });

        it('returns BLOCK when requireRegistered and pair not in registry', async () => {
            governance = new TrustlineGovernance(mockClient, risk, true, {
                requireRegistered: true,
            });

            mockResolvePair.mockReturnValue(makeResolvedPair());
            mockFindInstrument.mockReturnValue(undefined);

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('BLOCK');
            expect(result.blockReasons).toContain('pair-not-registered');
        });

        it('returns SKIP when both legs are XRP', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair({
                base: makeXrpLeg(),
                quote: makeXrpLeg(),
            }));

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('SKIP');
            expect(result.baseNeeded).toBe(false);
            expect(result.quoteNeeded).toBe(false);
        });

        it('returns CREATE when trustline missing and autoEnsure is true', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair());

            // Mock: no existing trustlines
            (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValue({
                result: { lines: [] },
            });

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('CREATE');
            expect(result.quoteNeeded).toBe(true);
            expect(result.quoteExists).toBe(false);
        });

        it('returns BLOCK when trustline missing and autoEnsure is false', async () => {
            governance = new TrustlineGovernance(mockClient, risk, true, {
                autoEnsure: false,
            });

            mockResolvePair.mockReturnValue(makeResolvedPair());

            (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValue({
                result: { lines: [] },
            });

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('BLOCK');
            expect(result.blockReasons).toContain('quote-trustline-missing');
        });

        it('returns ALLOW when trustline exists', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair());

            // Mock: trustline exists
            (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValue({
                result: {
                    lines: [{
                        currency: 'RLUSD',
                        account: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                        balance: '0',
                        limit: '1000000',
                    }],
                },
            });

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.decision).toBe('ALLOW');
            expect(result.quoteExists).toBe(true);
        });

        it('handles account_lines error gracefully', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair());

            (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('Network error'),
            );

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            // Should assume missing and return CREATE (autoEnsure default true)
            expect(result.decision).toBe('CREATE');
            expect(result.quoteExists).toBe(false);
        });

        it('populates resolved pair on result', async () => {
            const resolved = makeResolvedPair();
            mockResolvePair.mockReturnValue(resolved);

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.resolved).toBeDefined();
            expect(result.resolved.pairKey).toBe('XRP/RLUSD');
        });

        it('populates checkedAtMs', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair());
            const before = Date.now();

            const result = await governance.checkForPair(makePair(), 'rWalletAddress');

            expect(result.checkedAtMs).toBeGreaterThanOrEqual(before);
            expect(result.checkedAtMs).toBeLessThanOrEqual(Date.now());
        });
    });

    describe('ensureForPair', () => {
        const mockWallet = {
            classicAddress: 'rWalletAddress',
        } as Wallet;

        it('returns success=true when decision is ALLOW', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair());

            // Trustline exists
            (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValue({
                result: {
                    lines: [{
                        currency: 'RLUSD',
                        account: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                        balance: '0',
                        limit: '1000000',
                    }],
                },
            });

            const result = await governance.ensureForPair(makePair(), mockWallet);

            expect(result.success).toBe(true);
            expect(result.created).toEqual([]);
            expect(result.errors).toEqual([]);
        });

        it('returns success=false when decision is BLOCK', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair({
                executable: false,
                blockReason: 'no-issuer',
            }));

            const result = await governance.ensureForPair(makePair(), mockWallet);

            expect(result.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('returns success=true when decision is SKIP', async () => {
            mockResolvePair.mockReturnValue(makeResolvedPair({
                base: makeXrpLeg(),
                quote: makeXrpLeg(),
            }));

            const result = await governance.ensureForPair(makePair(), mockWallet);

            expect(result.success).toBe(true);
        });
    });
});

// ─── Config Loader Tests ─────────────────────────────────────────────────────

describe('loadTrustlineGovernanceConfig', () => {
    const origEnv = { ...process.env };

    beforeEach(() => {
        // Restore original env
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('TRUSTLINE_')) {
                delete process.env[key];
            }
        }
    });

    it('returns empty config by default', () => {
        const config = loadTrustlineGovernanceConfig();
        expect(config.autoEnsure).toBeUndefined();
        expect(config.requireRegistered).toBeUndefined();
    });

    it('reads TRUSTLINE_AUTO_ENSURE=false', () => {
        process.env.TRUSTLINE_AUTO_ENSURE = 'false';
        const config = loadTrustlineGovernanceConfig();
        expect(config.autoEnsure).toBe(false);
    });

    it('reads TRUSTLINE_REQUIRE_REGISTERED=true', () => {
        process.env.TRUSTLINE_REQUIRE_REGISTERED = 'true';
        const config = loadTrustlineGovernanceConfig();
        expect(config.requireRegistered).toBe(true);
    });

    it('reads TRUSTLINE_DEFAULT_LIMIT', () => {
        process.env.TRUSTLINE_DEFAULT_LIMIT = '999999';
        const config = loadTrustlineGovernanceConfig();
        expect(config.defaultLimit).toBe('999999');
    });

    it('ignores non-numeric TRUSTLINE_DEFAULT_LIMIT', () => {
        process.env.TRUSTLINE_DEFAULT_LIMIT = 'abc';
        const config = loadTrustlineGovernanceConfig();
        expect(config.defaultLimit).toBeUndefined();
    });
});
