import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeSingletonMocks = vi.hoisted(() => ({
    isSingleProcessMode: vi.fn(),
    ensureRuntimeStarted: vi.fn(),
    getRuntimeState: vi.fn(() => ({})),
    isRuntimeReady: vi.fn(() => false),
    isRuntimeWarmingUp: vi.fn(() => false),
    getRuntime: vi.fn(),
    stopRuntime: vi.fn(),
    getCacheSnapshot: vi.fn(),
    getCacheRegistry: vi.fn(),
}));

const guardMocks = vi.hoisted(() => ({
    markApiRouteContext: vi.fn(),
    clearApiRouteContext: vi.fn(),
    shouldUseRuntimeState: vi.fn(() => false),
}));

vi.mock('../../../runtime/runtimeSingleton', () => runtimeSingletonMocks);
vi.mock('../../../xrpl/guard', () => guardMocks);

describe('runtimeBridge getProcessModeInfo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports runtimeStarted from runtime instance state in single-process mode', async () => {
        runtimeSingletonMocks.isSingleProcessMode.mockReturnValue(true);
        runtimeSingletonMocks.getRuntime.mockReturnValue({
            isStarted: () => true,
        });
        runtimeSingletonMocks.isRuntimeReady.mockReturnValue(true);

        const { getProcessModeInfo } = await import('../runtimeBridge');
        const info = getProcessModeInfo();

        expect(info.mode).toBe('single');
        expect(info.xrplConnectionsExpected).toBe(1);
        expect(info.runtimeStarted).toBe(true);
        expect(info.runtimeReady).toBe(true);
    });

    it('reports runtimeStarted false when runtime instance is not started', async () => {
        runtimeSingletonMocks.isSingleProcessMode.mockReturnValue(true);
        runtimeSingletonMocks.getRuntime.mockReturnValue({
            isStarted: () => false,
        });

        const { getProcessModeInfo } = await import('../runtimeBridge');
        const info = getProcessModeInfo();

        expect(info.runtimeStarted).toBe(false);
    });

    it('reports dual-process expectations when single-process mode is disabled', async () => {
        runtimeSingletonMocks.isSingleProcessMode.mockReturnValue(false);
        runtimeSingletonMocks.getRuntime.mockReturnValue(null);

        const { getProcessModeInfo } = await import('../runtimeBridge');
        const info = getProcessModeInfo();

        expect(info.mode).toBe('dual');
        expect(info.xrplConnectionsExpected).toBe(2);
        expect(info.runtimeStarted).toBe(false);
    });
});
