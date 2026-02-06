/**
 * Runtime Bridge for Next.js API Routes
 * 
 * Provides a unified interface for API routes to access data that can come from either:
 * - TradingRuntime singleton (single-process mode)
 * - Direct XRPL calls (dual-process mode, legacy behavior)
 * 
 * When SINGLE_PROCESS_MODE=true:
 * - Ensures TradingRuntime is started on first access
 * - Returns data from runtime state instead of making XRPL calls
 * - Marks API route context for guard enforcement
 * 
 * When SINGLE_PROCESS_MODE=false (default):
 * - Falls through to existing behavior
 * - API routes make their own XRPL calls as before
 */

import {
    isSingleProcessMode,
    ensureRuntimeStarted,
    getRuntimeState,
    isRuntimeReady,
    isRuntimeWarmingUp,
    getRuntime,
    RuntimePublicState,
    stopRuntime,
    getCacheSnapshot,
    getCacheRegistry,
    RuntimeCacheSnapshot,
} from '../../src/runtime/runtimeSingleton';
import {
    markApiRouteContext,
    clearApiRouteContext,
    shouldUseRuntimeState,
} from '../../src/xrpl/guard';
import { botController } from './botController';
import { TradingRuntime } from '../../src/runtime/tradingRuntime';

// Re-export types for convenience
export type { RuntimePublicState, RuntimeCacheSnapshot };
export { isSingleProcessMode, isRuntimeReady, isRuntimeWarmingUp, getCacheSnapshot, getCacheRegistry };

// =============================================================================
// Initialization
// =============================================================================

let initPromise: Promise<void> | null = null;
let isInitialized = false;

/**
 * Initialize the runtime bridge.
 * In single-process mode, this starts the TradingRuntime.
 * In dual-process mode, this is a no-op.
 * 
 * Idempotent: safe to call multiple times.
 */
export async function initRuntimeBridge(): Promise<void> {
    if (isInitialized) return;
    if (initPromise) {
        await initPromise;
        return;
    }

    if (!isSingleProcessMode()) {
        isInitialized = true;
        return;
    }

    initPromise = (async () => {
        try {
            // Start the runtime
            const runtime = await ensureRuntimeStarted();

            // Wire up bot controller hooks so dashboard controls work
            botController.setHooks({
                start: () => {
                    // Runtime already started
                    return Promise.resolve();
                },
                pause: () => runtime.pause(),
                kill: () => runtime.kill(),
                tick: () => runtime.tick(),
            });

            isInitialized = true;
        } catch (err) {
            console.error('[RuntimeBridge] Failed to initialize:', err);
            throw err;
        } finally {
            initPromise = null;
        }
    })();

    await initPromise;
}

// =============================================================================
// API Route Wrapper
// =============================================================================

/**
 * Wrap an API handler to:
 * 1. Initialize runtime bridge if needed
 * 2. Mark/clear API route context for guard enforcement
 * 
 * @param handler - The original API handler
 * @returns Wrapped handler
 */
export function withRuntimeBridge<Req, Res>(
    handler: (req: Req, res: Res) => Promise<void> | void
): (req: Req, res: Res) => Promise<void> {
    return async (req: Req, res: Res) => {
        // Initialize on first request
        if (isSingleProcessMode() && !isInitialized) {
            try {
                await initRuntimeBridge();
            } catch (err) {
                // If runtime fails to start, return 503
                console.error('[RuntimeBridge] Initialization failed:', err);
                (res as any).status(503).json({
                    error: 'Service initializing - please retry',
                    code: 'RUNTIME_STARTING',
                    warmingUp: true,
                });
                return;
            }
        }

        // Mark API route context for guard
        if (isSingleProcessMode()) {
            markApiRouteContext();
        }

        try {
            await handler(req, res);
        } finally {
            // Clear context after handler completes
            if (isSingleProcessMode()) {
                clearApiRouteContext();
            }
        }
    };
}

// =============================================================================
// State Accessors
// =============================================================================

/**
 * Get the current runtime state snapshot.
 * Returns a consistent state object regardless of process mode.
 */
export function getState(): RuntimePublicState {
    return getRuntimeState();
}

/**
 * Check if we should use runtime state instead of direct XRPL calls.
 */
export function shouldUseRuntime(): boolean {
    return shouldUseRuntimeState();
}

/**
 * Get the TradingRuntime instance (null if not in single-process mode or not started).
 */
export function getRuntimeInstance(): TradingRuntime | null {
    if (!isSingleProcessMode()) return null;
    return getRuntime();
}

// =============================================================================
// Data Accessors for API Routes
// =============================================================================

/**
 * Get order book data from runtime.
 * Returns null if not available (not in single-process mode or not ready).
 */
export function getOrderBookFromRuntime(pairKey?: string): RuntimePublicState['orderBook'] {
    if (!isSingleProcessMode()) return null;

    const state = getRuntimeState();

    // Validate pair matches if specified
    if (pairKey && state.pair && state.pair !== pairKey) {
        return null; // Different pair
    }

    return state.orderBook;
}

/**
 * Get flow metrics from runtime.
 */
export function getFlowFromRuntime(): RuntimePublicState['flow'] {
    if (!isSingleProcessMode()) return null;
    return getRuntimeState().flow;
}

/**
 * Get trade tape from runtime.
 */
export function getTapeFromRuntime(): RuntimePublicState['tape'] {
    if (!isSingleProcessMode()) return null;
    return getRuntimeState().tape;
}

/**
 * Get wallet info from runtime.
 */
export function getWalletFromRuntime(): RuntimePublicState['wallet'] {
    if (!isSingleProcessMode()) return null;
    return getRuntimeState().wallet;
}

/**
 * Get risk status from runtime.
 */
export function getRiskFromRuntime(): RuntimePublicState['risk'] {
    if (!isSingleProcessMode()) return null;
    return getRuntimeState().risk;
}

/**
 * Get governance status from runtime.
 */
export function getGovernanceFromRuntime(): RuntimePublicState['governance'] {
    if (!isSingleProcessMode()) return null;
    return getRuntimeState().governance;
}

/**
 * Get regime policy from runtime.
 */
export function getRegimePolicyFromRuntime(): RuntimePublicState['regimePolicy'] {
    if (!isSingleProcessMode()) return null;
    return getRuntimeState().regimePolicy;
}

/**
 * Get connection state from runtime.
 */
export function getConnectionFromRuntime(): RuntimePublicState['connection'] {
    if (!isSingleProcessMode()) return null;
    return getRuntimeState().connection;
}

// =============================================================================
// Lifecycle
// =============================================================================

/**
 * Stop the runtime (for graceful shutdown).
 */
export async function shutdownRuntimeBridge(): Promise<void> {
    if (!isSingleProcessMode()) return;
    await stopRuntime();
    isInitialized = false;
}

// =============================================================================
// Process Mode Info
// =============================================================================

/**
 * Get process mode information for health/status endpoints.
 */
export function getProcessModeInfo(): {
    mode: 'single' | 'dual';
    xrplConnectionsExpected: 1 | 2;
    runtimeStarted: boolean;
    runtimeReady: boolean;
    warmingUp: boolean;
} {
    const singleProcess = isSingleProcessMode();
    return {
        mode: singleProcess ? 'single' : 'dual',
        xrplConnectionsExpected: singleProcess ? 1 : 2,
        runtimeStarted: isInitialized,
        runtimeReady: isRuntimeReady(),
        warmingUp: isRuntimeWarmingUp(),
    };
}
