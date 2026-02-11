export interface ScanSchedulerConfig {
    maxRps: number;
    tier1IntervalMs: number;
    tier2IntervalMs: number;
    maxBatchSize: number;
}

const DEFAULT_BATCH_SIZE = 3;

export class ScanScheduler {
    private readonly config: ScanSchedulerConfig;
    private tier1: string[] = [];
    private tier2: string[] = [];
    private tier1Cursor = 0;
    private tier2Cursor = 0;
    private nextDueByPair = new Map<string, number>();

    private tokens = 0;
    private lastRefillMs: number;

    constructor(config: Omit<ScanSchedulerConfig, 'maxBatchSize'> & Partial<Pick<ScanSchedulerConfig, 'maxBatchSize'>>) {
        this.config = {
            ...config,
            maxBatchSize: config.maxBatchSize ?? DEFAULT_BATCH_SIZE,
        };
        this.tokens = this.config.maxRps;
        this.lastRefillMs = Date.now();
    }

    setUniverse(tier1: string[], tier2: string[], nowMs: number = Date.now()): void {
        const uniqTier1 = dedupe(tier1);
        const uniqTier2 = dedupe(tier2.filter((pairKey) => !uniqTier1.includes(pairKey)));

        this.tier1 = uniqTier1;
        this.tier2 = uniqTier2;
        this.tier1Cursor = 0;
        this.tier2Cursor = 0;

        const next = new Map<string, number>();
        for (const pairKey of [...this.tier1, ...this.tier2]) {
            next.set(pairKey, this.nextDueByPair.get(pairKey) ?? nowMs);
        }
        this.nextDueByPair = next;
    }

    nextBatch(nowMs: number = Date.now()): string[] {
        this.refillTokens(nowMs);

        const hardBudget = Math.min(this.config.maxBatchSize, Math.floor(this.tokens));
        if (hardBudget <= 0) return [];

        const selected: string[] = [];
        for (let i = 0; i < hardBudget; i++) {
            const pick = this.pickDueMarket(nowMs, i % 2 === 0 ? 'tier1-first' : 'tier2-first');
            if (!pick) break;

            selected.push(pick.key);
            this.tokens = Math.max(0, this.tokens - 1);
            const intervalMs = pick.tier === 'tier1' ? this.config.tier1IntervalMs : this.config.tier2IntervalMs;
            this.nextDueByPair.set(pick.key, nowMs + intervalMs);
        }

        return selected;
    }

    getBudgetTokens(): number {
        return this.tokens;
    }

    private refillTokens(nowMs: number): void {
        if (nowMs <= this.lastRefillMs) return;
        const elapsedMs = nowMs - this.lastRefillMs;
        const refill = elapsedMs * (this.config.maxRps / 1000);
        this.tokens = Math.min(this.config.maxRps, this.tokens + refill);
        this.lastRefillMs = nowMs;
    }

    private pickDueMarket(
        nowMs: number,
        mode: 'tier1-first' | 'tier2-first',
    ): { key: string; tier: 'tier1' | 'tier2' } | null {
        const firstTier = mode === 'tier1-first' ? 'tier1' : 'tier2';
        const secondTier = firstTier === 'tier1' ? 'tier2' : 'tier1';

        const firstPick = this.pickFromTier(firstTier, nowMs);
        if (firstPick) return firstPick;

        return this.pickFromTier(secondTier, nowMs);
    }

    private pickFromTier(tier: 'tier1' | 'tier2', nowMs: number): { key: string; tier: 'tier1' | 'tier2' } | null {
        const list = tier === 'tier1' ? this.tier1 : this.tier2;
        if (list.length === 0) return null;

        const cursorRef = tier === 'tier1' ? 'tier1Cursor' : 'tier2Cursor';
        const start = this[cursorRef];

        for (let i = 0; i < list.length; i++) {
            const idx = (start + i) % list.length;
            const key = list[idx]!;
            const dueAtMs = this.nextDueByPair.get(key) ?? 0;
            if (dueAtMs > nowMs) continue;

            this[cursorRef] = (idx + 1) % list.length;
            return { key, tier };
        }

        return null;
    }
}

function dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
