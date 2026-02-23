import { describe, expect, it, vi } from 'vitest';

vi.mock('../../security/localOnly', () => ({
    enforceLocalOnly: vi.fn(),
}));

import { loadConfig } from '../../config';
import { TradingRuntime } from '../tradingRuntime';

function buildRuntimeWithBookRefreshes(results: boolean[]): {
    runtime: TradingRuntime;
    refreshSpy: ReturnType<typeof vi.fn>;
    recordBookEventSpy: ReturnType<typeof vi.fn>;
} {
    const cfg = loadConfig();
    cfg.paperTrading = true;

    const runtime = new TradingRuntime(cfg);

    const refreshSpy = vi.fn(async () => results.shift() ?? true);
    const recordBookEventSpy = vi.fn();

    Reflect.set(runtime as unknown as object, 'started', true);
    Reflect.set(runtime as unknown as object, 'shutdownInProgress', false);
    Reflect.set(runtime as unknown as object, 'walletAddress', null);
    Reflect.set(runtime as unknown as object, 'strategies', []);

    Reflect.set(runtime as unknown as object, 'xrpl', {
        isConnected: () => true,
        isReconnecting: () => false,
        getLedgerIndex: () => 123456,
    });

    Reflect.set(runtime as unknown as object, 'risk', {
        checkAndResetDaily: () => undefined,
        isShutdown: () => false,
    });

    Reflect.set(runtime as unknown as object, 'tracker', {
        refresh: refreshSpy,
        getState: () => ({
            bids: [{ price: 1.0, quantity: 10 }],
            asks: [{ price: 1.01, quantity: 10 }],
            spread: 99.01,
            lastUpdated: Date.now(),
        }),
    });

    Reflect.set(runtime as unknown as object, 'feedStallRecovery', {
        recordBookEvent: recordBookEventSpy,
        recordTapeEvent: vi.fn(),
        evaluate: vi.fn(async () => undefined),
        isRecovering: vi.fn(() => false),
        getState: vi.fn(() => ({
            stage: 'HEALTHY',
            recovering: false,
            lastTapeEventMs: 0,
            lastBookEventMs: 0,
            lastRecoveryAttemptMs: 0,
            recoveryAttempts: 0,
        })),
    });

    return { runtime, refreshSpy, recordBookEventSpy };
}

describe('TradingRuntime feed-stall book heartbeat', () => {
    it('records book liveness only after successful order book refreshes', async () => {
        const { runtime, refreshSpy, recordBookEventSpy } = buildRuntimeWithBookRefreshes([true, false]);

        const initialLastBookUpdateMs = Reflect.get(runtime as unknown as object, 'lastBookUpdateMs') as number;

        await runtime.tick();

        const afterSuccessLastBookUpdateMs = Reflect.get(runtime as unknown as object, 'lastBookUpdateMs') as number;
        expect(afterSuccessLastBookUpdateMs).toBeGreaterThan(initialLastBookUpdateMs);
        expect(recordBookEventSpy).toHaveBeenCalledTimes(1);
        expect(typeof recordBookEventSpy.mock.calls[0]?.[0]).toBe('number');

        await runtime.tick();

        const afterFailureLastBookUpdateMs = Reflect.get(runtime as unknown as object, 'lastBookUpdateMs') as number;
        expect(afterFailureLastBookUpdateMs).toBe(afterSuccessLastBookUpdateMs);
        expect(recordBookEventSpy).toHaveBeenCalledTimes(1);
        expect(refreshSpy).toHaveBeenCalledTimes(2);
    });
});
