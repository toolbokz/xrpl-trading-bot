import { describe, expect, it } from 'vitest';
import { sortMarkets } from '../backgroundScannerViewModel';

const rows = [
    { pairKey: 'XRP/A', mid: 1, spreadBps: 10, depthTopNotional: 1000, stalenessMs: 1000, verdict: 'AVAILABLE' },
    { pairKey: 'XRP/B', mid: 1, spreadBps: 25, depthTopNotional: 200, stalenessMs: 9000, verdict: 'DEGRADED' },
    { pairKey: 'XRP/C', mid: 1, spreadBps: 5, depthTopNotional: 9000, stalenessMs: 2000, verdict: 'AVAILABLE' },
];

describe('sortMarkets', () => {
    it('sorts by staleness desc', () => {
        const sorted = sortMarkets(rows as any, 'stale');
        expect(sorted[0]?.pairKey).toBe('XRP/B');
    });

    it('sorts by spread desc', () => {
        const sorted = sortMarkets(rows as any, 'spread');
        expect(sorted[0]?.pairKey).toBe('XRP/B');
    });

    it('sorts by depth desc', () => {
        const sorted = sortMarkets(rows as any, 'depth');
        expect(sorted[0]?.pairKey).toBe('XRP/C');
    });
});
