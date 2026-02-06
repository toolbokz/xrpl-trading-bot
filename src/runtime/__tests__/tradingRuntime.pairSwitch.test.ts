import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradingRuntime, PairSwitchState, PairSwitchResult, PairSwitchStatus } from '../tradingRuntime';

declare module '../tradingRuntime' {
    interface TradingRuntime {
        getActivePair(): string;
        setActivePair(pairKey: string): PairSwitchResult;
        getPairSwitchState(): PairSwitchState;
        getPairSwitchStatus(): PairSwitchStatus;
        getFlowMetrics(): any;
        getMarketHealth(): any;
    }
}

const ORIG_LOCAL_ONLY = process.env.BOT_LOCAL_ONLY;

describe('TradingRuntime pair switching', () => {
    let runtime: TradingRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.BOT_LOCAL_ONLY = 'true';
        runtime = new TradingRuntime();
    });

    afterEach(async () => {
        await runtime.shutdown();

        if (ORIG_LOCAL_ONLY === undefined) {
            delete process.env.BOT_LOCAL_ONLY;
        } else {
            process.env.BOT_LOCAL_ONLY = ORIG_LOCAL_ONLY;
        }
    });

    it('is idempotent when switching to active pair', () => {
        const active = runtime.getActivePair();

        const result = runtime.setActivePair(active);
        expect(result.success).toBe(true);
        expect(result.activePair).toBe(active);
        expect(runtime.getActivePair()).toBe(active);
    });

    it('rejects invalid pair key and keeps current active pair', () => {
        const before = runtime.getActivePair();

        const result = runtime.setActivePair('XRP/INVALID');

        expect(result.success).toBe(false);
        expect(result.activePair).toBe(before);
        expect(runtime.getActivePair()).toBe(before);
    });

    it('rolls back active pair if switching fails during apply', () => {
        const before = runtime.getActivePair();

        Reflect.set(runtime as unknown as object, 'tradeTape', {
            setPair: () => {
                throw new Error('boom');
            },
        });

        const result = runtime.setActivePair('XRP/USDC');

        expect(result.success).toBe(false);
        expect(result.activePair).toBe(before);
        expect(runtime.getActivePair()).toBe(before);
    });

    it('FSM returns to IDLE after successful switch', () => {
        expect(runtime.getPairSwitchState()).toBe('IDLE');

        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(true);
        expect(runtime.getPairSwitchState()).toBe('IDLE');
    });

    it('FSM returns to IDLE after failed switch', () => {
        Reflect.set(runtime as unknown as object, 'tradeTape', {
            setPair: () => { throw new Error('boom'); },
        });

        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(false);
        expect(runtime.getPairSwitchState()).toBe('IDLE');
    });

    it('invalidates market caches on successful switch', () => {
        // Inject stale cache values
        Reflect.set(runtime as unknown as object, 'currentFlowMetrics', { regime: 'quiet' });
        Reflect.set(runtime as unknown as object, 'currentOrderBookSnapshot', { pairKey: 'XRP/RLUSD' });
        Reflect.set(runtime as unknown as object, 'currentNormalizedTrade', { id: 'old' });
        Reflect.set(runtime as unknown as object, 'currentMarketHealthScore', 80);
        Reflect.set(runtime as unknown as object, 'marketSnapshotSequence', 42);

        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(true);

        // All caches must be cleared
        expect(runtime.getFlowMetrics()).toBeNull();
        expect(runtime.getMarketHealth().score).toBe(0);
        expect(runtime.getMarketHealth().orderBook).toBeNull();
        expect(runtime.getMarketHealth().lastTrade).toBeNull();
    });

    it('invalidates market caches on rollback after failed switch', () => {
        Reflect.set(runtime as unknown as object, 'currentFlowMetrics', { regime: 'quiet' });

        Reflect.set(runtime as unknown as object, 'tradeTape', {
            setPair: () => { throw new Error('boom'); },
        });

        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(false);

        // Caches must still be cleared after rollback
        expect(runtime.getFlowMetrics()).toBeNull();
    });

    it('A → B → A round-trip returns to original pair', () => {
        const originalPair = runtime.getActivePair();

        const toB = runtime.setActivePair('XRP/USDC');
        expect(toB.success).toBe(true);
        expect(runtime.getActivePair()).toBe('XRP/USDC');

        const backToA = runtime.setActivePair(originalPair);
        expect(backToA.success).toBe(true);
        expect(runtime.getActivePair()).toBe(originalPair);
    });

    it('propagates pair to executor on switch', () => {
        const mockSetPair = vi.fn();
        Reflect.set(runtime as unknown as object, 'executor', { setPair: mockSetPair });

        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(true);
        expect(mockSetPair).toHaveBeenCalledTimes(1);
        expect(mockSetPair.mock.calls[0]![0].baseCurrency).toBe('XRP');
        expect(mockSetPair.mock.calls[0]![0].quoteCurrency).toBe('USDC');
    });

    it('propagates pair to strategies on switch', () => {
        const mockSetPair = vi.fn();
        const mockStrategy = { name: 'test', tick: vi.fn(), setPair: mockSetPair };
        Reflect.set(runtime as unknown as object, 'strategies', [mockStrategy]);

        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(true);
        expect(mockSetPair).toHaveBeenCalledTimes(1);
    });

    // ── PR2: Pair switch readiness truth tests ───────────────────────────

    it('returns pending=true and a switchId on successful switch', () => {
        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(true);
        expect(result.pending).toBe(true);
        expect(result.switchId).toBeDefined();
        expect(typeof result.switchId).toBe('string');
        expect(result.switchId!.length).toBeGreaterThan(0);
    });

    it('returns pending=false on idempotent (same pair) switch', () => {
        const active = runtime.getActivePair();
        const result = runtime.setActivePair(active);
        expect(result.success).toBe(true);
        expect(result.pending).toBe(false);
        expect(result.switchId).toBeUndefined();
    });

    it('returns pending=false on failed switch (invalid pair)', () => {
        const result = runtime.setActivePair('XRP/INVALID');
        expect(result.success).toBe(false);
        expect(result.pending).toBe(false);
    });

    it('returns pending=false on sync rollback failure', () => {
        Reflect.set(runtime as unknown as object, 'tradeTape', {
            setPair: () => { throw new Error('boom'); },
        });
        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(false);
        expect(result.pending).toBe(false);
    });

    it('getPairSwitchStatus() reflects pending state after switch', () => {
        const result = runtime.setActivePair('XRP/USDC');
        expect(result.success).toBe(true);

        const status = runtime.getPairSwitchStatus();
        expect(status.pending).toBe(true);
        expect(status.switchId).toBe(result.switchId);
        expect(status.targetPairKey).toBe('XRP/USDC');
        expect(status.lastError).toBeNull();
        expect(status.activePair).toBe('XRP/USDC');
    });

    it('getPairSwitchStatus() resets to clean state after shutdown', async () => {
        runtime.setActivePair('XRP/USDC');
        await runtime.shutdown();

        const status = runtime.getPairSwitchStatus();
        expect(status.pending).toBe(false);
        expect(status.switchId).toBeNull();
        expect(status.targetPairKey).toBeNull();
        expect(status.lastError).toBeNull();
    });

    it('generates unique switchIds for consecutive switches', () => {
        const r1 = runtime.setActivePair('XRP/USDC');
        const r2 = runtime.setActivePair('XRP/RLUSD');
        expect(r1.switchId).toBeDefined();
        expect(r2.switchId).toBeDefined();
        expect(r1.switchId).not.toBe(r2.switchId);
    });
});
