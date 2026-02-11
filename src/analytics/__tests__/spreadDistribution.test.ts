import { describe, it, expect } from 'vitest';
import { SpreadDistributionSampler, computeSpreadBps } from '../spreadDistribution';

function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)] ?? null;
}

describe('SpreadDistributionSampler', () => {
    it('computes spread bps from best bid/ask', () => {
        const spread = computeSpreadBps(100, 101);
        expect(spread).not.toBeNull();
        expect(spread!).toBeCloseTo(99.5, 2);
    });

    it('ages out samples beyond the baseline window', () => {
        const sampler = new SpreadDistributionSampler({ baselineDays: 1 / 24, computeIntervalMs: 0, maxSamples: 10 });
        const now = 1_000_000;
        sampler.ingest(100, 101, now - 3_700_000);
        sampler.ingest(100, 101, now - 1_000);

        const snapshot = sampler.getSnapshot(now);
        expect(snapshot).not.toBeNull();
        expect(snapshot!.baselineMultiDay.sampleCount).toBe(1);
        expect(snapshot!.lookback24h.sampleCount).toBe(1);
    });

    it('computes rolling percentiles for known data', () => {
        const sampler = new SpreadDistributionSampler({ baselineDays: 1, computeIntervalMs: 0, maxSamples: 10 });
        const now = 2_000_000;
        const inputs = [
            { bid: 100, ask: 101 },
            { bid: 100, ask: 102 },
            { bid: 100, ask: 103 },
            { bid: 100, ask: 104 },
        ];

        const spreads: number[] = [];
        inputs.forEach((input, idx) => {
            const ts = now + idx * 10;
            sampler.ingest(input.bid, input.ask, ts);
            const spread = computeSpreadBps(input.bid, input.ask);
            if (spread !== null) spreads.push(spread);
        });

        const snapshot = sampler.getSnapshot(now + 100);
        const sorted = [...spreads].sort((a, b) => a - b);
        const expectedMedian = percentile(sorted, 50);
        const expectedP75 = percentile(sorted, 75);
        const expectedP90 = percentile(sorted, 90);

        expect(snapshot).not.toBeNull();
        expect(snapshot!.lookback24h.medianBps).toBeCloseTo(expectedMedian ?? 0, 6);
        expect(snapshot!.lookback24h.p75Bps).toBeCloseTo(expectedP75 ?? 0, 6);
        expect(snapshot!.lookback24h.p90Bps).toBeCloseTo(expectedP90 ?? 0, 6);
    });
});
