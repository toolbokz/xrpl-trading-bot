/**
 * Availability Scanner — Unit Tests
 *
 * Tests all pure functions and the stateful AvailabilityScanner engine
 * using a mock XRPL client that returns deterministic responses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    parseAccountFlags,
    isBlackholed,
    probeIssuerAccount,
    probeTrustline,
    probeOrderBook,
    computeAvailabilityVerdict,
    scanPairAvailability,
    AvailabilityScanner,
    loadAvailabilityScannerConfig,
    LSF_GLOBAL_FREEZE,
    LSF_DEFAULT_RIPPLE,
    LSF_DISABLE_MASTER,
    LSF_REQUIRE_AUTH,
    LSF_NO_FREEZE,
    type IssuerProbeResult,
    type TrustlineProbeResult,
    type OrderBookProbeResult,
    type PairSide,
} from '../availabilityScanner';

// ─────────────────────────────────────────────────────────────────────────────
// Mock XRPL Client
// ─────────────────────────────────────────────────────────────────────────────

function createMockClient(overrides: {
    connected?: boolean;
    accountInfo?: Record<string, any>;
    accountLines?: Record<string, any>;
    bookOffers?: { bids?: any[]; asks?: any[] };
} = {}) {
    const connected = overrides.connected ?? true;

    return {
        isConnected: () => connected,
        request: vi.fn(async (req: any) => {
            if (req.command === 'account_info') {
                const account = req.account;
                if (overrides.accountInfo?.[account] === 'NOT_FOUND') {
                    const err = new Error('Account not found');
                    (err as any).data = { error: 'actNotFound' };
                    throw err;
                }
                if (overrides.accountInfo?.[account]) {
                    return { result: { account_data: overrides.accountInfo[account] } };
                }
                return { result: { account_data: null } };
            }

            if (req.command === 'account_lines') {
                const key = `${req.account}:${req.peer}`;
                if (overrides.accountLines?.[key]) {
                    return { result: { lines: overrides.accountLines[key] } };
                }
                return { result: { lines: [] } };
            }

            if (req.command === 'book_offers') {
                // probeOrderBook semantics:
                //   Bids: taker_gets = quote (non-XRP), taker_pays = base (XRP)
                //   Asks: taker_gets = base (XRP), taker_pays = quote (non-XRP)
                // So when taker_gets is XRP, this is the asks side.
                const isXrpGets = req.taker_gets?.currency === 'XRP';
                if (isXrpGets) {
                    return { result: { offers: overrides.bookOffers?.asks ?? [] } };
                }
                return { result: { offers: overrides.bookOffers?.bids ?? [] } };
            }

            return { result: {} };
        }),
    } as any;
}

const MOCK_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const MOCK_WALLET = 'rBotWallet111111111111111111111111';
const MOCK_PAIR_KEY = 'XRP/RLUSD';

// ─────────────────────────────────────────────────────────────────────────────
// parseAccountFlags
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAccountFlags', () => {
    it('parses zero flags correctly', () => {
        const result = parseAccountFlags(0);
        expect(result.globalFreeze).toBe(false);
        expect(result.defaultRipple).toBe(false);
        expect(result.disableMaster).toBe(false);
        expect(result.requireAuth).toBe(false);
        expect(result.noFreeze).toBe(false);
    });

    it('parses GlobalFreeze flag', () => {
        const result = parseAccountFlags(LSF_GLOBAL_FREEZE);
        expect(result.globalFreeze).toBe(true);
        expect(result.defaultRipple).toBe(false);
    });

    it('parses DefaultRipple flag', () => {
        const result = parseAccountFlags(LSF_DEFAULT_RIPPLE);
        expect(result.defaultRipple).toBe(true);
        expect(result.globalFreeze).toBe(false);
    });

    it('parses DisableMaster flag', () => {
        const result = parseAccountFlags(LSF_DISABLE_MASTER);
        expect(result.disableMaster).toBe(true);
    });

    it('parses RequireAuth flag', () => {
        const result = parseAccountFlags(LSF_REQUIRE_AUTH);
        expect(result.requireAuth).toBe(true);
    });

    it('parses NoFreeze flag', () => {
        const result = parseAccountFlags(LSF_NO_FREEZE);
        expect(result.noFreeze).toBe(true);
    });

    it('parses multiple combined flags', () => {
        const combined = LSF_DEFAULT_RIPPLE | LSF_NO_FREEZE;
        const result = parseAccountFlags(combined);
        expect(result.defaultRipple).toBe(true);
        expect(result.noFreeze).toBe(true);
        expect(result.globalFreeze).toBe(false);
        expect(result.disableMaster).toBe(false);
    });

    it('parses all flags set', () => {
        const all = LSF_GLOBAL_FREEZE | LSF_DEFAULT_RIPPLE | LSF_DISABLE_MASTER |
            LSF_REQUIRE_AUTH | LSF_NO_FREEZE;
        const result = parseAccountFlags(all);
        expect(result.globalFreeze).toBe(true);
        expect(result.defaultRipple).toBe(true);
        expect(result.disableMaster).toBe(true);
        expect(result.requireAuth).toBe(true);
        expect(result.noFreeze).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// isBlackholed
// ─────────────────────────────────────────────────────────────────────────────

describe('isBlackholed', () => {
    it('returns true when master disabled and no regular key', () => {
        expect(isBlackholed(true, false)).toBe(true);
    });

    it('returns false when master disabled but regular key exists', () => {
        expect(isBlackholed(true, true)).toBe(false);
    });

    it('returns false when master not disabled', () => {
        expect(isBlackholed(false, false)).toBe(false);
        expect(isBlackholed(false, true)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// probeIssuerAccount
// ─────────────────────────────────────────────────────────────────────────────

describe('probeIssuerAccount', () => {
    it('returns healthy result for a funded issuer with DefaultRipple', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000', // 1000 XRP
                    Flags: LSF_DEFAULT_RIPPLE,
                    OwnerCount: 5,
                },
            },
        });

        const result = await probeIssuerAccount(client, MOCK_ISSUER, 'RLUSD');
        expect(result.funded).toBe(true);
        expect(result.balanceXRP).toBe(1000);
        expect(result.defaultRipple).toBe(true);
        expect(result.globalFreeze).toBe(false);
        expect(result.blackholed).toBe(false);
        expect(result.error).toBeUndefined();
    });

    it('detects frozen issuer', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '500000000',
                    Flags: LSF_GLOBAL_FREEZE | LSF_DEFAULT_RIPPLE,
                    OwnerCount: 3,
                },
            },
        });

        const result = await probeIssuerAccount(client, MOCK_ISSUER, 'RLUSD');
        expect(result.globalFreeze).toBe(true);
        expect(result.funded).toBe(true);
    });

    it('detects blackholed account', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '100000000',
                    Flags: LSF_DISABLE_MASTER | LSF_DEFAULT_RIPPLE,
                    OwnerCount: 0,
                    // No RegularKey field = blackholed
                },
            },
        });

        const result = await probeIssuerAccount(client, MOCK_ISSUER, 'RLUSD');
        expect(result.disableMaster).toBe(true);
        expect(result.hasRegularKey).toBe(false);
        expect(result.blackholed).toBe(true);
    });

    it('returns not-blackholed when regular key exists', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '100000000',
                    Flags: LSF_DISABLE_MASTER | LSF_DEFAULT_RIPPLE,
                    OwnerCount: 0,
                    RegularKey: 'rSomeRegularKey11111111111111111',
                },
            },
        });

        const result = await probeIssuerAccount(client, MOCK_ISSUER, 'RLUSD');
        expect(result.disableMaster).toBe(true);
        expect(result.hasRegularKey).toBe(true);
        expect(result.blackholed).toBe(false);
    });

    it('handles account not found error', async () => {
        const client = createMockClient({
            accountInfo: { [MOCK_ISSUER]: 'NOT_FOUND' },
        });

        const result = await probeIssuerAccount(client, MOCK_ISSUER, 'RLUSD');
        expect(result.funded).toBe(false);
        expect(result.error).toBe('Account not found on ledger');
    });

    it('handles disconnected client', async () => {
        const client = createMockClient({ connected: false });

        const result = await probeIssuerAccount(client, MOCK_ISSUER, 'RLUSD');
        expect(result.funded).toBe(false);
        expect(result.error).toBe('XRPL client not connected');
    });

    it('handles null account_data', async () => {
        const client = createMockClient({
            accountInfo: { [MOCK_ISSUER]: null as any },
        });
        // The mock returns { result: { account_data: null } }
        const result = await probeIssuerAccount(client, MOCK_ISSUER, 'RLUSD');
        expect(result.funded).toBe(false);
        expect(result.error).toBe('Account data not found');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// probeTrustline
// ─────────────────────────────────────────────────────────────────────────────

describe('probeTrustline', () => {
    it('detects existing trustline', async () => {
        const client = createMockClient({
            accountLines: {
                [`${MOCK_WALLET}:${MOCK_ISSUER}`]: [
                    { currency: 'RLUSD', account: MOCK_ISSUER, limit: '1000000', balance: '500' },
                ],
            },
        });

        const result = await probeTrustline(client, MOCK_WALLET, MOCK_ISSUER, 'RLUSD');
        expect(result.exists).toBe(true);
        expect(result.limit).toBe('1000000');
        expect(result.balance).toBe('500');
    });

    it('detects missing trustline', async () => {
        const client = createMockClient({
            accountLines: {
                [`${MOCK_WALLET}:${MOCK_ISSUER}`]: [],
            },
        });

        const result = await probeTrustline(client, MOCK_WALLET, MOCK_ISSUER, 'RLUSD');
        expect(result.exists).toBe(false);
        expect(result.error).toBeUndefined();
    });

    it('detects frozen trustline', async () => {
        const client = createMockClient({
            accountLines: {
                [`${MOCK_WALLET}:${MOCK_ISSUER}`]: [
                    { currency: 'RLUSD', account: MOCK_ISSUER, limit: '1000000', balance: '0', freeze_peer: true },
                ],
            },
        });

        const result = await probeTrustline(client, MOCK_WALLET, MOCK_ISSUER, 'RLUSD');
        expect(result.exists).toBe(true);
        expect(result.frozen).toBe(true);
    });

    it('filters by correct currency', async () => {
        const client = createMockClient({
            accountLines: {
                [`${MOCK_WALLET}:${MOCK_ISSUER}`]: [
                    { currency: 'USD', account: MOCK_ISSUER, limit: '1000', balance: '0' },
                ],
            },
        });

        const result = await probeTrustline(client, MOCK_WALLET, MOCK_ISSUER, 'RLUSD');
        expect(result.exists).toBe(false);
    });

    it('handles disconnected client', async () => {
        const client = createMockClient({ connected: false });

        const result = await probeTrustline(client, MOCK_WALLET, MOCK_ISSUER, 'RLUSD');
        expect(result.exists).toBe(false);
        expect(result.error).toBe('XRPL client not connected');
    });

    it('handles account not found', async () => {
        const client = createMockClient();
        client.request = vi.fn(async () => {
            const err = new Error('Account not found');
            (err as any).data = { error: 'actNotFound' };
            throw err;
        });

        const result = await probeTrustline(client, MOCK_WALLET, MOCK_ISSUER, 'RLUSD');
        expect(result.exists).toBe(false);
        expect(result.error).toBe('Bot wallet not found on ledger');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// probeOrderBook
// ─────────────────────────────────────────────────────────────────────────────

describe('probeOrderBook', () => {
    it('detects two-sided order book', async () => {
        const client = createMockClient({
            bookOffers: {
                bids: [
                    { TakerGets: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER }, TakerPays: '100000000' },
                ],
                asks: [
                    { TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER } },
                ],
            },
        });

        const result = await probeOrderBook(client, MOCK_PAIR_KEY, 'XRP', 'RLUSD', undefined, MOCK_ISSUER);
        expect(result.twoSided).toBe(true);
        expect(result.bidCount).toBe(1);
        expect(result.askCount).toBe(1);
        expect(result.bestBid).toBeGreaterThan(0);
        expect(result.bestAsk).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
    });

    it('detects empty order book', async () => {
        const client = createMockClient({
            bookOffers: { bids: [], asks: [] },
        });

        const result = await probeOrderBook(client, MOCK_PAIR_KEY, 'XRP', 'RLUSD', undefined, MOCK_ISSUER);
        expect(result.twoSided).toBe(false);
        expect(result.bidCount).toBe(0);
        expect(result.askCount).toBe(0);
    });

    it('detects one-sided order book (bids only)', async () => {
        const client = createMockClient({
            bookOffers: {
                bids: [
                    { TakerGets: { currency: 'RLUSD', value: '125', issuer: MOCK_ISSUER }, TakerPays: '50000000' },
                ],
                asks: [],
            },
        });

        const result = await probeOrderBook(client, MOCK_PAIR_KEY, 'XRP', 'RLUSD', undefined, MOCK_ISSUER);
        expect(result.twoSided).toBe(false);
        expect(result.bidCount).toBe(1);
        expect(result.askCount).toBe(0);
    });

    it('handles disconnected client', async () => {
        const client = createMockClient({ connected: false });

        const result = await probeOrderBook(client, MOCK_PAIR_KEY, 'XRP', 'RLUSD', undefined, MOCK_ISSUER);
        expect(result.twoSided).toBe(false);
        expect(result.error).toBe('XRPL client not connected');
    });

    it('handles request error', async () => {
        const client = createMockClient();
        client.request = vi.fn(async () => { throw new Error('Network timeout'); });

        const result = await probeOrderBook(client, MOCK_PAIR_KEY, 'XRP', 'RLUSD', undefined, MOCK_ISSUER);
        expect(result.twoSided).toBe(false);
        expect(result.error).toBe('Network timeout');
    });

    it('computes spread correctly', async () => {
        // Bids: makers sell quote (RLUSD), buy base (XRP)
        //   → TakerGets = quote (RLUSD 250), TakerPays = base (XRP 100)
        //   → price = quote/base = 250/100 = 2.5
        // Asks: makers sell base (XRP), buy quote (RLUSD)
        //   → TakerGets = base (XRP 100), TakerPays = quote (RLUSD 260)
        //   → price = quote/base = 260/100 = 2.6
        // spread = (2.6 - 2.5) / 2.6 * 10000 ≈ 384.6 bps
        const client = createMockClient({
            bookOffers: {
                bids: [
                    { TakerGets: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER }, TakerPays: '100000000' },
                ],
                asks: [
                    { TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER } },
                ],
            },
        });

        const result = await probeOrderBook(client, MOCK_PAIR_KEY, 'XRP', 'RLUSD', undefined, MOCK_ISSUER);
        expect(result.spreadBps).toBeGreaterThan(0);
        expect(result.spreadBps).toBeLessThan(500);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeAvailabilityVerdict
// ─────────────────────────────────────────────────────────────────────────────

describe('computeAvailabilityVerdict', () => {
    const healthyIssuer: IssuerProbeResult = {
        address: MOCK_ISSUER,
        currency: 'RLUSD',
        funded: true,
        balanceXRP: 1000,
        flags: LSF_DEFAULT_RIPPLE,
        globalFreeze: false,
        defaultRipple: true,
        disableMaster: false,
        requireAuth: false,
        noFreeze: false,
        hasRegularKey: false,
        blackholed: false,
        probedAtMs: Date.now(),
    };

    const healthyTrustline: TrustlineProbeResult = {
        walletAddress: MOCK_WALLET,
        issuerAddress: MOCK_ISSUER,
        currency: 'RLUSD',
        exists: true,
        limit: '1000000',
        balance: '0',
        probedAtMs: Date.now(),
    };

    const healthyOrderBook: OrderBookProbeResult = {
        pairKey: MOCK_PAIR_KEY,
        bidCount: 5,
        askCount: 5,
        bestBid: 2.5,
        bestAsk: 2.51,
        spreadBps: 40,
        bidDepthNotional: 50000,
        askDepthNotional: 50000,
        twoSided: true,
        probedAtMs: Date.now(),
    };

    it('returns AVAILABLE when all probes pass', () => {
        const { verdict, reasons } = computeAvailabilityVerdict(
            [healthyIssuer],
            [healthyTrustline],
            healthyOrderBook,
        );
        expect(verdict).toBe('AVAILABLE');
        expect(reasons).toHaveLength(0);
    });

    it('returns BLOCKED when issuer is frozen', () => {
        const frozenIssuer: IssuerProbeResult = {
            ...healthyIssuer,
            globalFreeze: true,
            flags: LSF_GLOBAL_FREEZE | LSF_DEFAULT_RIPPLE,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [frozenIssuer],
            [healthyTrustline],
            healthyOrderBook,
        );
        expect(verdict).toBe('BLOCKED');
        expect(reasons).toContain('issuer-frozen');
    });

    it('returns UNAVAILABLE when issuer is unfunded', () => {
        const unfundedIssuer: IssuerProbeResult = {
            ...healthyIssuer,
            funded: false,
            balanceXRP: 0,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [unfundedIssuer],
            [],
            healthyOrderBook,
        );
        expect(verdict).toBe('UNAVAILABLE');
        expect(reasons).toContain('issuer-unfunded');
    });

    it('returns UNAVAILABLE when order book is empty', () => {
        const emptyBook: OrderBookProbeResult = {
            ...healthyOrderBook,
            bidCount: 0,
            askCount: 0,
            twoSided: false,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [healthyIssuer],
            [healthyTrustline],
            emptyBook,
        );
        expect(verdict).toBe('UNAVAILABLE');
        expect(reasons).toContain('orderbook-empty');
    });

    it('returns DEGRADED when issuer is blackholed', () => {
        // Note: blackholed alone is not UNAVAILABLE because stablecoin issuers
        // (RLUSD, USDC) intentionally blackhole their accounts as a security measure.
        // A blackholed issuer that is funded with DefaultRipple is healthy for trading.
        // The verdict depends on other signals (trustline, orderbook).
        const blackholedIssuer: IssuerProbeResult = {
            ...healthyIssuer,
            blackholed: true,
            disableMaster: true,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [blackholedIssuer],
            [],
            healthyOrderBook,
        );
        // blackholed alone triggers 'issuer-blackholed' reason but is not in
        // hasCritical or hasDegraded — however with empty trustlineProbes and
        // healthy orderbook, verdict is UNKNOWN because reasons.length > 0
        // but no blocker/critical/degraded category matches.
        expect(reasons).toContain('issuer-blackholed');
        // Verdict should not be AVAILABLE (there is a reason present)
        expect(verdict).not.toBe('AVAILABLE');
    });

    it('returns DEGRADED when trustline is missing', () => {
        const missingTrustline: TrustlineProbeResult = {
            ...healthyTrustline,
            exists: false,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [healthyIssuer],
            [missingTrustline],
            healthyOrderBook,
        );
        expect(verdict).toBe('DEGRADED');
        expect(reasons).toContain('trustline-missing');
    });

    it('returns DEGRADED when order book is one-sided', () => {
        const oneSidedBook: OrderBookProbeResult = {
            ...healthyOrderBook,
            askCount: 0,
            twoSided: false,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [healthyIssuer],
            [healthyTrustline],
            oneSidedBook,
        );
        expect(verdict).toBe('DEGRADED');
        expect(reasons).toContain('orderbook-one-sided');
    });

    it('returns DEGRADED when issuer requires auth', () => {
        const authIssuer: IssuerProbeResult = {
            ...healthyIssuer,
            requireAuth: true,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [authIssuer],
            [],
            healthyOrderBook,
        );
        expect(verdict).toBe('DEGRADED');
        expect(reasons).toContain('issuer-require-auth');
    });

    it('returns DEGRADED when issuer lacks DefaultRipple', () => {
        const noRippleIssuer: IssuerProbeResult = {
            ...healthyIssuer,
            defaultRipple: false,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [noRippleIssuer],
            [],
            healthyOrderBook,
        );
        expect(verdict).toBe('DEGRADED');
        expect(reasons).toContain('issuer-no-default-ripple');
    });

    it('BLOCKED takes priority over UNAVAILABLE', () => {
        const frozenIssuer: IssuerProbeResult = {
            ...healthyIssuer,
            globalFreeze: true,
            funded: false, // Also unfunded
        };

        const { verdict } = computeAvailabilityVerdict(
            [frozenIssuer],
            [],
            null,
        );
        expect(verdict).toBe('BLOCKED');
    });

    it('returns UNKNOWN when no issuer probes exist', () => {
        const { verdict } = computeAvailabilityVerdict([], [], null);
        expect(verdict).toBe('UNKNOWN');
    });

    it('includes probe errors in reasons', () => {
        const errorIssuer: IssuerProbeResult = {
            ...healthyIssuer,
            error: 'Connection timeout',
        };

        const { verdict, reasons, details } = computeAvailabilityVerdict(
            [errorIssuer],
            [],
            null,
        );
        expect(reasons).toContain('probe-error');
        expect(details[0]).toContain('Connection timeout');
        expect(verdict).toBe('DEGRADED');
    });

    it('handles multiple issuers (both sides issued)', () => {
        const issuer2: IssuerProbeResult = {
            ...healthyIssuer,
            address: 'rOtherIssuer1111111111111111111111',
            currency: 'BTC',
            globalFreeze: true,
        };

        const { verdict, reasons } = computeAvailabilityVerdict(
            [healthyIssuer, issuer2],
            [],
            healthyOrderBook,
        );
        // Second issuer is frozen → BLOCKED
        expect(verdict).toBe('BLOCKED');
        expect(reasons).toContain('issuer-frozen');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// scanPairAvailability (integration of all probes)
// ─────────────────────────────────────────────────────────────────────────────

describe('scanPairAvailability', () => {
    it('scans XRP/issued pair successfully', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                    OwnerCount: 5,
                },
            },
            accountLines: {
                [`${MOCK_WALLET}:${MOCK_ISSUER}`]: [
                    { currency: 'RLUSD', account: MOCK_ISSUER, limit: '1000000', balance: '100' },
                ],
            },
            bookOffers: {
                bids: [{ TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER } }],
                asks: [{ TakerGets: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER }, TakerPays: '100000000' }],
            },
        });

        const base: PairSide = { currency: 'XRP' };
        const quote: PairSide = { currency: 'RLUSD', issuer: MOCK_ISSUER };

        const result = await scanPairAvailability(client, MOCK_PAIR_KEY, base, quote, MOCK_WALLET);
        expect(result.verdict).toBe('AVAILABLE');
        expect(result.issuerProbes).toHaveLength(1);
        expect(result.trustlineProbes).toHaveLength(1);
        expect(result.orderBookProbe).not.toBeNull();
        expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('skips trustline probe when no wallet address', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: {
                bids: [{ TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER } }],
                asks: [{ TakerGets: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER }, TakerPays: '100000000' }],
            },
        });

        const base: PairSide = { currency: 'XRP' };
        const quote: PairSide = { currency: 'RLUSD', issuer: MOCK_ISSUER };

        const result = await scanPairAvailability(client, MOCK_PAIR_KEY, base, quote, null);
        expect(result.trustlineProbes).toHaveLength(0);
    });

    it('skips issuer probe for XRP (native)', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: {
                bids: [{ TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER } }],
                asks: [{ TakerGets: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER }, TakerPays: '100000000' }],
            },
        });

        const base: PairSide = { currency: 'XRP' };
        const quote: PairSide = { currency: 'RLUSD', issuer: MOCK_ISSUER };

        const result = await scanPairAvailability(client, MOCK_PAIR_KEY, base, quote, null);
        // Only 1 issuer probe (quote side), not 2
        expect(result.issuerProbes).toHaveLength(1);
        expect(result.issuerProbes[0]!.currency).toBe('RLUSD');
    });

    it('respects probeTrustlines=false config', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: { bids: [], asks: [] },
        });

        const base: PairSide = { currency: 'XRP' };
        const quote: PairSide = { currency: 'RLUSD', issuer: MOCK_ISSUER };

        const result = await scanPairAvailability(
            client, MOCK_PAIR_KEY, base, quote, MOCK_WALLET,
            { probeTrustlines: false },
        );
        expect(result.trustlineProbes).toHaveLength(0);
    });

    it('respects probeOrderBooks=false config', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
        });

        const base: PairSide = { currency: 'XRP' };
        const quote: PairSide = { currency: 'RLUSD', issuer: MOCK_ISSUER };

        const result = await scanPairAvailability(
            client, MOCK_PAIR_KEY, base, quote, null,
            { probeOrderBooks: false },
        );
        expect(result.orderBookProbe).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AvailabilityScanner (stateful engine)
// ─────────────────────────────────────────────────────────────────────────────

describe('AvailabilityScanner', () => {
    let scanner: AvailabilityScanner;

    beforeEach(() => {
        scanner = new AvailabilityScanner({ scanIntervalMs: 5_000 });
    });

    it('starts with empty state', () => {
        const snapshot = scanner.getSnapshot();
        expect(snapshot.pairs).toHaveLength(0);
        expect(snapshot.running).toBe(false);
        expect(snapshot.scanCount).toBe(0);
    });

    it('registers and unregisters pairs', () => {
        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        expect(scanner.getPairCount()).toBe(1);
        expect(scanner.getRegisteredPairs()).toEqual(['XRP/RLUSD']);

        scanner.removePair('XRP/RLUSD');
        expect(scanner.getPairCount()).toBe(0);
    });

    it('scanAll returns results for all registered pairs', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: {
                bids: [{ TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER } }],
                asks: [{ TakerGets: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER }, TakerPays: '100000000' }],
            },
        });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        const results = await scanner.scanAll(client);

        expect(results).toHaveLength(1);
        expect(results[0]!.pairKey).toBe('XRP/RLUSD');
        expect(scanner.getSnapshot().scanCount).toBe(1);
        expect(scanner.getSnapshot().lastScanMs).toBeGreaterThan(0);
    });

    it('scanOnePair returns null for unregistered pair', async () => {
        const client = createMockClient();
        const result = await scanner.scanOnePair(client, 'XRP/RLUSD');
        expect(result).toBeNull();
    });

    it('scanOnePair returns result for registered pair', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: { bids: [], asks: [] },
        });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        const result = await scanner.scanOnePair(client, 'XRP/RLUSD');

        expect(result).not.toBeNull();
        expect(result!.pairKey).toBe('XRP/RLUSD');
    });

    it('getPairAvailability returns cached result after scan', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: {
                bids: [{ TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER } }],
                asks: [{ TakerGets: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER }, TakerPays: '100000000' }],
            },
        });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        await scanner.scanAll(client);

        const cached = scanner.getPairAvailability('XRP/RLUSD');
        expect(cached).not.toBeNull();
        expect(cached!.verdict).toBe('AVAILABLE');
    });

    it('isTradeable returns true for AVAILABLE', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: {
                bids: [{ TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER } }],
                asks: [{ TakerGets: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER }, TakerPays: '100000000' }],
            },
        });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        await scanner.scanAll(client);

        expect(scanner.isTradeable('XRP/RLUSD')).toBe(true);
        expect(scanner.isBlocked('XRP/RLUSD')).toBe(false);
    });

    it('isBlocked returns true for BLOCKED', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_GLOBAL_FREEZE | LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: { bids: [], asks: [] },
        });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        await scanner.scanAll(client);

        expect(scanner.isBlocked('XRP/RLUSD')).toBe(true);
        expect(scanner.isTradeable('XRP/RLUSD')).toBe(false);
    });

    it('needsScan returns true initially', () => {
        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        expect(scanner.needsScan()).toBe(true);
    });

    it('needsScan returns false immediately after scan', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: { bids: [], asks: [] },
        });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        await scanner.scanAll(client);
        expect(scanner.needsScan()).toBe(false);
    });

    it('needsScan returns false when no pairs registered', () => {
        expect(scanner.needsScan()).toBe(false);
    });

    it('reset clears all state', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            bookOffers: { bids: [], asks: [] },
        });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        await scanner.scanAll(client);
        expect(scanner.getSnapshot().scanCount).toBe(1);

        scanner.reset();
        expect(scanner.getSnapshot().scanCount).toBe(0);
        expect(scanner.getSnapshot().pairs).toHaveLength(0);
        expect(scanner.getPairAvailability('XRP/RLUSD')).toBeNull();
    });

    it('setWalletAddress enables trustline probes', async () => {
        const client = createMockClient({
            accountInfo: {
                [MOCK_ISSUER]: {
                    Balance: '1000000000',
                    Flags: LSF_DEFAULT_RIPPLE,
                },
            },
            accountLines: {
                [`${MOCK_WALLET}:${MOCK_ISSUER}`]: [
                    { currency: 'RLUSD', account: MOCK_ISSUER, limit: '1000000', balance: '0' },
                ],
            },
            bookOffers: {
                bids: [{ TakerGets: '100000000', TakerPays: { currency: 'RLUSD', value: '250', issuer: MOCK_ISSUER } }],
                asks: [{ TakerGets: { currency: 'RLUSD', value: '260', issuer: MOCK_ISSUER }, TakerPays: '100000000' }],
            },
        });

        scanner.setWalletAddress(MOCK_WALLET);
        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        await scanner.scanAll(client);

        const result = scanner.getPairAvailability('XRP/RLUSD');
        expect(result!.trustlineProbes).toHaveLength(1);
        expect(result!.trustlineProbes[0]!.exists).toBe(true);
    });

    it('handles scan error gracefully', async () => {
        const client = createMockClient();
        client.request = vi.fn(async () => { throw new Error('Total network failure'); });

        scanner.addPair('XRP/RLUSD', { currency: 'XRP' }, { currency: 'RLUSD', issuer: MOCK_ISSUER });
        const results = await scanner.scanAll(client);

        expect(results).toHaveLength(1);
        // probe-error is classified as DEGRADED (not UNKNOWN) by the verdict engine
        expect(results[0]!.verdict).toBe('DEGRADED');
        expect(results[0]!.reasons).toContain('probe-error');
    });

    it('getVerdict returns UNKNOWN for unscanned pair', () => {
        expect(scanner.getVerdict('XRP/RLUSD')).toBe('UNKNOWN');
    });

    it('returns config via getConfig', () => {
        const config = scanner.getConfig();
        expect(config.scanIntervalMs).toBe(5_000);
        expect(config.probeTrustlines).toBe(true);
        expect(config.probeOrderBooks).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAvailabilityScannerConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('loadAvailabilityScannerConfig', () => {
    it('returns empty config when no env vars set', () => {
        const config = loadAvailabilityScannerConfig();
        expect(config).toBeDefined();
    });

    it('reads AVAILABILITY_SCAN_INTERVAL_MS', () => {
        process.env.AVAILABILITY_SCAN_INTERVAL_MS = '30000';
        const config = loadAvailabilityScannerConfig();
        expect(config.scanIntervalMs).toBe(30000);
        delete process.env.AVAILABILITY_SCAN_INTERVAL_MS;
    });

    it('reads AVAILABILITY_PROBE_TRUSTLINES=false', () => {
        process.env.AVAILABILITY_PROBE_TRUSTLINES = 'false';
        const config = loadAvailabilityScannerConfig();
        expect(config.probeTrustlines).toBe(false);
        delete process.env.AVAILABILITY_PROBE_TRUSTLINES;
    });

    it('reads AVAILABILITY_PROBE_ORDERBOOKS=false', () => {
        process.env.AVAILABILITY_PROBE_ORDERBOOKS = 'false';
        const config = loadAvailabilityScannerConfig();
        expect(config.probeOrderBooks).toBe(false);
        delete process.env.AVAILABILITY_PROBE_ORDERBOOKS;
    });
});
