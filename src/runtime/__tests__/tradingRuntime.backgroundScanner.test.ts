import { describe, expect, it, vi } from 'vitest';

vi.mock('../../security/localOnly', () => ({
    enforceLocalOnly: vi.fn(),
}));

import { TradingRuntime } from '../tradingRuntime';
import { loadConfig } from '../../config';
import { BackgroundMarketScanner } from '../../market/backgroundScanner/backgroundMarketScanner';

type FakeRequest = (req: { command: string }) => Promise<any>;

function makeScanner(runtime: TradingRuntime, request: FakeRequest): BackgroundMarketScanner {
    const fakeClient = {
        request,
    } as any;

    return new BackgroundMarketScanner({
        client: fakeClient,
        getCurrentPairKey: () => runtime.getCurrentPairKey(),
        getCurrentMidPrice: () => 1,
        getAvailabilitySnapshot: () => ({
            pairs: [
                { pairKey: 'XRP/RLUSD', verdict: 'AVAILABLE' },
                { pairKey: 'XRP/USDT', verdict: 'DEGRADED' },
            ] as any,
            running: false,
            scanCount: 0,
            lastScanMs: 0,
            lastScanDurationMs: 0,
        }),
        isPaused: () => false,
        onSnapshot: (pairKey, snapshot) => {
            runtime.getCacheRegistry().updateBackground(pairKey, snapshot);
        },
    }, {
        enabled: true,
        maxMarkets: 2,
        maxRps: 2,
        tier1IntervalMs: 1,
        tier2IntervalMs: 1,
        maxStalenessMs: 20_000,
        requestTimeoutMs: 2_000,
    });
}

describe('TradingRuntime + BackgroundScanner harness', () => {
    it('populates RuntimeCacheRegistry background snapshot when scanner emits', async () => {
        const cfg = loadConfig();
        cfg.paperTrading = true;
        cfg.backgroundScanner.enabled = true;

        const runtime = new TradingRuntime(cfg);
        const scanner = makeScanner(runtime, async () => ({
            result: {
                offers: [
                    { TakerGets: { value: '10' }, TakerPays: '10000000' },
                    { TakerGets: { value: '9' }, TakerPays: '9000000' },
                ],
            },
        }));

        scanner.start();
        await (scanner as any).pulse();

        const cache = runtime.getCacheRegistry().getSnapshot();
        expect(cache.background).not.toBeNull();
        expect(cache.background?.markets).toBeDefined();

        scanner.stop();
    });

    it('tick remains non-blocking while scanner work is in-flight', async () => {
        const cfg = loadConfig();
        cfg.paperTrading = true;
        cfg.backgroundScanner.enabled = true;

        const runtime = new TradingRuntime(cfg);
        const scanner = makeScanner(runtime, async () => new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    result: { offers: [{ TakerGets: { value: '10' }, TakerPays: '10000000' }] },
                });
            }, 200);
        }));

        scanner.start();
        const scanPromise = (scanner as any).pulse();

        const startMs = Date.now();
        await runtime.tick();
        const elapsedMs = Date.now() - startMs;

        expect(elapsedMs).toBeLessThan(100);

        await scanPromise;
        scanner.stop();
    });

    it('swallows simulated 429 errors without throwing', async () => {
        const cfg = loadConfig();
        cfg.paperTrading = true;
        cfg.backgroundScanner.enabled = true;

        const runtime = new TradingRuntime(cfg);
        const scanner = makeScanner(runtime, async () => {
            const err = new Error('429 Too Many Requests');
            throw err;
        });

        scanner.start();
        await expect((scanner as any).pulse()).resolves.toBeUndefined();

        scanner.stop();
    });
});
