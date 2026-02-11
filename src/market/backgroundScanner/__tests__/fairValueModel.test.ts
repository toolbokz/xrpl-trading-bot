import { describe, expect, it } from 'vitest';
import { computeFairValue } from '../fairValueModel';

describe('computeFairValue', () => {
    it('rejects stale and outlier anchors', () => {
        const result = computeFairValue([
            { pairKey: 'XRP/USDC', mid: 1.0, spreadBps: 8, stalenessMs: 500, verdict: 'AVAILABLE' },
            { pairKey: 'XRP/USD', mid: 1.001, spreadBps: 10, stalenessMs: 700, verdict: 'AVAILABLE' },
            { pairKey: 'XRP/EUR', mid: 1.4, spreadBps: 9, stalenessMs: 500, verdict: 'AVAILABLE' },
            { pairKey: 'XRP/USDT', mid: 0.98, spreadBps: 20, stalenessMs: 25_000, verdict: 'AVAILABLE' },
        ], {
            maxStalenessMs: 20_000,
            outlierThresholdBps: 150,
        });

        expect(result.xrpMid).not.toBeNull();
        expect(result.sourcesUsed.map((source) => source.pairKey).sort()).toEqual(['XRP/USD', 'XRP/USDC']);
        expect(result.confidence).toBeGreaterThan(0);
    });

    it('penalizes degraded and wide-spread sources in weighting', () => {
        const result = computeFairValue([
            { pairKey: 'XRP/USDC', mid: 1.0, spreadBps: 4, stalenessMs: 500, verdict: 'AVAILABLE' },
            { pairKey: 'XRP/USD', mid: 1.01, spreadBps: 40, stalenessMs: 500, verdict: 'AVAILABLE' },
            { pairKey: 'XRP/EUR', mid: 1.02, spreadBps: 8, stalenessMs: 500, verdict: 'DEGRADED' },
        ]);

        const byPair = new Map(result.sourcesUsed.map((source) => [source.pairKey, source.weight]));
        expect((byPair.get('XRP/USDC') ?? 0)).toBeGreaterThan(byPair.get('XRP/USD') ?? 0);
        expect((byPair.get('XRP/USDC') ?? 0)).toBeGreaterThan(byPair.get('XRP/EUR') ?? 0);
    });

    it('returns confidence 0 when no viable sources remain', () => {
        const result = computeFairValue([
            { pairKey: 'XRP/USDC', mid: 0, spreadBps: 4, stalenessMs: 100, verdict: 'AVAILABLE' },
            { pairKey: 'XRP/USD', mid: 1.0, spreadBps: 4, stalenessMs: 100_000, verdict: 'AVAILABLE' },
            { pairKey: 'XRP/EUR', mid: 1.0, spreadBps: 4, stalenessMs: 100, verdict: 'BLOCKED' },
        ]);

        expect(result.xrpMid).toBeNull();
        expect(result.confidence).toBe(0);
        expect(result.sourcesUsed).toEqual([]);
    });
});
