import { botController } from './botController';
import { TradingRuntime } from '../../src/runtime/tradingRuntime';
import { validateServerStartup } from './security/localOnly';

const globalRefs = globalThis as typeof globalThis & {
    _tradingRuntime?: TradingRuntime;
    _runtimeHooksRegistered?: boolean;
    _localOnlyValidated?: boolean;
};

/**
 * Validate local-only execution on first access.
 * This ensures the runtime cannot be initialized on cloud platforms.
 */
function validateLocalExecution(): void {
    if (globalRefs._localOnlyValidated) {
        return;
    }

    const result = validateServerStartup();
    if (!result.allowed) {
        throw new Error(
            `Runtime initialization blocked: ${result.reason}. ` +
            'This bot is locked to localhost for safety.'
        );
    }

    globalRefs._localOnlyValidated = true;
}

// Create runtime only after validation
function getOrCreateRuntime(): TradingRuntime {
    validateLocalExecution();

    if (!globalRefs._tradingRuntime) {
        globalRefs._tradingRuntime = new TradingRuntime();
    }
    return globalRefs._tradingRuntime;
}

export const ensureRuntimeHooks = (): TradingRuntime => {
    const runtime = getOrCreateRuntime();

    if (!globalRefs._runtimeHooksRegistered) {
        botController.setHooks({
            start: () => runtime.start(),
            pause: () => runtime.pause(),
            kill: () => runtime.kill(),
            tick: () => runtime.tick(),
        });
        globalRefs._runtimeHooksRegistered = true;
    }
    return runtime;
};
