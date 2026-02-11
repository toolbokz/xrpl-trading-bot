export interface SpreadDistributionStats {
    sampleCount: number;
    medianBps: number | null;
    p75Bps: number | null;
    p90Bps: number | null;
}

export interface SpreadDistributionSnapshot {
    pair?: string | undefined;
    updatedAtMs: number;
    lookback24h: SpreadDistributionStats;
    baselineMultiDay: SpreadDistributionStats & { days: number };
}

export interface SpreadDistributionOptions {
    baselineDays?: number;
    computeIntervalMs?: number;
    maxSamples?: number;
}

const DEFAULT_BASELINE_DAYS = 3;
const DEFAULT_COMPUTE_INTERVAL_MS = 10_000;
const DEFAULT_MAX_SAMPLES = 70_000;
const MS_PER_DAY = 86_400_000;

class TimeSeriesRingBuffer {
    private readonly capacity: number;
    private readonly timestamps: number[];
    private readonly values: number[];
    private start = 0;
    private size = 0;

    constructor(capacity: number) {
        this.capacity = Math.max(1, capacity);
        this.timestamps = new Array(this.capacity);
        this.values = new Array(this.capacity);
    }

    push(timestamp: number, value: number): void {
        if (this.size < this.capacity) {
            const idx = (this.start + this.size) % this.capacity;
            this.timestamps[idx] = timestamp;
            this.values[idx] = value;
            this.size += 1;
            return;
        }

        this.timestamps[this.start] = timestamp;
        this.values[this.start] = value;
        this.start = (this.start + 1) % this.capacity;
    }

    prune(cutoffMs: number): void {
        while (this.size > 0) {
            const ts = this.timestamps[this.start];
            if (ts === undefined || ts >= cutoffMs) break;
            this.start = (this.start + 1) % this.capacity;
            this.size -= 1;
        }
    }

    valuesSince(cutoffMs: number): number[] {
        const result: number[] = [];
        for (let i = 0; i < this.size; i += 1) {
            const idx = (this.start + i) % this.capacity;
            const ts = this.timestamps[idx];
            const val = this.values[idx];
            if (ts !== undefined && val !== undefined && ts >= cutoffMs) {
                result.push(val);
            }
        }
        return result;
    }

    clear(): void {
        this.start = 0;
        this.size = 0;
    }

    getSize(): number {
        return this.size;
    }
}

export function computeSpreadBps(bestBid: number, bestAsk: number): number | null {
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
    if (bestBid <= 0 || bestAsk <= 0) return null;
    if (bestAsk < bestBid) return null;
    const mid = (bestBid + bestAsk) / 2;
    if (mid <= 0) return null;
    return ((bestAsk - bestBid) / mid) * 10_000;
}

function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)] ?? null;
}

function buildStats(values: number[]): SpreadDistributionStats {
    if (values.length === 0) {
        return {
            sampleCount: 0,
            medianBps: null,
            p75Bps: null,
            p90Bps: null,
        };
    }

    const sorted = [...values].sort((a, b) => a - b);
    return {
        sampleCount: sorted.length,
        medianBps: percentile(sorted, 50),
        p75Bps: percentile(sorted, 75),
        p90Bps: percentile(sorted, 90),
    };
}

export class SpreadDistributionSampler {
    private readonly baselineDays: number;
    private readonly computeIntervalMs: number;
    private readonly maxSamples: number;
    private readonly buffer: TimeSeriesRingBuffer;
    private lastComputedMs = 0;
    private latestSnapshot: SpreadDistributionSnapshot | null = null;
    private pairKey: string | null = null;

    constructor(options: SpreadDistributionOptions = {}) {
        this.baselineDays = options.baselineDays ?? DEFAULT_BASELINE_DAYS;
        this.computeIntervalMs = options.computeIntervalMs ?? DEFAULT_COMPUTE_INTERVAL_MS;
        this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
        this.buffer = new TimeSeriesRingBuffer(this.maxSamples);
    }

    setPairKey(pairKey: string | null): void {
        this.pairKey = pairKey;
    }

    ingest(bestBid: number, bestAsk: number, nowMs: number = Date.now()): void {
        const spreadBps = computeSpreadBps(bestBid, bestAsk);
        if (spreadBps === null || !Number.isFinite(spreadBps)) return;
        this.buffer.push(nowMs, spreadBps);
        this.buffer.prune(this.getBaselineCutoff(nowMs));
    }

    maybeCompute(nowMs: number = Date.now()): SpreadDistributionSnapshot | null {
        if (!this.latestSnapshot || (nowMs - this.lastComputedMs) >= this.computeIntervalMs) {
            return this.compute(nowMs);
        }
        return this.latestSnapshot;
    }

    getSnapshot(nowMs: number = Date.now()): SpreadDistributionSnapshot | null {
        if (!this.latestSnapshot) return this.compute(nowMs);
        if ((nowMs - this.lastComputedMs) > this.computeIntervalMs * 2) {
            return this.compute(nowMs);
        }
        return this.latestSnapshot;
    }

    reset(): void {
        this.buffer.clear();
        this.lastComputedMs = 0;
        this.latestSnapshot = null;
    }

    getSampleCount(): number {
        return this.buffer.getSize();
    }

    private compute(nowMs: number): SpreadDistributionSnapshot {
        const cutoff24h = nowMs - 24 * 60 * 60 * 1000;
        const cutoffBaseline = this.getBaselineCutoff(nowMs);
        this.buffer.prune(cutoffBaseline);

        const lookback24hValues = this.buffer.valuesSince(cutoff24h);
        const baselineValues = this.buffer.valuesSince(cutoffBaseline);

        const snapshot: SpreadDistributionSnapshot = {
            pair: this.pairKey ?? undefined,
            updatedAtMs: nowMs,
            lookback24h: buildStats(lookback24hValues),
            baselineMultiDay: {
                ...buildStats(baselineValues),
                days: this.baselineDays,
            },
        };

        this.latestSnapshot = snapshot;
        this.lastComputedMs = nowMs;
        return snapshot;
    }

    private getBaselineCutoff(nowMs: number): number {
        return nowMs - (this.baselineDays * MS_PER_DAY);
    }
}
