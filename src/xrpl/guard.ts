/**
 * XRPL Connection Guard
 * 
 * Prevents accidental direct XRPL client creation from Next.js API routes
 * when SINGLE_PROCESS_MODE=true. In single-process mode, all XRPL calls
 * should go through the TradingRuntime singleton.
 * 
 * This guard helps catch regressions where API routes bypass the runtime
 * and create their own connections (which would cause 429 rate limits).
 */

import { logger } from '../analytics/logger';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Check if single-process mode is enabled.
 */
export function isSingleProcessMode(): boolean {
    return process.env.SINGLE_PROCESS_MODE === 'true';
}

/**
 * Check if this is a Next.js API route context.
 * We detect this by checking for Next.js-specific globals/patterns.
 */
export function isApiRouteContext(): boolean {
    // Check for Next.js API route markers
    // In Next.js API routes, we set a marker in the request handler
    return Boolean((globalThis as any).__NEXT_API_ROUTE_CONTEXT__);
}

/**
 * Mark that we're in a Next.js API route context.
 * Called by the runtime bridge at the start of API route handling.
 */
export function markApiRouteContext(): void {
    (globalThis as any).__NEXT_API_ROUTE_CONTEXT__ = true;
}

/**
 * Clear the API route context marker.
 * Called after API route handling completes.
 */
export function clearApiRouteContext(): void {
    (globalThis as any).__NEXT_API_ROUTE_CONTEXT__ = false;
}

// =============================================================================
// Guard Functions
// =============================================================================

/**
 * Error thrown when attempting to create an XRPL client directly in single-process mode.
 */
export class SingleProcessXrplGuardError extends Error {
    constructor(context: string) {
        super(
            `[XRPL Guard] Direct XRPL client access blocked in single-process mode. ` +
            `Context: ${context}. ` +
            `When SINGLE_PROCESS_MODE=true, use runtime state via runtimeBridge instead of getXrplClient().`
        );
        this.name = 'SingleProcessXrplGuardError';
    }
}

/**
 * Assert that direct XRPL calls are not being made from API routes in single-process mode.
 * 
 * Call this at the start of any function that creates or uses an XRPL client directly.
 * In dual-process mode, this is a no-op.
 * In single-process mode API routes, this throws an error.
 * 
 * @param context - Description of where the call is being made (for error messages)
 * @throws SingleProcessXrplGuardError if called from an API route in single-process mode
 */
export function assertNoDirectXrplCallsInSingleProcess(context: string): void {
    if (!isSingleProcessMode()) {
        // Dual-process mode - direct calls are allowed
        return;
    }

    if (isApiRouteContext()) {
        // Single-process mode in API route context - block direct calls
        logger.error(
            { context },
            '[XRPL Guard] Blocked direct XRPL client access from API route in single-process mode'
        );
        throw new SingleProcessXrplGuardError(context);
    }

    // Single-process mode but not in API route context (e.g., TradingRuntime) - allow
}

/**
 * Check if direct XRPL calls would be blocked.
 * Use this to conditionally choose between direct XRPL access and runtime state.
 * 
 * @returns true if in single-process mode AND in API route context
 */
export function shouldUseRuntimeState(): boolean {
    return isSingleProcessMode() && isApiRouteContext();
}

/**
 * Wrapper for functions that need XRPL access, providing either:
 * - Direct XRPL access (dual-process mode)
 * - Runtime state (single-process mode)
 * 
 * @param directFn - Function that makes direct XRPL calls
 * @param runtimeFn - Function that uses runtime state instead
 * @returns Result from the appropriate function
 */
export async function withXrplOrRuntime<T>(
    directFn: () => Promise<T>,
    runtimeFn: () => Promise<T>
): Promise<T> {
    if (shouldUseRuntimeState()) {
        return runtimeFn();
    }
    return directFn();
}
