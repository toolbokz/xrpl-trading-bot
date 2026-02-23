/**
 * Runtime Hooks — Bridges BotController to the TradingRuntime singleton.
 *
 * Uses `runtimeSingleton.ts` as the single source of truth for the
 * TradingRuntime instance.  Previous versions maintained a separate
 * `globalThis._tradingRuntime` reference which caused dual-runtime
 * bugs (candle freeze, kill-then-restart failure).
 *
 * @module ui/lib/runtimeHooks
 */

import { botController } from './botController';
import { TradingRuntime } from '../../runtime/tradingRuntime';
import { validateServerStartup } from './security/localOnly';
import {
    getRuntime as singletonGetRuntime,
    ensureRuntimeStarted,
} from '../../runtime/runtimeSingleton';
import { loadConfig } from '../../config';
import { logger } from '../../analytics/logger';

const globalRefs = globalThis as typeof globalThis & {
    _runtimeHooksRegistered?: boolean;
    _localOnlyValidated?: boolean;
};
let moduleHooksRegistered = false;

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

/**
 * Register bot-controller hooks that delegate to the singleton runtime.
 *
 * Key design decisions:
 * - `start` uses `ensureRuntimeStarted()` so that a fresh runtime is
 *   created if the previous one was killed/stopped.
 * - `kill` destroys the runtime AND clears the singleton reference so
 *   the next `start` creates a new instance.
 * - `tick` is a no-op when the runtime doesn't exist (between kill
 *   and the next start).
 */
function registerHooks(): void {
    botController.setHooks({
        start: async () => {
            validateLocalExecution();
            await ensureRuntimeStarted();
        },
        pause: async () => {
            const rt = singletonGetRuntime();
            if (rt) await rt.pause();
        },
        kill: async () => {
            const rt = singletonGetRuntime();
            if (!rt) return;

            // Kill the runtime (disconnects XRPL, resets state)
            await rt.kill();

            // Clear the singleton so the next `start` creates a fresh one
            globalThis.__xrplTradingBotRuntime = null;
            globalThis.__xrplTradingBotStartPromise = null;
            globalThis.__xrplTradingBotIsStarting = false;

            logger.info('[RuntimeHooks] Runtime killed and singleton cleared — ready for restart');
        },
        tick: async () => {
            const rt = singletonGetRuntime();
            if (rt?.isStarted()) await rt.tick();
        },
    });
    globalRefs._runtimeHooksRegistered = true;
    moduleHooksRegistered = true;
}

function ensureHooksRegisteredOnce(): void {
    if (moduleHooksRegistered || globalRefs._runtimeHooksRegistered) {
        moduleHooksRegistered = true;
        return;
    }
    registerHooks();
}

export const ensureRuntimeHooks = (): TradingRuntime => {
    validateLocalExecution();

    // Register hooks once (they reference the singleton dynamically,
    // so they survive kill/restart cycles without re-registration).
    ensureHooksRegisteredOnce();

    // Return the current runtime (may be null if between kill and start)
    const runtime = singletonGetRuntime();
    if (!runtime) {
        // Create a new runtime eagerly so callers that need an instance
        // (e.g. health check reading connection status) get one.
        // Note: this does NOT start the runtime — just constructs it.
        const config = loadConfig();
        const newRuntime = new TradingRuntime(config);
        globalThis.__xrplTradingBotRuntime = newRuntime;
        return newRuntime;
    }
    return runtime;
};

/**
 * Get the existing runtime instance without creating one.
 * Returns undefined if the runtime hasn't been initialized yet.
 */
export const getRuntime = (): TradingRuntime | undefined => {
    return singletonGetRuntime() ?? undefined;
};

export function __resetRuntimeHooksForTests(): void {
    moduleHooksRegistered = false;
    delete globalRefs._runtimeHooksRegistered;
    delete globalRefs._localOnlyValidated;
}
