import fetch, { HeadersInit } from 'node-fetch';
import { marketLog as logger } from '../../analytics/logger';
import type { Instrument, CurrencySide } from '../instrumentRegistry/schema';

const XRPSCAN_URL = 'https://api.xrpscan.com/api/v1/tokens';
const XRPL_CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export interface DiscoveryToken {
    currency: string;
    issuer: string;
}

export interface LiquidityEdge {
    base: CurrencySide;
    quote: CurrencySide;
    liquidityUsd: number;
    volumeUsd24h: number;
    source: string;
}

interface CacheEntry<T> {
    value: T;
    expiresAtMs: number;
}

export interface XrplDiscoveryConfig {
    enabled: boolean;
    minLiquidityUsd: number;
    minVolumeUsd: number;
    maxRuntimeMs: number;
    xrpscanTtlMs: number;
    maxConcurrency: number;
}

export const DEFAULT_XRPL_DISCOVERY_CONFIG: XrplDiscoveryConfig = {
    enabled: false,
    minLiquidityUsd: 50_000,
    minVolumeUsd: 10_000,
    maxRuntimeMs: 3000,
    xrpscanTtlMs: 300_000,
    maxConcurrency: 5,
};

type FetchFn = (url: string, init?: { headers?: HeadersInit; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

class ConcurrencyLimiter {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly maxConcurrency: number) { }

    async run<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.maxConcurrency) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(() => {
                this.active += 1;
                resolve();
            });
        });
    }

    private release(): void {
        this.active = Math.max(0, this.active - 1);
        const next = this.queue.shift();
        if (next) next();
    }
}

export class XrplDiscoveryService {
    private readonly cfg: XrplDiscoveryConfig;
    private readonly limiter: ConcurrencyLimiter;
    private readonly fetchFn: FetchFn;
    private tokenCache: CacheEntry<DiscoveryToken[]> | null = null;

    constructor(config: Partial<XrplDiscoveryConfig> = {}, deps?: { fetchFn?: FetchFn }) {
        this.cfg = { ...DEFAULT_XRPL_DISCOVERY_CONFIG, ...config };
        this.limiter = new ConcurrencyLimiter(Math.max(1, this.cfg.maxConcurrency));
        this.fetchFn = deps?.fetchFn ?? (fetch as unknown as FetchFn);
    }

    async discoverPairs(): Promise<Instrument[]> {
        if (!this.cfg.enabled) return [];
        const startedAtMs = Date.now();

        try {
            const pairs = await withTimeout(this.discoverPairsInternal(), this.cfg.maxRuntimeMs);
            const durationMs = Date.now() - startedAtMs;
            logger.info({ metric: 'xrpl.discovery.duration_ms', value: durationMs }, 'XRPL discovery duration');
            return pairs;
        } catch (err) {
            logger.warn({ err }, 'XRPL discovery failed, using empty discovery set');
            logger.info({ metric: 'xrpl.discovery.duration_ms', value: Date.now() - startedAtMs }, 'XRPL discovery duration');
            return [];
        }
    }

    private async discoverPairsInternal(): Promise<Instrument[]> {
        const tokenUniverse = await this.loadTokenUniverse();
        if (tokenUniverse.length === 0) return [];

        // External pool source removed: no external pool edges are loaded.
        // Discovery safely degrades to empty set while scanner continues on existing pairs.
        const edges = await this.loadLiquidityEdgesNoop();
        const pairs = generatePairsFromEdges(edges);
        logger.info({ metric: 'xrpl.pools.loaded', value: 0 }, 'XRPL discovery liquidity edges loaded');
        logger.info({ metric: 'xrpl.pairs.generated', value: pairs.length }, 'XRPL discovery pairs generated');
        return pairs;
    }

    private async loadTokenUniverse(): Promise<DiscoveryToken[]> {
        const nowMs = Date.now();
        if (this.tokenCache && this.tokenCache.expiresAtMs > nowMs) {
            return this.tokenCache.value;
        }

        const previous = this.tokenCache?.value ?? [];
        try {
            const tokens = await fetchXrpscanTokens({
                fetchJson: async (url) => this.fetchJson(url),
                pageSize: 200,
            });
            this.tokenCache = {
                value: tokens,
                expiresAtMs: nowMs + this.cfg.xrpscanTtlMs,
            };
            logger.info({ metric: 'xrpl.tokens.loaded', value: tokens.length }, 'XRPL discovery token universe loaded');
            return tokens;
        } catch (err) {
            logger.warn({ err }, 'XRPL token universe fetch failed, using cache fallback');
            return previous;
        }
    }

    private async loadLiquidityEdgesNoop(): Promise<LiquidityEdge[]> {
        return [];
    }

    private async fetchJson(url: string, headers?: HeadersInit): Promise<unknown> {
        return this.limiter.run(async () => {
            const init = headers ? { headers } : undefined;
            const response = await this.fetchFn(url, init);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${url}`);
            }
            return response.json();
        });
    }
}

export async function fetchXrpscanTokens(params: {
    fetchJson: (url: string) => Promise<unknown>;
    pageSize: number;
}): Promise<DiscoveryToken[]> {
    const tokens: DiscoveryToken[] = [];
    let offset = 0;

    while (true) {
        const url = `${XRPSCAN_URL}?limit=${params.pageSize}&sort=score&offset=${offset}`;
        const payload = await params.fetchJson(url);
        const page = normalizeXrpscanTokens(payload);
        if (page.length === 0) break;

        tokens.push(...page);
        if (page.length < params.pageSize) break;
        offset += params.pageSize;
    }

    return dedupeTokens(tokens);
}

export function normalizeXrpscanTokens(payload: unknown): DiscoveryToken[] {
    const records = Array.isArray(payload) ? payload : [];
    const tokens: DiscoveryToken[] = [];
    for (const row of records) {
        if (!row || typeof row !== 'object') continue;
        const currencyRaw = (row as { currency?: unknown }).currency;
        const issuerRaw = (row as { issuer?: unknown }).issuer;
        const currency = typeof currencyRaw === 'string' ? currencyRaw.trim().toUpperCase() : '';
        const issuer = typeof issuerRaw === 'string' ? issuerRaw.trim() : '';
        if (!currency || !issuer || !XRPL_CLASSIC_ADDRESS.test(issuer)) continue;
        tokens.push({ currency, issuer });
    }
    return dedupeTokens(tokens);
}

export function generatePairsFromEdges(edges: readonly LiquidityEdge[]): Instrument[] {
    const nowIso = new Date().toISOString();
    const ranked = [...edges].sort((a, b) =>
        b.liquidityUsd - a.liquidityUsd || b.volumeUsd24h - a.volumeUsd24h,
    );

    const pairs: Instrument[] = [];
    const signatures = new Set<string>();
    for (const edge of ranked) {
        const hasBaseXrp = edge.base.currency.toUpperCase() === 'XRP';
        const hasQuoteXrp = edge.quote.currency.toUpperCase() === 'XRP';
        if (!hasBaseXrp && !hasQuoteXrp) continue;

        const quote = hasBaseXrp ? edge.quote : edge.base;
        if (quote.currency.toUpperCase() === 'XRP') continue;
        if (!quote.issuer || !XRPL_CLASSIC_ADDRESS.test(quote.issuer)) continue;

        const pair: Instrument = {
            key: `XRP/${quote.currency.toUpperCase()}`,
            base: { currency: 'XRP' },
            quote: { currency: quote.currency.toUpperCase(), issuer: quote.issuer },
            description: `XRP/${quote.currency.toUpperCase()} (discovered)`,
            liquidity: 'unknown',
            network: 'mainnet',
            status: 'active',
            sortOrder: 999,
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        const sig = instrumentSignature(pair);
        if (signatures.has(sig)) continue;
        signatures.add(sig);
        pairs.push(pair);
    }

    return pairs;
}

export function instrumentSignature(inst: Instrument): string {
    return [
        inst.base.currency.toUpperCase(),
        (inst.base.issuer ?? '').toUpperCase(),
        inst.quote.currency.toUpperCase(),
        (inst.quote.issuer ?? '').toUpperCase(),
    ].join('|');
}

function dedupeTokens(tokens: readonly DiscoveryToken[]): DiscoveryToken[] {
    const map = new Map<string, DiscoveryToken>();
    for (const token of tokens) {
        const key = `${token.currency.toUpperCase()}|${token.issuer}`;
        if (!map.has(key)) {
            map.set(key, { currency: token.currency.toUpperCase(), issuer: token.issuer });
        }
    }
    return [...map.values()];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout:${timeoutMs}ms`)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }).catch((err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
