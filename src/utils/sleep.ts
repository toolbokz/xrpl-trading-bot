/**
 * CPU-safe sleep utility with configurable delay.
 * Prevents tight loops from pegging CPU.
 */

/** Minimum loop delay in ms (configurable via BOT_LOOP_MIN_DELAY_MS) */
export const BOT_LOOP_MIN_DELAY_MS = Math.max(
    25,
    parseInt(process.env.BOT_LOOP_MIN_DELAY_MS ?? '50', 10) || 50
);

/**
 * Sleep for specified duration.
 * @param ms - Duration in milliseconds (defaults to BOT_LOOP_MIN_DELAY_MS)
 */
export const sleep = (ms: number = BOT_LOOP_MIN_DELAY_MS): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sleep with jitter to prevent thundering herd.
 * @param baseMs - Base duration in milliseconds
 * @param jitterRatio - Jitter ratio (0-1), default 0.2 (±20%)
 */
export const sleepWithJitter = (baseMs: number, jitterRatio: number = 0.2): Promise<void> => {
    const jitter = baseMs * jitterRatio * (Math.random() * 2 - 1);
    const duration = Math.max(25, Math.round(baseMs + jitter));
    return sleep(duration);
};

/**
 * Ensure minimum delay between iterations in a loop.
 * Call at the start of each loop iteration.
 * @param lastIterationMs - Timestamp of last iteration start
 * @param minDelayMs - Minimum delay between iterations (defaults to BOT_LOOP_MIN_DELAY_MS)
 * @returns Current timestamp for next call
 */
export const ensureMinDelay = async (
    lastIterationMs: number,
    minDelayMs: number = BOT_LOOP_MIN_DELAY_MS
): Promise<number> => {
    const now = Date.now();
    const elapsed = now - lastIterationMs;
    if (elapsed < minDelayMs) {
        await sleep(minDelayMs - elapsed);
    }
    return Date.now();
};
