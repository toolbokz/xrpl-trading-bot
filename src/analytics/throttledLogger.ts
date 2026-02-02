/**
 * Throttled logger utility to prevent log flooding.
 * Groups repeated messages and limits log rate per key.
 */

import { logger } from './logger';

/** Max logs per key per second (configurable via LOG_MAX_PER_SEC) */
export const LOG_MAX_PER_SEC = Math.max(
    1,
    parseInt(process.env.LOG_MAX_PER_SEC ?? '10', 10) || 10
);

/** How often to flush throttle stats (ms) */
const FLUSH_INTERVAL_MS = 5000;

interface ThrottleState {
    count: number;
    lastLogged: number;
    suppressed: number;
}

const throttleMap = new Map<string, ThrottleState>();
let flushInterval: NodeJS.Timeout | null = null;

/**
 * Start the flush interval to report suppressed logs.
 */
function ensureFlushInterval(): void {
    if (flushInterval) return;
    flushInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, state] of throttleMap.entries()) {
            if (state.suppressed > 0) {
                logger.info(
                    { key, suppressed: state.suppressed, intervalMs: FLUSH_INTERVAL_MS },
                    `Log throttle: ${state.suppressed} messages suppressed for "${key}"`
                );
                state.suppressed = 0;
            }
            // Clean up old entries (older than 30 seconds)
            if (now - state.lastLogged > 30_000) {
                throttleMap.delete(key);
            }
        }
    }, FLUSH_INTERVAL_MS);
    // Don't prevent process exit
    flushInterval.unref?.();
}

/**
 * Check if a log message should be throttled.
 * @param key - Unique key for this log source (e.g., "xrpl.reconnect")
 * @returns true if the message should be logged, false if throttled
 */
export function shouldLog(key: string): boolean {
    ensureFlushInterval();

    const now = Date.now();
    const state = throttleMap.get(key);

    if (!state) {
        throttleMap.set(key, { count: 1, lastLogged: now, suppressed: 0 });
        return true;
    }

    // Reset count every second
    if (now - state.lastLogged >= 1000) {
        state.count = 1;
        state.lastLogged = now;
        return true;
    }

    // Check if under limit
    if (state.count < LOG_MAX_PER_SEC) {
        state.count++;
        return true;
    }

    // Throttled
    state.suppressed++;
    return false;
}

/**
 * Create a throttled logging function.
 * @param key - Unique key for throttling
 * @param level - Log level ('info', 'warn', 'error', 'debug')
 */
export function createThrottledLog(
    key: string,
    level: 'info' | 'warn' | 'error' | 'debug' = 'info'
): (obj: Record<string, unknown> | string, msg?: string) => void {
    return (obj: Record<string, unknown> | string, msg?: string) => {
        if (!shouldLog(key)) return;

        if (typeof obj === 'string') {
            logger[level](obj);
        } else {
            logger[level](obj, msg);
        }
    };
}

/**
 * Stop the flush interval (for cleanup).
 */
export function stopThrottleFlush(): void {
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
    }
}

/**
 * Get current throttle statistics.
 */
export function getThrottleStats(): Map<string, ThrottleState> {
    return new Map(throttleMap);
}
