export interface BackoffState {
    attempt: number;
    delayMs: number;
}

/**
 * Calculate next backoff delay with exponential increase.
 * @param current - Current backoff state
 * @param initialDelayMs - Initial delay in ms
 * @param maxDelayMs - Maximum delay cap in ms (default 15000)
 * @returns Next backoff state
 */
export const nextBackoff = (
    current: BackoffState,
    initialDelayMs: number,
    maxDelayMs: number = 15_000
): BackoffState => {
    const attempt = current.attempt + 1;
    const delayMs = Math.min(initialDelayMs * 2 ** current.attempt, maxDelayMs);
    return { attempt, delayMs };
};

/**
 * Add jitter to a delay to prevent thundering herd.
 * @param delayMs - Base delay in ms
 * @param jitterRatio - Jitter ratio (0-1), default 0.2 (±20%)
 * @returns Delay with jitter applied
 */
export const addJitter = (delayMs: number, jitterRatio: number = 0.2): number => {
    const jitter = delayMs * jitterRatio * (Math.random() * 2 - 1);
    return Math.max(100, Math.round(delayMs + jitter));
};

/**
 * Calculate next backoff delay with exponential increase and jitter.
 * Prevents reconnect storms by spreading retry attempts.
 * @param current - Current backoff state
 * @param initialDelayMs - Initial delay in ms
 * @param maxDelayMs - Maximum delay cap in ms (default 15000)
 * @param jitterRatio - Jitter ratio (0-1), default 0.2
 * @returns Next backoff state with jittered delay
 */
export const nextBackoffWithJitter = (
    current: BackoffState,
    initialDelayMs: number,
    maxDelayMs: number = 15_000,
    jitterRatio: number = 0.2
): BackoffState => {
    const state = nextBackoff(current, initialDelayMs, maxDelayMs);
    return {
        ...state,
        delayMs: addJitter(state.delayMs, jitterRatio),
    };
};
