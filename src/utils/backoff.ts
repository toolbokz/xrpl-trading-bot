export interface BackoffState {
    attempt: number;
    delayMs: number;
}

export const nextBackoff = (
    current: BackoffState,
    initialDelayMs: number,
    maxDelayMs: number
): BackoffState => {
    const attempt = current.attempt + 1;
    const delayMs = Math.min(initialDelayMs * 2 ** current.attempt, maxDelayMs);
    return { attempt, delayMs };
};
