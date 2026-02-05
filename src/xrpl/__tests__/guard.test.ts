/**
 * XRPL Guard Tests
 * 
 * Tests for the single-process mode guard that prevents
 * direct XRPL calls from API routes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

describe('xrplGuard', () => {
    beforeEach(() => {
        vi.resetModules();
        // Reset environment
        delete process.env.SINGLE_PROCESS_MODE;
        // Clear global context
        (globalThis as any).__NEXT_API_ROUTE_CONTEXT__ = false;
    });

    afterEach(() => {
        vi.clearAllMocks();
        (globalThis as any).__NEXT_API_ROUTE_CONTEXT__ = false;
    });

    describe('isSingleProcessMode', () => {
        it('returns false when env is not set', async () => {
            const { isSingleProcessMode } = await import('../../xrpl/guard');
            expect(isSingleProcessMode()).toBe(false);
        });

        it('returns true when SINGLE_PROCESS_MODE=true', async () => {
            process.env.SINGLE_PROCESS_MODE = 'true';
            const { isSingleProcessMode } = await import('../../xrpl/guard');
            expect(isSingleProcessMode()).toBe(true);
        });
    });

    describe('markApiRouteContext / clearApiRouteContext', () => {
        it('marks and clears the context correctly', async () => {
            const { markApiRouteContext, clearApiRouteContext, isApiRouteContext } = await import('../../xrpl/guard');

            expect(isApiRouteContext()).toBe(false);

            markApiRouteContext();
            expect(isApiRouteContext()).toBe(true);

            clearApiRouteContext();
            expect(isApiRouteContext()).toBe(false);
        });
    });

    describe('shouldUseRuntimeState', () => {
        it('returns false in dual-process mode', async () => {
            const { shouldUseRuntimeState, markApiRouteContext } = await import('../../xrpl/guard');

            markApiRouteContext();
            expect(shouldUseRuntimeState()).toBe(false);
        });

        it('returns false when not in API route context', async () => {
            process.env.SINGLE_PROCESS_MODE = 'true';
            const { shouldUseRuntimeState } = await import('../../xrpl/guard');

            expect(shouldUseRuntimeState()).toBe(false);
        });

        it('returns true in single-process mode API route', async () => {
            process.env.SINGLE_PROCESS_MODE = 'true';
            const { shouldUseRuntimeState, markApiRouteContext } = await import('../../xrpl/guard');

            markApiRouteContext();
            expect(shouldUseRuntimeState()).toBe(true);
        });
    });

    describe('assertNoDirectXrplCallsInSingleProcess', () => {
        it('does not throw in dual-process mode', async () => {
            const { assertNoDirectXrplCallsInSingleProcess, markApiRouteContext } = await import('../../xrpl/guard');

            markApiRouteContext();
            expect(() => assertNoDirectXrplCallsInSingleProcess('test')).not.toThrow();
        });

        it('does not throw in single-process mode outside API context', async () => {
            process.env.SINGLE_PROCESS_MODE = 'true';
            const { assertNoDirectXrplCallsInSingleProcess } = await import('../../xrpl/guard');

            // TradingRuntime runs outside API route context
            expect(() => assertNoDirectXrplCallsInSingleProcess('test')).not.toThrow();
        });

        it('throws in single-process mode inside API context', async () => {
            process.env.SINGLE_PROCESS_MODE = 'true';
            const { assertNoDirectXrplCallsInSingleProcess, markApiRouteContext, SingleProcessXrplGuardError } = await import('../../xrpl/guard');

            markApiRouteContext();
            expect(() => assertNoDirectXrplCallsInSingleProcess('test')).toThrow(SingleProcessXrplGuardError);
        });
    });

    describe('withXrplOrRuntime', () => {
        it('calls directFn in dual-process mode', async () => {
            const { withXrplOrRuntime, markApiRouteContext } = await import('../../xrpl/guard');

            const directFn = vi.fn().mockResolvedValue('direct');
            const runtimeFn = vi.fn().mockResolvedValue('runtime');

            markApiRouteContext();
            const result = await withXrplOrRuntime(directFn, runtimeFn);

            expect(result).toBe('direct');
            expect(directFn).toHaveBeenCalled();
            expect(runtimeFn).not.toHaveBeenCalled();
        });

        it('calls runtimeFn in single-process mode API context', async () => {
            process.env.SINGLE_PROCESS_MODE = 'true';
            const { withXrplOrRuntime, markApiRouteContext } = await import('../../xrpl/guard');

            const directFn = vi.fn().mockResolvedValue('direct');
            const runtimeFn = vi.fn().mockResolvedValue('runtime');

            markApiRouteContext();
            const result = await withXrplOrRuntime(directFn, runtimeFn);

            expect(result).toBe('runtime');
            expect(runtimeFn).toHaveBeenCalled();
            expect(directFn).not.toHaveBeenCalled();
        });
    });
});
