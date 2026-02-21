import { describe, expect, it, vi } from 'vitest';
import type { AvailabilityScannerSnapshot, AvailabilityVerdict } from '../../availabilityScanner';
import type { BackgroundScannerSnapshot } from '../types';

vi.mock('../../instrumentRegistry', () => ({
    getInstruments: () => ([
        {
            key: 'XRP/RLUSD',
            base: { currency: 'XRP' },
            quote: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            description: 'XRP/RLUSD',
            liquidity: 'high',
            network: 'mainnet',
            status: 'active',
            sortOrder: 1,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        },
        {
            key: 'XRP/USDT',
            base: { currency: 'XRP' },
            quote: { currency: 'USDT', issuer: 'rcvxE9PS9YBwxtGg1qNeewV6ZB3wGubZq' },
            description: 'XRP/USDT',
            liquidity: 'medium',
            network: 'mainnet',
            status: 'active',
            sortOrder: 2,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        },
        {
            key: 'XRP/USD',
            base: { currency: 'XRP' },
            quote: { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
            description: 'XRP/USD',
            liquidity: 'high',
            network: 'mainnet',
            status: 'active',
            sortOrder: 3,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        },
    ]),
}));

import { BackgroundMarketScanner } from '../backgroundMarketScanner';

function makeAvailabilitySnapshot(verdictByPair: Record<string, AvailabilityVerdict>): AvailabilityScannerSnapshot {
    return {
        pairs: Object.entries(verdictByPair).map(([pairKey, verdict]) => ({ pairKey, verdict } as any)),
        running: true,
        scanCount: 1,
        lastScanMs: Date.now(),
        lastScanDurationMs: 1,
    };
}

function createScanner(params: {
    currentPairKey: string;
    verdictByPair: Record<string, AvailabilityVerdict>;
    request: (req: { command: string }) => Promise<any>;
    maxMarkets?: number;
}) {
    const emitted: BackgroundScannerSnapshot[] = [];
    const scanner = new BackgroundMarketScanner({
        client: { request: params.request } as any,
        getCurrentPairKey: () => params.currentPairKey,
        getCurrentMidPrice: () => 1,
        getAvailabilitySnapshot: () => makeAvailabilitySnapshot(params.verdictByPair),
        isPaused: () => false,
        onSnapshot: (_pairKey, snapshot) => {
            emitted.push(snapshot);
        },
    }, {
        enabled: true,
        maxMarkets: params.maxMarkets ?? 3,
        maxRps: 2,
        tier1IntervalMs: 1,
        tier2IntervalMs: 1,
        requestTimeoutMs: 200,
        maxStalenessMs: 20_000,
    });

    return { scanner, emitted };
}

describe('BackgroundMarketScanner', () => {
    it('keeps active pair in scanner universe when availability is UNAVAILABLE', async () => {
        const { scanner } = createScanner({
            currentPairKey: 'XRP/USDT',
            verdictByPair: {
                'XRP/RLUSD': 'AVAILABLE',
                'XRP/USD': 'AVAILABLE',
                'XRP/USDT': 'UNAVAILABLE',
            },
            request: async () => ({ result: { offers: [] } }),
            maxMarkets: 2,
        });

        await (scanner as any).refreshUniverse(Date.now());

        const universe = (scanner as any).universe as {
            pairByKey: Map<string, unknown>;
            tier1: string[];
            tier2: string[];
        };
        expect(universe.pairByKey.has('XRP/USDT')).toBe(true);
        expect([...universe.tier1, ...universe.tier2]).toContain('XRP/USDT');
    });

    it('emits placeholder market rows when first probe fails', async () => {
        const { scanner, emitted } = createScanner({
            currentPairKey: 'XRP/USDT',
            verdictByPair: {
                'XRP/RLUSD': 'AVAILABLE',
                'XRP/USD': 'AVAILABLE',
                'XRP/USDT': 'UNAVAILABLE',
            },
            request: async () => {
                throw new Error('book_offers failed');
            },
            maxMarkets: 3,
        });

        const nowMs = Date.now();
        await (scanner as any).refreshUniverse(nowMs);
        (scanner as any).running = true;

        await (scanner as any).pulse();

        const latest = emitted[emitted.length - 1];
        expect(latest).toBeDefined();
        expect(Object.keys(latest.markets).length).toBeGreaterThan(0);
        expect(latest.markets['XRP/USDT']).toMatchObject({
            bid: 0,
            ask: 0,
            mid: 0,
            depthTopNotional: 0,
            verdict: 'UNAVAILABLE',
        });
    });
});
