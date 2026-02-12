import type { Client, BookOffer, Currency } from 'xrpl';
import { marketLog as logger } from '../../analytics/logger';
import { getInstruments } from '../instrumentRegistry';
import type { Instrument } from '../instrumentRegistry/schema';
import type { AvailabilityScannerSnapshot, AvailabilityVerdict } from '../availabilityScanner';
import { toXrplCurrency } from '../../xrpl/currency';
import { computeFairValue } from './fairValueModel';
import { ScanScheduler } from './scanScheduler';
import {
    XrplDiscoveryService,
    DEFAULT_XRPL_DISCOVERY_CONFIG,
    instrumentSignature,
} from './xrplDiscoveryService';
import {
    BackgroundScannerBestPairScore,
    BackgroundScannerConfig,
    BackgroundScannerMarketSnapshot,
    BackgroundScannerSnapshot,
    DEFAULT_BACKGROUND_SCANNER_CONFIG,
} from './types';

export interface BackgroundMarketScannerDeps {
    client: Client;
    getCurrentPairKey: () => string;
    getCurrentMidPrice: () => number | null;
    getAvailabilitySnapshot: () => AvailabilityScannerSnapshot | null;
    isPaused: () => boolean;
    onSnapshot: (pairKey: string, snapshot: BackgroundScannerSnapshot) => void;
}

interface MarketUniverse {
    pairByKey: Map<string, Instrument>;
    tier1: string[];
    tier2: string[];
}

const STABLE_QUOTES = new Set(['USDC', 'USD', 'EUR', 'RLUSD', 'USDT', 'USDP', 'USDB', 'GBP']);
const TIER1_ANCHOR_KEYS = ['XRP/USDC', 'XRP/USD', 'XRP/EUR'] as const;

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

export class BackgroundMarketScanner {
    private readonly deps: BackgroundMarketScannerDeps;
    private readonly config: BackgroundScannerConfig;
    private readonly scheduler: ScanScheduler;
    private readonly discoveryService: XrplDiscoveryService | null;

    private running = false;
    private inFlight = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastUniverseRefreshMs = 0;
    private universe: MarketUniverse = { pairByKey: new Map(), tier1: [], tier2: [] };

    private markets = new Map<string, BackgroundScannerMarketSnapshot>();
    private health = {
        score: 100,
        lastOkAtMs: null as number | null,
        lastErrorAtMs: null as number | null,
        consecutiveFailures: 0,
        lastError: undefined as string | undefined,
    };

    constructor(deps: BackgroundMarketScannerDeps, config: Partial<BackgroundScannerConfig> = {}) {
        this.deps = deps;
        this.config = { ...DEFAULT_BACKGROUND_SCANNER_CONFIG, ...config };
        this.scheduler = new ScanScheduler({
            maxRps: this.config.maxRps,
            tier1IntervalMs: this.config.tier1IntervalMs,
            tier2IntervalMs: this.config.tier2IntervalMs,
            maxBatchSize: 3,
        });
        this.discoveryService = this.config.discoveryEnabled
            ? new XrplDiscoveryService({
                ...DEFAULT_XRPL_DISCOVERY_CONFIG,
                enabled: true,
                minLiquidityUsd: this.config.discoveryMinLiquidityUsd ?? DEFAULT_XRPL_DISCOVERY_CONFIG.minLiquidityUsd,
                minVolumeUsd: this.config.discoveryMinVolumeUsd ?? DEFAULT_XRPL_DISCOVERY_CONFIG.minVolumeUsd,
                maxRuntimeMs: this.config.discoveryMaxRuntimeMs ?? DEFAULT_XRPL_DISCOVERY_CONFIG.maxRuntimeMs,
            })
            : null;
    }

    start(): void {
        if (!this.config.enabled || this.running) return;

        this.running = true;
        void this.refreshUniverse(Date.now());
        this.timer = setInterval(() => {
            void this.pulse();
        }, 250);
        if (this.timer && typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    reset(): void {
        this.stop();
        this.markets.clear();
        this.health = {
            score: 100,
            lastOkAtMs: null,
            lastErrorAtMs: null,
            consecutiveFailures: 0,
            lastError: undefined,
        };
        this.universe = { pairByKey: new Map(), tier1: [], tier2: [] };
        this.lastUniverseRefreshMs = 0;
    }

    private async pulse(): Promise<void> {
        if (!this.running || this.inFlight) return;
        if (this.deps.isPaused()) return;

        this.inFlight = true;
        const nowMs = Date.now();

        try {
            if (nowMs - this.lastUniverseRefreshMs > 30_000) {
                await this.refreshUniverse(nowMs);
            }

            const due = this.scheduler.nextBatch(nowMs);
            if (due.length === 0) {
                return;
            }

            const scanResults = await Promise.allSettled(due.map(async (pairKey) => {
                const instrument = this.universe.pairByKey.get(pairKey);
                if (!instrument) return;
                const verdict = this.getVerdict(pairKey);
                const snapshot = await this.fetchPairSnapshot(instrument, verdict, nowMs);
                this.markets.set(pairKey, snapshot);
            }));

            const failures = scanResults.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
            if (failures.length === due.length) {
                const reason = failures[0]?.reason;
                this.markFailure(reason instanceof Error ? reason.message : String(reason ?? 'scan failure'));
            } else {
                this.markSuccess();
                if (failures.length > 0) {
                    const reason = failures[0]?.reason;
                    this.health.lastErrorAtMs = nowMs;
                    this.health.lastError = reason instanceof Error ? reason.message : String(reason ?? 'scan failure');
                }
            }

            const snapshot = this.buildSnapshot(nowMs);
            const pairKey = this.deps.getCurrentPairKey();
            this.deps.onSnapshot(pairKey, snapshot);
        } catch (err) {
            this.markFailure(err instanceof Error ? err.message : 'background scanner pulse failed');
            logger.warn({ err }, 'Background scanner pulse failed');
        } finally {
            this.inFlight = false;
        }
    }

    private async refreshUniverse(nowMs: number): Promise<void> {
        const availability = this.deps.getAvailabilitySnapshot();
        const verdictByPair = new Map<string, AvailabilityVerdict>();
        for (const item of availability?.pairs ?? []) {
            verdictByPair.set(item.pairKey, item.verdict);
        }

        const existingPairs = getInstruments()
            .filter((instrument) => instrument.base.currency.toUpperCase() === 'XRP')
            .map((instrument) => ({ ...instrument }));

        const discoveredPairs = this.discoveryService
            ? await this.discoveryService.discoverPairs()
            : [];

        const merged = this.unionPairs(existingPairs, discoveredPairs);
        const allXrpPairs = merged.filter((instrument) => this.isTradeableByAvailability(instrument.key, verdictByPair));

        const pairByKey = new Map(allXrpPairs.map((instrument) => [instrument.key, instrument]));

        const tier1: string[] = [];
        for (const key of TIER1_ANCHOR_KEYS) {
            if (pairByKey.has(key)) {
                tier1.push(key);
            }
        }

        if (tier1.length < 3) {
            const fallbackAnchors = allXrpPairs
                .filter((instrument) => STABLE_QUOTES.has(instrument.quote.currency.toUpperCase()))
                .map((instrument) => instrument.key)
                .filter((key) => !tier1.includes(key));
            for (const key of fallbackAnchors) {
                if (tier1.length >= 3) break;
                tier1.push(key);
            }
        }

        const byLiquidity = [...allXrpPairs]
            .sort((a, b) => liquidityRank(a.liquidity) - liquidityRank(b.liquidity) || a.key.localeCompare(b.key))
            .map((instrument) => instrument.key)
            .filter((key) => !tier1.includes(key));

        const maxMarkets = Math.max(1, this.config.maxMarkets);
        const remainingSlots = Math.max(0, maxMarkets - tier1.length);
        const tier2 = byLiquidity.slice(0, remainingSlots);

        this.universe = { pairByKey, tier1, tier2 };
        this.scheduler.setUniverse(tier1, tier2, nowMs);
        this.lastUniverseRefreshMs = nowMs;
    }

    private isTradeableByAvailability(pairKey: string, verdictByPair: Map<string, AvailabilityVerdict>): boolean {
        const verdict = verdictByPair.get(pairKey);
        if (!verdict) return true;
        return verdict === 'AVAILABLE' || verdict === 'DEGRADED';
    }

    private unionPairs(existing: readonly Instrument[], discovered: readonly Instrument[]): Instrument[] {
        if (discovered.length === 0) return [...existing];

        const bySignature = new Map<string, Instrument>();
        for (const inst of existing) {
            bySignature.set(instrumentSignature(inst), inst);
        }

        for (const inst of discovered) {
            const signature = instrumentSignature(inst);
            if (bySignature.has(signature)) continue;
            bySignature.set(signature, inst);
        }

        const byKey = new Map<string, Instrument>();
        for (const inst of bySignature.values()) {
            if (!byKey.has(inst.key)) {
                byKey.set(inst.key, inst);
            } else {
                logger.debug({ pairKey: inst.key }, 'Skipping discovered pair due to key collision');
            }
        }
        return [...byKey.values()];
    }

    private getVerdict(pairKey: string): AvailabilityVerdict | 'UNKNOWN' {
        const snapshot = this.deps.getAvailabilitySnapshot();
        return snapshot?.pairs.find((entry) => entry.pairKey === pairKey)?.verdict ?? 'UNKNOWN';
    }

    private async fetchPairSnapshot(
        instrument: Instrument,
        verdict: AvailabilityVerdict | 'UNKNOWN',
        nowMs: number,
    ): Promise<BackgroundScannerMarketSnapshot> {
        const common = { ledger_index: 'validated' as const, limit: 10 };
        const baseCurr = instrument.base.currency.toUpperCase() === 'XRP'
            ? { currency: 'XRP' }
            : toXrplCurrency({ currency: instrument.base.currency, issuer: instrument.base.issuer! });
        const quoteCurr = instrument.quote.currency.toUpperCase() === 'XRP'
            ? { currency: 'XRP' }
            : toXrplCurrency({ currency: instrument.quote.currency, issuer: instrument.quote.issuer! });

        const [bidsRes, asksRes] = await Promise.all([
            this.withTimeout(
                this.deps.client.request({
                    command: 'book_offers',
                    taker_gets: quoteCurr as Currency,
                    taker_pays: baseCurr as Currency,
                    ...common,
                }),
                this.config.requestTimeoutMs,
                `${instrument.key}:bid-timeout`,
            ),
            this.withTimeout(
                this.deps.client.request({
                    command: 'book_offers',
                    taker_gets: baseCurr as Currency,
                    taker_pays: quoteCurr as Currency,
                    ...common,
                }),
                this.config.requestTimeoutMs,
                `${instrument.key}:ask-timeout`,
            ),
        ]);

        const bids = (bidsRes.result?.offers ?? []) as BookOffer[];
        const asks = (asksRes.result?.offers ?? []) as BookOffer[];

        const normalizedBids = bids.map((offer) => {
            const quoteAmount = toAmount((offer as any).TakerGets);
            const baseAmount = toAmount((offer as any).TakerPays);
            const price = baseAmount > 0 ? quoteAmount / baseAmount : 0;
            const notional = baseAmount * price;
            return { price, notional };
        }).filter((row) => row.price > 0 && Number.isFinite(row.price));

        const normalizedAsks = asks.map((offer) => {
            const baseAmount = toAmount((offer as any).TakerGets);
            const quoteAmount = toAmount((offer as any).TakerPays);
            const price = baseAmount > 0 ? quoteAmount / baseAmount : 0;
            const notional = baseAmount * price;
            return { price, notional };
        }).filter((row) => row.price > 0 && Number.isFinite(row.price));

        normalizedBids.sort((a, b) => b.price - a.price);
        normalizedAsks.sort((a, b) => a.price - b.price);

        const bid = normalizedBids[0]?.price ?? 0;
        const ask = normalizedAsks[0]?.price ?? 0;
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid || ask || 0);
        const spreadBps = bid > 0 && ask > 0
            ? Math.max(0, ((ask - bid) / ask) * 10_000)
            : 0;
        const depthTopNotional =
            normalizedBids.slice(0, 5).reduce((sum, row) => sum + row.notional, 0)
            + normalizedAsks.slice(0, 5).reduce((sum, row) => sum + row.notional, 0);

        return {
            bid,
            ask,
            mid,
            spreadBps,
            depthTopNotional,
            updatedAtMs: nowMs,
            stalenessMs: 0,
            verdict,
        };
    }

    private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(timeoutLabel));
            }, timeoutMs);

            promise.then((result) => {
                clearTimeout(timer);
                resolve(result);
            }).catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    private markSuccess(): void {
        this.health.lastOkAtMs = Date.now();
        this.health.consecutiveFailures = 0;
        const stalePenalty = this.computeStalePenalty(this.health.lastOkAtMs);
        this.health.score = clamp(100 - stalePenalty, 0, 100);
    }

    private markFailure(reason: string): void {
        this.health.lastErrorAtMs = Date.now();
        this.health.lastError = reason;
        this.health.consecutiveFailures += 1;
        const failurePenalty = Math.min(70, this.health.consecutiveFailures * 15);
        const stalePenalty = this.computeStalePenalty(Date.now());
        this.health.score = clamp(100 - failurePenalty - stalePenalty, 0, 100);
    }

    private computeStalePenalty(nowMs: number): number {
        let maxStalenessMs = 0;
        for (const market of this.markets.values()) {
            const staleness = nowMs - market.updatedAtMs;
            if (staleness > maxStalenessMs) maxStalenessMs = staleness;
        }
        if (maxStalenessMs <= this.config.maxStalenessMs) return 0;
        return clamp((maxStalenessMs - this.config.maxStalenessMs) / 1000, 0, 30);
    }

    private buildSnapshot(nowMs: number): BackgroundScannerSnapshot {
        const markets: Record<string, BackgroundScannerMarketSnapshot> = {};
        const allMarkets = [...this.markets.entries()];
        for (const [pairKey, market] of allMarkets) {
            markets[pairKey] = {
                ...market,
                stalenessMs: Math.max(0, nowMs - market.updatedAtMs),
            };
        }

        const anchors = this.universe.tier1
            .map((pairKey) => ({ pairKey, market: markets[pairKey] }))
            .filter((entry): entry is { pairKey: string; market: BackgroundScannerMarketSnapshot } => !!entry.market)
            .map((entry) => ({
                pairKey: entry.pairKey,
                mid: entry.market.mid,
                spreadBps: entry.market.spreadBps,
                stalenessMs: entry.market.stalenessMs,
                verdict: entry.market.verdict,
            }));

        const fairValue = computeFairValue(anchors, {
            maxStalenessMs: this.config.maxStalenessMs,
        });

        const currentMid = this.deps.getCurrentMidPrice();
        if (fairValue.xrpMid && currentMid && currentMid > 0) {
            fairValue.divergenceBpsVsXrpRlusd = ((currentMid - fairValue.xrpMid) / fairValue.xrpMid) * 10_000;
        }

        const marketValues = Object.values(markets);
        const avgDepth = marketValues.length > 0
            ? marketValues.reduce((sum, market) => sum + market.depthTopNotional, 0) / marketValues.length
            : 0;
        const avgSpread = marketValues.length > 0
            ? marketValues.reduce((sum, market) => sum + market.spreadBps, 0) / marketValues.length
            : 0;

        const mids = marketValues.map((market) => market.mid).filter((mid) => mid > 0);
        const meanMid = mids.length > 0 ? mids.reduce((sum, value) => sum + value, 0) / mids.length : 0;
        const variance = mids.length > 1 && meanMid > 0
            ? mids.reduce((sum, value) => sum + ((value - meanMid) ** 2), 0) / mids.length
            : 0;
        const cv = meanMid > 0 ? Math.sqrt(variance) / meanMid : 0;

        const liquidityScore = clamp(Math.round((Math.log10(Math.max(1, avgDepth)) * 18) - (avgSpread * 0.15)), 0, 100);
        const volatilityScore = clamp(Math.round(cv * 500), 0, 100);

        const notes: string[] = [];
        notes.push(`anchors:${anchors.length}`);
        notes.push(`markets:${marketValues.length}`);
        if (fairValue.xrpMid === null) {
            notes.push('fair-value-insufficient-data');
        }
        if (this.health.consecutiveFailures > 0) {
            notes.push(`scanner-failures:${this.health.consecutiveFailures}`);
        }
        const bestPairs = this.rankBestPairs(markets);

        return {
            asOfMs: nowMs,
            health: this.toHealthSnapshot(),
            fairValue,
            crossMarket: {
                liquidityScore,
                volatilityScore,
                notes,
                bestPairs,
            },
            markets,
        };
    }

    private rankBestPairs(markets: Record<string, BackgroundScannerMarketSnapshot>): BackgroundScannerBestPairScore[] {
        const ranked = Object.entries(markets).map(([pairKey, market]) => {
            const spreadScore = clamp(100 - (Math.min(500, market.spreadBps) / 5), 0, 100);
            const depthScore = clamp(Math.log10(Math.max(1, market.depthTopNotional) + 1) * 20, 0, 100);
            const staleRatio = this.config.maxStalenessMs > 0
                ? market.stalenessMs / this.config.maxStalenessMs
                : 1;
            const freshnessScore = clamp(100 - (staleRatio * 100), 0, 100);
            const verdictWeight = this.bestPairVerdictWeight(market.verdict);
            const rawScore = (spreadScore * 0.4) + (depthScore * 0.35) + (freshnessScore * 0.25);
            const score = clamp(Math.round(rawScore * verdictWeight), 0, 100);

            return {
                pairKey,
                score,
                spreadBps: market.spreadBps,
                depthTopNotional: market.depthTopNotional,
                stalenessMs: market.stalenessMs,
                verdict: market.verdict,
            };
        });

        ranked.sort((a, b) => b.score - a.score || a.spreadBps - b.spreadBps || b.depthTopNotional - a.depthTopNotional || a.pairKey.localeCompare(b.pairKey));
        return ranked.slice(0, 5);
    }

    private bestPairVerdictWeight(verdict: AvailabilityVerdict | 'UNKNOWN'): number {
        if (verdict === 'AVAILABLE') return 1;
        if (verdict === 'DEGRADED') return 0.7;
        if (verdict === 'UNKNOWN') return 0.5;
        return 0.35;
    }

    private toHealthSnapshot(): BackgroundScannerSnapshot['health'] {
        if (this.health.lastError) {
            return {
                score: this.health.score,
                lastOkAtMs: this.health.lastOkAtMs,
                lastErrorAtMs: this.health.lastErrorAtMs,
                consecutiveFailures: this.health.consecutiveFailures,
                lastError: this.health.lastError,
            };
        }
        return {
            score: this.health.score,
            lastOkAtMs: this.health.lastOkAtMs,
            lastErrorAtMs: this.health.lastErrorAtMs,
            consecutiveFailures: this.health.consecutiveFailures,
        };
    }
}

function liquidityRank(level: Instrument['liquidity']): number {
    switch (level) {
        case 'high': return 0;
        case 'medium': return 1;
        case 'low': return 2;
        case 'unknown':
        default:
            return 3;
    }
}

function toAmount(value: unknown): number {
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed / 1_000_000 : 0;
    }
    if (typeof value === 'object' && value !== null) {
        const candidate = Number((value as { value?: string }).value ?? 0);
        return Number.isFinite(candidate) ? candidate : 0;
    }
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
}
