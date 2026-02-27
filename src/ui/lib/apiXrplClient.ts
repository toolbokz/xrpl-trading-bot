// src/ui/lib/apiXrplClient.ts
import { Client } from 'xrpl';
import { getXrplClient as getSharedXrplClient } from '../../xrpl/sharedClient';
import {
    ensureRuntimeStarted,
    getRuntime,
    isSingleProcessMode,
} from '../../runtime/runtimeSingleton';

/**
 * API-safe XRPL client accessor.
 *
 * Rules:
 * - SINGLE_PROCESS_MODE=true:
 *     Use the TradingRuntime singleton (single connection) to avoid
 *     dual-process rate-limit amplification and to respect xrpl/guard.
 * - Otherwise:
 *     Use the sharedClient singleton directly.
 */
export async function getApiXrplClient(): Promise<Client> {
    // In single-process mode, API routes must NOT call getXrplClient() directly
    // (guarded). Instead, borrow the runtime's connected Client.
    if (isSingleProcessMode()) {
        const existing = getRuntime();
        if (existing?.isStarted()) {
            return existing.getClient()!;
        }

        // If the runtime isn't started yet, start it (idempotent).
        const started = await ensureRuntimeStarted();
        return started.getClient()!;
    }

    // Dual-process mode: OK to use the shared client singleton directly.
    return getSharedXrplClient();
}
