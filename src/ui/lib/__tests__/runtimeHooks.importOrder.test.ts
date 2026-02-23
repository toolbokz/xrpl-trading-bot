import { beforeEach, describe, expect, it, vi } from 'vitest';

type HookMap = {
    start?: () => Promise<void> | void;
    pause?: () => Promise<void> | void;
    kill?: () => Promise<void> | void;
    tick?: () => Promise<void> | void;
};

type ScenarioResult = {
    runtimeStarted: boolean;
    setHooksCallCount: number;
    firstHooksRef: HookMap | undefined;
    finalHooksRef: HookMap | undefined;
};

const hoisted = vi.hoisted(() => {
    const runtime = {
        isStarted: vi.fn(() => false),
        pause: vi.fn(),
        kill: vi.fn(),
        tick: vi.fn(),
    };

    const hookState: { current: HookMap | undefined } = { current: undefined };

    const mockSetHooks = vi.fn((hooks: HookMap) => {
        hookState.current = hooks;
    });

    return {
        runtime,
        hookState,
        mockSetHooks,
        runtimeSingletonMocks: {
            isSingleProcessMode: vi.fn(),
            ensureRuntimeStarted: vi.fn(),
            getRuntimeState: vi.fn(() => ({})),
            isRuntimeReady: vi.fn(() => false),
            isRuntimeWarmingUp: vi.fn(() => false),
            getRuntime: vi.fn(),
            stopRuntime: vi.fn(),
            getCacheSnapshot: vi.fn(),
            getCacheRegistry: vi.fn(),
        },
        guardMocks: {
            markApiRouteContext: vi.fn(),
            clearApiRouteContext: vi.fn(),
            shouldUseRuntimeState: vi.fn(() => false),
        },
        localOnlyMocks: {
            validateServerStartup: vi.fn(() => ({ allowed: true, reason: 'ok' })),
        },
    };
});

vi.mock('../botController', () => ({
    botController: {
        setHooks: hoisted.mockSetHooks,
    },
}));

vi.mock('../../../runtime/runtimeSingleton', () => hoisted.runtimeSingletonMocks);
vi.mock('../../../xrpl/guard', () => hoisted.guardMocks);
vi.mock('../security/localOnly', () => hoisted.localOnlyMocks);
vi.mock('../../../config', () => ({
    loadConfig: vi.fn(() => ({})),
}));
vi.mock('../../../runtime/tradingRuntime', () => ({
    TradingRuntime: class MockTradingRuntime {},
}));
vi.mock('../../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

function resetGlobalRegistrationFlags(): void {
    delete (globalThis as { _runtimeHooksRegistered?: boolean })._runtimeHooksRegistered;
    delete (globalThis as { _localOnlyValidated?: boolean })._localOnlyValidated;
}

async function runScenario(order: 'hooks-first' | 'bridge-first'): Promise<ScenarioResult> {
    vi.resetModules();
    vi.clearAllMocks();
    resetGlobalRegistrationFlags();

    hoisted.hookState.current = undefined;
    hoisted.runtimeSingletonMocks.isSingleProcessMode.mockReturnValue(true);
    hoisted.runtimeSingletonMocks.ensureRuntimeStarted.mockResolvedValue(hoisted.runtime);
    hoisted.runtimeSingletonMocks.getRuntime.mockReturnValue(hoisted.runtime);
    hoisted.runtimeSingletonMocks.isRuntimeReady.mockReturnValue(false);
    hoisted.runtimeSingletonMocks.isRuntimeWarmingUp.mockReturnValue(false);

    if (order === 'hooks-first') {
        const runtimeHooks = await import('../runtimeHooks');
        runtimeHooks.ensureRuntimeHooks();
        const firstHooksRef = hoisted.hookState.current;

        const runtimeBridge = await import('../runtimeBridge');
        await runtimeBridge.initRuntimeBridge();
        // Re-run both entrypoints to verify idempotency.
        runtimeHooks.ensureRuntimeHooks();
        await runtimeBridge.initRuntimeBridge();

        const info = runtimeBridge.getProcessModeInfo();

        return {
            runtimeStarted: info.runtimeStarted,
            setHooksCallCount: hoisted.mockSetHooks.mock.calls.length,
            firstHooksRef,
            finalHooksRef: hoisted.hookState.current,
        };
    }

    const runtimeBridge = await import('../runtimeBridge');
    await runtimeBridge.initRuntimeBridge();
    const firstHooksRef = hoisted.hookState.current;

    const runtimeHooks = await import('../runtimeHooks');
    runtimeHooks.ensureRuntimeHooks();
    await runtimeBridge.initRuntimeBridge();

    const info = runtimeBridge.getProcessModeInfo();

    return {
        runtimeStarted: info.runtimeStarted,
        setHooksCallCount: hoisted.mockSetHooks.mock.calls.length,
        firstHooksRef,
        finalHooksRef: hoisted.hookState.current,
    };
}

describe('runtime hook registration import-order invariance', () => {
    beforeEach(() => {
        resetGlobalRegistrationFlags();
    });

    it('keeps runtimeStarted and hook instances stable regardless of import order', async () => {
        const hooksFirst = await runScenario('hooks-first');
        const bridgeFirst = await runScenario('bridge-first');

        expect(hooksFirst.runtimeStarted).toBe(bridgeFirst.runtimeStarted);

        expect(hooksFirst.setHooksCallCount).toBe(1);
        expect(bridgeFirst.setHooksCallCount).toBe(1);

        expect(hooksFirst.firstHooksRef).toBeDefined();
        expect(hooksFirst.finalHooksRef).toBe(hooksFirst.firstHooksRef);
        expect(bridgeFirst.firstHooksRef).toBeDefined();
        expect(bridgeFirst.finalHooksRef).toBe(bridgeFirst.firstHooksRef);

        expect(typeof hooksFirst.finalHooksRef?.start).toBe('function');
        expect(typeof hooksFirst.finalHooksRef?.pause).toBe('function');
        expect(typeof hooksFirst.finalHooksRef?.kill).toBe('function');
        expect(typeof hooksFirst.finalHooksRef?.tick).toBe('function');

        expect(typeof bridgeFirst.finalHooksRef?.start).toBe('function');
        expect(typeof bridgeFirst.finalHooksRef?.pause).toBe('function');
        expect(typeof bridgeFirst.finalHooksRef?.kill).toBe('function');
        expect(typeof bridgeFirst.finalHooksRef?.tick).toBe('function');
    });
});
