/**
 * Graceful Shutdown Tests
 * 
 * Note: These tests focus on the shutdown behavior itself.
 * The full integration requires mocking xrpl address validation,
 * so we test what we can without starting the full runtime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the dependencies before importing
vi.mock('../../persistence/breakerStore', () => ({
    closeBreakerStore: vi.fn().mockResolvedValue(undefined),
    getBreakerStore: vi.fn().mockReturnValue({
        load: vi.fn().mockResolvedValue({ trades: [], trippedAt: null, lastUpdated: 0 }),
        save: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
    }),
}));

import { closeBreakerStore } from '../../persistence/breakerStore';
import { TradingRuntime } from '../tradingRuntime';

describe('TradingRuntime Graceful Shutdown', () => {
    let runtime: TradingRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        // Create runtime without config (will use defaults)
        runtime = new TradingRuntime();
    });

    it('handles shutdown when not started', async () => {
        // Should not throw when shutting down an unstarted runtime
        await expect(runtime.shutdown()).resolves.not.toThrow();
    });

    it('closes breaker store on shutdown even when not started', async () => {
        await runtime.shutdown();
        expect(closeBreakerStore).toHaveBeenCalled();
    });

    it('resets runtime state after shutdown', async () => {
        // Runtime was never started
        expect(runtime.isStarted()).toBe(false);

        await runtime.shutdown();

        // Still not started after shutdown
        expect(runtime.isStarted()).toBe(false);
    });

    it('getClient returns null when not started', () => {
        expect(runtime.getClient()).toBeNull();
    });

    it('getWalletAddress returns null when not started', () => {
        expect(runtime.getWalletAddress()).toBeNull();
    });
});

describe('Shutdown Signal Handling', () => {
    it('shutdown is idempotent (can be called multiple times)', async () => {
        const runtime = new TradingRuntime();

        // Multiple shutdown calls should all succeed
        await runtime.shutdown();
        await runtime.shutdown();
        await runtime.shutdown();

        // Still expect breaker store to be closed (at least once)
        expect(closeBreakerStore).toHaveBeenCalled();
    });
});
