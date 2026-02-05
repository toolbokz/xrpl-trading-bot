/**
 * Runtime Singleton Tests
 * 
 * Tests for the single-process mode runtime singleton.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Create a stable mock instance for tests
let mockRuntimeInstance: ReturnType<typeof createMockRuntime>;

function createMockRuntime() {
    return {
        start: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        isStarted: vi.fn().mockReturnValue(true),
        getClient: vi.fn().mockReturnValue({ isConnected: () => true }),
        getFlowMetrics: vi.fn().mockReturnValue(null),
        getTradeTape: vi.fn().mockReturnValue(null),
        getWalletAddress: vi.fn().mockReturnValue(null),
        getRiskStatus: vi.fn().mockReturnValue(null),
        getGovernanceStatus: vi.fn().mockReturnValue({ decision: null, config: null }),
        getRegimePolicy: vi.fn().mockReturnValue(null),
        getOrderBookState: vi.fn().mockReturnValue(null),
        getConfig: vi.fn().mockReturnValue({
            tradingPair: { baseCurrency: 'XRP', quoteCurrency: 'RLUSD' },
            xrpl: { network: 'mainnet' }
        }),
    };
}

vi.mock('../tradingRuntime', () => {
    // Create class that acts as constructor
    const MockTradingRuntime = function (this: any) {
        mockRuntimeInstance = createMockRuntime();
        Object.assign(this, mockRuntimeInstance);
    };
    return { TradingRuntime: MockTradingRuntime };
});

vi.mock('../../config', () => ({
    loadConfig: vi.fn().mockReturnValue({
        xrpl: { network: 'mainnet' },
        tradingPair: { baseCurrency: 'XRP', quoteCurrency: 'RLUSD' },
    }),
}));

vi.mock('../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../sharedClient', () => ({
    getConnectionState: vi.fn().mockReturnValue({
        connected: true,
        endpoint: 'wss://test.xrpl.org',
        lastError: null,
        reconnects: 0,
        cooldowns: {},
        endpointPool: ['wss://test.xrpl.org'],
    }),
}));

describe('runtimeSingleton', () => {
    beforeEach(() => {
        vi.resetModules();
        // Reset environment
        delete process.env.SINGLE_PROCESS_MODE;
        // Reset mock instance
        mockRuntimeInstance = createMockRuntime();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('isSingleProcessMode', () => {
        it('returns false when SINGLE_PROCESS_MODE is not set', async () => {
            const { isSingleProcessMode } = await import('../runtimeSingleton');
            expect(isSingleProcessMode()).toBe(false);
        });

        it('returns true when SINGLE_PROCESS_MODE=true', async () => {
            process.env.SINGLE_PROCESS_MODE = 'true';
            const { isSingleProcessMode } = await import('../runtimeSingleton');
            expect(isSingleProcessMode()).toBe(true);
        });

        it('returns false when SINGLE_PROCESS_MODE=false', async () => {
            process.env.SINGLE_PROCESS_MODE = 'false';
            const { isSingleProcessMode } = await import('../runtimeSingleton');
            expect(isSingleProcessMode()).toBe(false);
        });
    });

    describe('ensureRuntimeStarted', () => {
        it('starts runtime only once with concurrent calls', async () => {
            const { ensureRuntimeStarted, __resetForTesting } = await import('../runtimeSingleton');
            __resetForTesting();

            // Call multiple times concurrently
            const results = await Promise.all([
                ensureRuntimeStarted(),
                ensureRuntimeStarted(),
                ensureRuntimeStarted(),
            ]);

            // All should return the same instance (reference equality)
            expect(results[0]).toBe(results[1]);
            expect(results[1]).toBe(results[2]);

            // start() should be called exactly once
            expect(mockRuntimeInstance.start).toHaveBeenCalledTimes(1);
        });

        it('returns same runtime on subsequent calls', async () => {
            const { ensureRuntimeStarted, __resetForTesting } = await import('../runtimeSingleton');
            __resetForTesting();

            const first = await ensureRuntimeStarted();
            const second = await ensureRuntimeStarted();

            expect(first).toBe(second);
            expect(mockRuntimeInstance.start).toHaveBeenCalledTimes(1);
        });
    });

    describe('getRuntimeState', () => {
        it('returns base state when runtime not started', async () => {
            const { getRuntimeState, __resetForTesting } = await import('../runtimeSingleton');
            __resetForTesting();

            const state = getRuntimeState();

            expect(state.connected).toBe(false);
            expect(state.warmingUp).toBe(false);
            expect(state.orderBook).toBeNull();
        });

        it('returns populated state when runtime is started', async () => {
            const { ensureRuntimeStarted, getRuntimeState, __resetForTesting } = await import('../runtimeSingleton');
            __resetForTesting();

            await ensureRuntimeStarted();
            const state = getRuntimeState();

            expect(state.connected).toBe(true);
            expect(state.pair).toBe('XRP/RLUSD');
        });
    });

    describe('stopRuntime', () => {
        it('stops the runtime and clears state', async () => {
            const { ensureRuntimeStarted, stopRuntime, getRuntime, __resetForTesting } = await import('../runtimeSingleton');
            __resetForTesting();

            await ensureRuntimeStarted();
            expect(getRuntime()).not.toBeNull();

            await stopRuntime();
            expect(getRuntime()).toBeNull();
            expect(mockRuntimeInstance.shutdown).toHaveBeenCalledTimes(1);
        });

        it('is safe to call when not started', async () => {
            const { stopRuntime, __resetForTesting } = await import('../runtimeSingleton');
            __resetForTesting();

            // Should not throw
            await stopRuntime();
        });
    });
});
