/**
 * Availability Scanner — Runtime Network Probing
 *
 * Determines whether a trading pair is actually usable on the live XRPL
 * network by probing multiple on-ledger signals:
 *
 *   1. **Issuer Health Probe** — account_info for each issuer:
 *      - Account funded (balance > 0)
 *      - Account flags: GlobalFreeze (0x00400000), DefaultRipple (0x00800000),
 *        DisableMaster (0x00100000), RequireAuth (0x00040000)
 *      - Freeze → pair BLOCKED (untradeable)
 *
 *   2. **Trustline Probe** — account_lines for the bot's wallet:
 *      - Verifies the bot holds a trustline to each issued currency's issuer
 *      - Missing trustline → DEGRADED (can't receive issued tokens)
 *
 *   3. **Order Book Probe** — book_offers bid/ask presence:
 *      - Non-empty bids AND asks → healthy liquidity
 *      - One-sided or empty → DEGRADED or UNAVAILABLE
 *
 * Each probe returns a typed result. The composite verdict is one of:
 *   AVAILABLE    — all probes pass, pair is fully tradeable
 *   DEGRADED     — some probes show issues but trading may work
 *   UNAVAILABLE  — critical probes failed, trading is unsafe
 *   BLOCKED      — issuer frozen or blackholed, trading MUST NOT proceed
 *   UNKNOWN      — not yet probed or probe errors
 *
 * The scanner runs periodically (not every tick) and caches results.
 * Results feed into the Instrument Registry (liquidity/status updates)
 * and the execution gate (block trading on BLOCKED pairs).
 *
 * @module market/availabilityScanner
 */

import type { Client } from 'xrpl';
import { logger } from '../analytics/logger';
import { toXrplCurrency } from '../xrpl/currency';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Overall availability verdict for a trading pair. */
export type AvailabilityVerdict = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'BLOCKED' | 'UNKNOWN';

/** Reason categories for availability degradation/blocking. */
export type AvailabilityReason =
    | 'issuer-frozen'
    | 'issuer-unfunded'
    | 'issuer-require-auth'
    | 'issuer-no-default-ripple'
    | 'issuer-blackholed'
    | 'trustline-missing'
    | 'orderbook-empty'
    | 'orderbook-one-sided'
    | 'probe-error'
    | 'not-probed';

// ── XRPL Account Flags (from rippled source) ────────────────────────────────

/** lsfGlobalFreeze — issuer has frozen all issued tokens. */
export const LSF_GLOBAL_FREEZE = 0x00400000;
/** lsfDefaultRipple — required for tokens to flow through the issuer. */
export const LSF_DEFAULT_RIPPLE = 0x00800000;
/** lsfDisableMaster — master key is disabled (potential blackhole). */
export const LSF_DISABLE_MASTER = 0x00100000;
/** lsfRequireAuth — issuer must individually authorize each trustline. */
export const LSF_REQUIRE_AUTH = 0x00040000;
/** lsfNoFreeze — issuer has permanently given up the ability to freeze. */
export const LSF_NO_FREEZE = 0x00200000;

// ── Probe Result Types ──────────────────────────────────────────────────────

/** Result of probing a single issuer's account. */
export interface IssuerProbeResult {
    /** Issuer address probed. */
    address: string;
    /** Currency this issuer provides. */
    currency: string;
    /** Whether the account exists and is funded. */
    funded: boolean;
    /** Account balance in XRP (0 if unfunded). */
    balanceXRP: number;
    /** Raw account Flags field. */
    flags: number;
    /** Parsed flag booleans. */
    globalFreeze: boolean;
    defaultRipple: boolean;
    disableMaster: boolean;
    requireAuth: boolean;
    noFreeze: boolean;
    /** Whether a regular key is set (mitigates disableMaster = blackhole). */
    hasRegularKey: boolean;
    /** True if account is blackholed (disableMaster + no regularKey). */
    blackholed: boolean;
    /** Error message if probe failed. */
    error?: string | undefined;
    /** Probe timestamp (ms epoch). */
    probedAtMs: number;
}

/** Result of probing trustlines for the bot's wallet. */
export interface TrustlineProbeResult {
    /** The bot wallet address checked. */
    walletAddress: string;
    /** Issuer address. */
    issuerAddress: string;
    /** Currency code. */
    currency: string;
    /** Whether a trustline exists. */
    exists: boolean;
    /** Trust limit (if trustline exists). */
    limit?: string | undefined;
    /** Current balance on the trustline (if exists). */
    balance?: string | undefined;
    /** Whether the trustline is frozen by the issuer. */
    frozen?: boolean | undefined;
    /** Whether auth is required but not granted. */
    authorized?: boolean | undefined;
    /** Error message if probe failed. */
    error?: string | undefined;
    /** Probe timestamp (ms epoch). */
    probedAtMs: number;
}

/** Result of probing order book presence. */
export interface OrderBookProbeResult {
    /** Pair key probed. */
    pairKey: string;
    /** Number of bid levels. */
    bidCount: number;
    /** Number of ask levels. */
    askCount: number;
    /** Best bid price (0 if no bids). */
    bestBid: number;
    /** Best ask price (0 if no asks). */
    bestAsk: number;
    /** Spread in basis points (0 if one-sided). */
    spreadBps: number;
    /** Total bid depth in notional. */
    bidDepthNotional: number;
    /** Total ask depth in notional. */
    askDepthNotional: number;
    /** Whether the order book has two-sided liquidity. */
    twoSided: boolean;
    /** Error message if probe failed. */
    error?: string | undefined;
    /** Probe timestamp (ms epoch). */
    probedAtMs: number;
}

/** Composite availability result for a single pair. */
export interface PairAvailability {
    /** Pair key (e.g., "XRP/RLUSD"). */
    pairKey: string;
    /** Overall verdict. */
    verdict: AvailabilityVerdict;
    /** Reasons for non-AVAILABLE verdicts. */
    reasons: AvailabilityReason[];
    /** Human-readable detail messages. */
    details: string[];
    /** Issuer probe results (one per issued side). */
    issuerProbes: IssuerProbeResult[];
    /** Trustline probe results (one per issued side). */
    trustlineProbes: TrustlineProbeResult[];
    /** Order book probe result. */
    orderBookProbe: OrderBookProbeResult | null;
    /** When this availability was computed (ms epoch). */
    probedAtMs: number;
    /** How long all probes took (ms). */
    probeDurationMs: number;
}

/** Scanner configuration. */
export interface AvailabilityScannerConfig {
    /** Interval between full scans in ms (default: 60_000 = 1 minute). */
    scanIntervalMs: number;
    /** Timeout for individual XRPL requests in ms (default: 5_000). */
    requestTimeoutMs: number;
    /** Whether to probe trustlines (requires wallet address). */
    probeTrustlines: boolean;
    /** Whether to probe order books. */
    probeOrderBooks: boolean;
    /** Minimum bid+ask depth notional to count as "available" (default: 0). */
    minDepthNotional: number;
}

/** Full scanner state snapshot (for API exposure). */
export interface AvailabilityScannerSnapshot {
    /** All pair availability results. */
    pairs: PairAvailability[];
    /** Whether the scanner is running. */
    running: boolean;
    /** Total number of scans completed. */
    scanCount: number;
    /** Timestamp of last completed scan (ms epoch). */
    lastScanMs: number;
    /** Duration of last scan (ms). */
    lastScanDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Probe Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse XRPL account flags into individual booleans.
 */
export function parseAccountFlags(flags: number): {
    globalFreeze: boolean;
    defaultRipple: boolean;
    disableMaster: boolean;
    requireAuth: boolean;
    noFreeze: boolean;
} {
    return {
        globalFreeze: (flags & LSF_GLOBAL_FREEZE) !== 0,
        defaultRipple: (flags & LSF_DEFAULT_RIPPLE) !== 0,
        disableMaster: (flags & LSF_DISABLE_MASTER) !== 0,
        requireAuth: (flags & LSF_REQUIRE_AUTH) !== 0,
        noFreeze: (flags & LSF_NO_FREEZE) !== 0,
    };
}

/**
 * Determine if an issuer account is blackholed.
 * A blackholed account has disabled its master key AND has no regular key set.
 * This means no one can sign transactions for the account.
 */
export function isBlackholed(disableMaster: boolean, hasRegularKey: boolean): boolean {
    return disableMaster && !hasRegularKey;
}

/**
 * Probe an issuer account via account_info.
 * Returns structured health information about the issuer.
 */
export async function probeIssuerAccount(
    client: Client,
    address: string,
    currency: string,
): Promise<IssuerProbeResult> {
    const nowMs = Date.now();
    try {
        if (!client.isConnected()) {
            return {
                address,
                currency,
                funded: false,
                balanceXRP: 0,
                flags: 0,
                globalFreeze: false,
                defaultRipple: false,
                disableMaster: false,
                requireAuth: false,
                noFreeze: false,
                hasRegularKey: false,
                blackholed: false,
                error: 'XRPL client not connected',
                probedAtMs: nowMs,
            };
        }

        const response = await client.request({
            command: 'account_info',
            account: address,
            ledger_index: 'validated',
        });

        const data = response.result?.account_data;
        if (!data) {
            return {
                address,
                currency,
                funded: false,
                balanceXRP: 0,
                flags: 0,
                globalFreeze: false,
                defaultRipple: false,
                disableMaster: false,
                requireAuth: false,
                noFreeze: false,
                hasRegularKey: false,
                blackholed: false,
                error: 'Account data not found',
                probedAtMs: nowMs,
            };
        }

        const balanceXRP = Number(data.Balance) / 1_000_000;
        const flags = typeof data.Flags === 'number' ? data.Flags : 0;
        const parsed = parseAccountFlags(flags);
        const hasRegularKey = !!(data as any).RegularKey;
        const blackholedResult = isBlackholed(parsed.disableMaster, hasRegularKey);

        return {
            address,
            currency,
            funded: balanceXRP > 0,
            balanceXRP,
            flags,
            ...parsed,
            hasRegularKey,
            blackholed: blackholedResult,
            probedAtMs: nowMs,
        };
    } catch (err: any) {
        // actNotFound means account doesn't exist / never been funded
        const errMsg = err?.data?.error === 'actNotFound'
            ? 'Account not found on ledger'
            : (err?.message ?? 'Unknown error');

        return {
            address,
            currency,
            funded: false,
            balanceXRP: 0,
            flags: 0,
            globalFreeze: false,
            defaultRipple: false,
            disableMaster: false,
            requireAuth: false,
            noFreeze: false,
            hasRegularKey: false,
            blackholed: false,
            error: errMsg,
            probedAtMs: nowMs,
        };
    }
}

/**
 * Probe the bot's trustline to a specific issuer+currency.
 * Uses account_lines with peer filter for efficiency.
 */
export async function probeTrustline(
    client: Client,
    walletAddress: string,
    issuerAddress: string,
    currency: string,
): Promise<TrustlineProbeResult> {
    const nowMs = Date.now();
    try {
        if (!client.isConnected()) {
            return {
                walletAddress,
                issuerAddress,
                currency,
                exists: false,
                error: 'XRPL client not connected',
                probedAtMs: nowMs,
            };
        }

        const response = await client.request({
            command: 'account_lines',
            account: walletAddress,
            peer: issuerAddress,
            ledger_index: 'validated',
        });

        const lines = response.result?.lines ?? [];
        // Find the specific currency trustline
        const line = lines.find(
            (l: any) => l.currency === currency && l.account === issuerAddress,
        );

        if (!line) {
            return {
                walletAddress,
                issuerAddress,
                currency,
                exists: false,
                probedAtMs: nowMs,
            };
        }

        return {
            walletAddress,
            issuerAddress,
            currency,
            exists: true,
            limit: line.limit,
            balance: line.balance,
            frozen: !!(line as any).freeze_peer || !!(line as any).freeze,
            authorized: (line as any).authorized !== false,
            probedAtMs: nowMs,
        };
    } catch (err: any) {
        const errMsg = err?.data?.error === 'actNotFound'
            ? 'Bot wallet not found on ledger'
            : (err?.message ?? 'Unknown error');

        return {
            walletAddress,
            issuerAddress,
            currency,
            exists: false,
            error: errMsg,
            probedAtMs: nowMs,
        };
    }
}

/**
 * Probe order book presence for a trading pair.
 * Uses book_offers to check bid and ask sides.
 */
export async function probeOrderBook(
    client: Client,
    pairKey: string,
    baseCurrency: string,
    quoteCurrency: string,
    baseIssuer: string | undefined,
    quoteIssuer: string | undefined,
): Promise<OrderBookProbeResult> {
    const nowMs = Date.now();
    try {
        if (!client.isConnected()) {
            return {
                pairKey,
                bidCount: 0,
                askCount: 0,
                bestBid: 0,
                bestAsk: 0,
                spreadBps: 0,
                bidDepthNotional: 0,
                askDepthNotional: 0,
                twoSided: false,
                error: 'XRPL client not connected',
                probedAtMs: nowMs,
            };
        }

        // Use toXrplCurrency() to properly hex-encode non-standard codes (e.g., RLUSD → 40-char hex)
        const baseCurr = baseCurrency.toUpperCase() === 'XRP'
            ? { currency: 'XRP' }
            : toXrplCurrency({ currency: baseCurrency, issuer: baseIssuer! });
        const quoteCurr = quoteCurrency.toUpperCase() === 'XRP'
            ? { currency: 'XRP' }
            : toXrplCurrency({ currency: quoteCurrency, issuer: quoteIssuer! });

        const common = { ledger_index: 'validated' as const, limit: 20 };

        // XRPL book_offers semantics:
        //   taker_gets = what the taker receives = what the maker SELLS
        //   taker_pays = what the taker pays     = what the maker BUYS
        //
        // Bids (buy base): makers sell quote, buy base
        //   → taker_gets = quote, taker_pays = base
        const bidsRes = await client.request({
            command: 'book_offers',
            taker_gets: quoteCurr as any,
            taker_pays: baseCurr as any,
            ...common,
        });

        // Asks (sell base): makers sell base, buy quote
        //   → taker_gets = base, taker_pays = quote
        const asksRes = await client.request({
            command: 'book_offers',
            taker_gets: baseCurr as any,
            taker_pays: quoteCurr as any,
            ...common,
        });

        const bids = (bidsRes?.result?.offers ?? []) as any[];
        const asks = (asksRes?.result?.offers ?? []) as any[];

        // Compute notional depths
        const toAmount = (val: any): number => {
            if (typeof val === 'string') return Number(val) / 1_000_000; // XRP drops
            if (typeof val === 'object' && val !== null) return Number(val.value || 0);
            return 0;
        };

        // Bids: TakerGets=quote, TakerPays=base → price = quote/base = TakerGets/TakerPays
        let bidDepthNotional = 0;
        let bestBidPrice = 0;
        for (const offer of bids) {
            const gets = toAmount(offer.TakerGets); // quote amount
            const pays = toAmount(offer.TakerPays); // base amount
            if (gets > 0 && pays > 0) {
                const price = gets / pays; // quote per base
                if (bestBidPrice === 0) bestBidPrice = price;
                bidDepthNotional += pays * price; // base qty × price = notional
            }
        }

        // Asks: TakerGets=base, TakerPays=quote → price = quote/base = TakerPays/TakerGets
        let askDepthNotional = 0;
        let bestAskPrice = 0;
        for (const offer of asks) {
            const gets = toAmount(offer.TakerGets); // base amount
            const pays = toAmount(offer.TakerPays); // quote amount
            if (gets > 0 && pays > 0) {
                const price = pays / gets; // quote per base
                if (bestAskPrice === 0) bestAskPrice = price;
                askDepthNotional += gets * price; // base qty × price = notional
            }
        }

        const twoSided = bids.length > 0 && asks.length > 0;
        const spreadBps =
            twoSided && bestAskPrice > 0
                ? ((bestAskPrice - bestBidPrice) / bestAskPrice) * 10_000
                : 0;

        return {
            pairKey,
            bidCount: bids.length,
            askCount: asks.length,
            bestBid: bestBidPrice,
            bestAsk: bestAskPrice,
            spreadBps: Math.max(0, spreadBps),
            bidDepthNotional,
            askDepthNotional,
            twoSided,
            probedAtMs: nowMs,
        };
    } catch (err: any) {
        return {
            pairKey,
            bidCount: 0,
            askCount: 0,
            bestBid: 0,
            bestAsk: 0,
            spreadBps: 0,
            bidDepthNotional: 0,
            askDepthNotional: 0,
            twoSided: false,
            error: err?.message ?? 'Unknown error',
            probedAtMs: nowMs,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite Verdict
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the composite availability verdict from individual probe results.
 *
 * Priority: BLOCKED > UNAVAILABLE > DEGRADED > AVAILABLE.
 */
export function computeAvailabilityVerdict(
    issuerProbes: IssuerProbeResult[],
    trustlineProbes: TrustlineProbeResult[],
    orderBookProbe: OrderBookProbeResult | null,
): { verdict: AvailabilityVerdict; reasons: AvailabilityReason[]; details: string[] } {
    const reasons: AvailabilityReason[] = [];
    const details: string[] = [];

    // ── Issuer health checks (BLOCK-level) ───────────────────────────────

    for (const probe of issuerProbes) {
        if (probe.error) {
            reasons.push('probe-error');
            details.push(`Issuer probe error for ${probe.address}: ${probe.error}`);
            continue;
        }

        if (probe.globalFreeze) {
            reasons.push('issuer-frozen');
            details.push(`Issuer ${probe.address} (${probe.currency}) has GlobalFreeze enabled — all tokens frozen`);
        }

        if (!probe.funded) {
            reasons.push('issuer-unfunded');
            details.push(`Issuer ${probe.address} (${probe.currency}) is not funded`);
        }

        if (probe.requireAuth) {
            reasons.push('issuer-require-auth');
            details.push(`Issuer ${probe.address} (${probe.currency}) requires individual authorization`);
        }

        if (!probe.defaultRipple) {
            reasons.push('issuer-no-default-ripple');
            details.push(`Issuer ${probe.address} (${probe.currency}) does not have DefaultRipple enabled`);
        }

        if (probe.blackholed) {
            reasons.push('issuer-blackholed');
            details.push(`Issuer ${probe.address} (${probe.currency}) is blackholed (master key disabled, no regular key)`);
        }
    }

    // ── Trustline checks (DEGRADED-level) ────────────────────────────────

    for (const probe of trustlineProbes) {
        if (probe.error) {
            reasons.push('probe-error');
            details.push(`Trustline probe error for ${probe.issuerAddress}: ${probe.error}`);
            continue;
        }

        if (!probe.exists) {
            reasons.push('trustline-missing');
            details.push(`No trustline to issuer ${probe.issuerAddress} for ${probe.currency}`);
        }
    }

    // ── Order book checks (DEGRADED/UNAVAILABLE-level) ───────────────────

    if (orderBookProbe) {
        if (orderBookProbe.error) {
            reasons.push('probe-error');
            details.push(`Order book probe error: ${orderBookProbe.error}`);
        } else if (orderBookProbe.bidCount === 0 && orderBookProbe.askCount === 0) {
            reasons.push('orderbook-empty');
            details.push('Order book is completely empty — no bids or asks');
        } else if (!orderBookProbe.twoSided) {
            reasons.push('orderbook-one-sided');
            details.push(
                `Order book is one-sided: ${orderBookProbe.bidCount} bids, ${orderBookProbe.askCount} asks`,
            );
        }
    }

    // ── Determine verdict ────────────────────────────────────────────────

    const hasBlocker = reasons.some(r => r === 'issuer-frozen');
    // Note: issuer-blackholed is NOT critical on its own. Stablecoin issuers (RLUSD, USDC)
    // intentionally blackhole their accounts as a security measure. A blackholed issuer
    // that is funded with DefaultRipple enabled is perfectly healthy for trading.
    // Only unfunded or empty-orderbook conditions are truly critical.
    const hasCritical = reasons.some(r =>
        r === 'issuer-unfunded' || r === 'orderbook-empty',
    );
    const hasDegraded = reasons.some(r =>
        r === 'trustline-missing' ||
        r === 'orderbook-one-sided' ||
        r === 'issuer-require-auth' ||
        r === 'issuer-no-default-ripple' ||
        r === 'probe-error',
    );

    let verdict: AvailabilityVerdict;
    if (hasBlocker) {
        verdict = 'BLOCKED';
    } else if (hasCritical) {
        verdict = 'UNAVAILABLE';
    } else if (hasDegraded) {
        verdict = 'DEGRADED';
    } else if (reasons.length === 0 && issuerProbes.length > 0) {
        verdict = 'AVAILABLE';
    } else {
        verdict = 'UNKNOWN';
    }

    return { verdict, reasons, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full Pair Scan
// ─────────────────────────────────────────────────────────────────────────────

/** Input describing one side of a pair to scan. */
export interface PairSide {
    currency: string;
    issuer?: string | undefined;
}

/**
 * Run a full availability scan for a single pair.
 *
 * This is the main entry point for scanning a specific pair.
 * It orchestrates all probes and returns the composite result.
 */
export async function scanPairAvailability(
    client: Client,
    pairKey: string,
    base: PairSide,
    quote: PairSide,
    walletAddress: string | null,
    config: Partial<AvailabilityScannerConfig> = {},
): Promise<PairAvailability> {
    const startMs = Date.now();
    const cfg: AvailabilityScannerConfig = { ...DEFAULT_SCANNER_CONFIG, ...config };

    const isXRP = (c: string) => c.toUpperCase() === 'XRP';

    // ── Step 1: Issuer probes (only for issued currencies) ───────────────

    const issuerProbes: IssuerProbeResult[] = [];

    if (!isXRP(base.currency) && base.issuer) {
        issuerProbes.push(await probeIssuerAccount(client, base.issuer, base.currency));
    }
    if (!isXRP(quote.currency) && quote.issuer) {
        issuerProbes.push(await probeIssuerAccount(client, quote.issuer, quote.currency));
    }

    // ── Step 2: Trustline probes (if enabled and wallet available) ───────

    const trustlineProbes: TrustlineProbeResult[] = [];

    if (cfg.probeTrustlines && walletAddress) {
        if (!isXRP(base.currency) && base.issuer) {
            trustlineProbes.push(
                await probeTrustline(client, walletAddress, base.issuer, base.currency),
            );
        }
        if (!isXRP(quote.currency) && quote.issuer) {
            trustlineProbes.push(
                await probeTrustline(client, walletAddress, quote.issuer, quote.currency),
            );
        }
    }

    // ── Step 3: Order book probe (if enabled) ────────────────────────────

    let orderBookProbe: OrderBookProbeResult | null = null;

    if (cfg.probeOrderBooks) {
        orderBookProbe = await probeOrderBook(
            client,
            pairKey,
            base.currency,
            quote.currency,
            base.issuer,
            quote.issuer,
        );
    }

    // ── Step 4: Compute composite verdict ────────────────────────────────

    const { verdict, reasons, details } = computeAvailabilityVerdict(
        issuerProbes,
        trustlineProbes,
        orderBookProbe,
    );

    const endMs = Date.now();

    return {
        pairKey,
        verdict,
        reasons,
        details,
        issuerProbes,
        trustlineProbes,
        orderBookProbe,
        probedAtMs: endMs,
        probeDurationMs: endMs - startMs,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stateful Scanner Engine
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SCANNER_CONFIG: AvailabilityScannerConfig = {
    scanIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    probeTrustlines: true,
    probeOrderBooks: true,
    minDepthNotional: 0,
};

/**
 * AvailabilityScanner — stateful engine that periodically probes all
 * configured pairs and caches the results.
 *
 * Lifecycle:
 *   1. Construct with client getter and config
 *   2. Call addPair() for each pair to scan
 *   3. Call scanAll() to run a full scan (or scanOnePair() for targeted)
 *   4. Access results via getSnapshot() / getPairAvailability()
 *   5. Call reset() on pair switch, stop() on shutdown
 */
export class AvailabilityScanner {
    private readonly config: AvailabilityScannerConfig;
    private readonly results = new Map<string, PairAvailability>();
    private readonly pairs = new Map<string, { pairKey: string; base: PairSide; quote: PairSide }>();
    private scanCount = 0;
    private lastScanMs = 0;
    private lastScanDurationMs = 0;
    private running = false;
    private walletAddress: string | null = null;

    constructor(config: Partial<AvailabilityScannerConfig> = {}) {
        this.config = { ...DEFAULT_SCANNER_CONFIG, ...config };
    }

    /**
     * Set the wallet address for trustline probes.
     */
    setWalletAddress(address: string | null): void {
        this.walletAddress = address;
    }

    /**
     * Register a pair for periodic scanning.
     */
    addPair(pairKey: string, base: PairSide, quote: PairSide): void {
        this.pairs.set(pairKey, { pairKey, base, quote });
    }

    /**
     * Remove a pair from scanning.
     */
    removePair(pairKey: string): void {
        this.pairs.delete(pairKey);
        this.results.delete(pairKey);
    }

    /**
     * Run a full scan of all registered pairs.
     */
    async scanAll(client: Client): Promise<PairAvailability[]> {
        const startMs = Date.now();
        this.running = true;

        const results: PairAvailability[] = [];

        for (const [, entry] of this.pairs) {
            try {
                const result = await scanPairAvailability(
                    client,
                    entry.pairKey,
                    entry.base,
                    entry.quote,
                    this.walletAddress,
                    this.config,
                );
                this.results.set(entry.pairKey, result);
                results.push(result);
            } catch (err) {
                logger.warn({ err, pairKey: entry.pairKey }, 'Availability scan failed for pair');
                const errorResult: PairAvailability = {
                    pairKey: entry.pairKey,
                    verdict: 'UNKNOWN',
                    reasons: ['probe-error'],
                    details: [`Scan failed: ${err instanceof Error ? err.message : 'unknown error'}`],
                    issuerProbes: [],
                    trustlineProbes: [],
                    orderBookProbe: null,
                    probedAtMs: Date.now(),
                    probeDurationMs: Date.now() - startMs,
                };
                this.results.set(entry.pairKey, errorResult);
                results.push(errorResult);
            }
        }

        this.scanCount += 1;
        this.lastScanMs = Date.now();
        this.lastScanDurationMs = Date.now() - startMs;
        this.running = false;

        return results;
    }

    /**
     * Scan a single pair (targeted refresh).
     */
    async scanOnePair(client: Client, pairKey: string): Promise<PairAvailability | null> {
        const entry = this.pairs.get(pairKey);
        if (!entry) return null;

        const result = await scanPairAvailability(
            client,
            entry.pairKey,
            entry.base,
            entry.quote,
            this.walletAddress,
            this.config,
        );
        this.results.set(pairKey, result);
        return result;
    }

    /**
     * Check if a scan is needed based on the configured interval.
     */
    needsScan(): boolean {
        if (this.pairs.size === 0) return false;
        if (this.lastScanMs === 0) return true;
        return Date.now() - this.lastScanMs >= this.config.scanIntervalMs;
    }

    /**
     * Get the availability result for a specific pair.
     */
    getPairAvailability(pairKey: string): PairAvailability | null {
        return this.results.get(pairKey) ?? null;
    }

    /**
     * Get the verdict for a specific pair (convenience).
     */
    getVerdict(pairKey: string): AvailabilityVerdict {
        return this.results.get(pairKey)?.verdict ?? 'UNKNOWN';
    }

    /**
     * Check if a pair is tradeable (AVAILABLE or DEGRADED).
     */
    isTradeable(pairKey: string): boolean {
        const verdict = this.getVerdict(pairKey);
        return verdict === 'AVAILABLE' || verdict === 'DEGRADED';
    }

    /**
     * Check if a pair is blocked (BLOCKED or UNAVAILABLE).
     */
    isBlocked(pairKey: string): boolean {
        const verdict = this.getVerdict(pairKey);
        return verdict === 'BLOCKED' || verdict === 'UNAVAILABLE';
    }

    /**
     * Get full scanner state snapshot.
     */
    getSnapshot(): AvailabilityScannerSnapshot {
        return {
            pairs: Array.from(this.results.values()),
            running: this.running,
            scanCount: this.scanCount,
            lastScanMs: this.lastScanMs,
            lastScanDurationMs: this.lastScanDurationMs,
        };
    }

    /**
     * Reset all cached results (e.g., on pair switch).
     */
    reset(): void {
        this.results.clear();
        this.scanCount = 0;
        this.lastScanMs = 0;
        this.lastScanDurationMs = 0;
        this.running = false;
    }

    /**
     * Get the scanner configuration.
     */
    getConfig(): AvailabilityScannerConfig {
        return { ...this.config };
    }

    /**
     * Get the number of registered pairs.
     */
    getPairCount(): number {
        return this.pairs.size;
    }

    /**
     * Get all registered pair keys.
     */
    getRegisteredPairs(): string[] {
        return Array.from(this.pairs.keys());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load scanner configuration from environment variables.
 */
export function loadAvailabilityScannerConfig(): Partial<AvailabilityScannerConfig> {
    const toNumber = (val: string | undefined): number | undefined => {
        if (val === undefined) return undefined;
        const parsed = Number(val);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const config: Partial<AvailabilityScannerConfig> = {};

    const interval = toNumber(process.env.AVAILABILITY_SCAN_INTERVAL_MS);
    if (interval !== undefined) config.scanIntervalMs = interval;

    const timeout = toNumber(process.env.AVAILABILITY_REQUEST_TIMEOUT_MS);
    if (timeout !== undefined) config.requestTimeoutMs = timeout;

    if (process.env.AVAILABILITY_PROBE_TRUSTLINES === 'false') {
        config.probeTrustlines = false;
    }

    if (process.env.AVAILABILITY_PROBE_ORDERBOOKS === 'false') {
        config.probeOrderBooks = false;
    }

    const minDepth = toNumber(process.env.AVAILABILITY_MIN_DEPTH_NOTIONAL);
    if (minDepth !== undefined) config.minDepthNotional = minDepth;

    return config;
}
