export type RetryClassifiedOutcome = 'FILLED' | 'NO_FILL' | 'FATAL_ENGINE_RESULT' | 'NON_RETRYABLE';

export interface ExecutionRetryConfig {
    maxAttempts: number;
    slippageStepBps: number;
    maxSlippageBps: number;
    backoffBaseMs: number;
    backoffCapMs: number;
}

export interface RetryAmountDecision {
    nextBase: number | null;
    reason: 'ok' | 'no-depth' | 'insufficient-depth' | 'below-min';
    shrunk: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SLIPPAGE_STEP_BPS = 3;
const DEFAULT_MAX_SLIPPAGE_BPS = 25;
const DEFAULT_BACKOFF_BASE_MS = 200;
const DEFAULT_BACKOFF_CAP_MS = 2_000;

function parseBoundedNumber(
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function normalizeEngineResult(engineResult: string | null | undefined): string {
    if (!engineResult || typeof engineResult !== 'string') return '';
    return engineResult.trim().toUpperCase();
}

export function loadExecutionRetryConfig(env: NodeJS.ProcessEnv = process.env): ExecutionRetryConfig {
    const maxAttemptsRaw = parseBoundedNumber(
        env.EXECUTION_RETRY_MAX_ATTEMPTS,
        DEFAULT_MAX_ATTEMPTS,
        1,
        10,
    );
    const slippageStepBps = parseBoundedNumber(
        env.EXECUTION_RETRY_SLIPPAGE_STEP_BPS,
        DEFAULT_SLIPPAGE_STEP_BPS,
        0,
        100,
    );
    const maxSlippageBps = parseBoundedNumber(
        env.EXECUTION_RETRY_MAX_SLIPPAGE_BPS,
        DEFAULT_MAX_SLIPPAGE_BPS,
        0,
        500,
    );

    return {
        maxAttempts: Math.max(1, Math.floor(maxAttemptsRaw)),
        slippageStepBps,
        maxSlippageBps: Math.max(slippageStepBps, maxSlippageBps),
        backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
        backoffCapMs: DEFAULT_BACKOFF_CAP_MS,
    };
}

export function classifyRetryOutcome(input: {
    accepted: boolean;
    engineResult: string | null | undefined;
}): RetryClassifiedOutcome {
    if (input.accepted) return 'FILLED';
    const normalized = normalizeEngineResult(input.engineResult);
    if (normalized === 'TECKILLED' || normalized === 'NO_FILL') {
        return 'NO_FILL';
    }
    if (normalized.startsWith('TEC') || normalized.startsWith('TEF') || normalized.startsWith('TEM')) {
        return 'FATAL_ENGINE_RESULT';
    }
    return 'NON_RETRYABLE';
}

export function shouldRetryNoFill(input: {
    attempt: number;
    isIoc: boolean;
    config: ExecutionRetryConfig;
    engineResult: string | null | undefined;
    classifiedOutcome: RetryClassifiedOutcome;
}): boolean {
    if (!input.isIoc) return false;
    if (input.attempt >= input.config.maxAttempts) return false;

    const normalized = normalizeEngineResult(input.engineResult);
    if (normalized === 'TECKILLED') return true;
    if (input.classifiedOutcome === 'NO_FILL') return true;

    if (normalized.startsWith('TEC') || normalized.startsWith('TEF') || normalized.startsWith('TEM')) {
        return false;
    }
    return false;
}

export function nextRetrySlippageBps(currentSlippageBps: number, config: ExecutionRetryConfig): number {
    const current = Number.isFinite(currentSlippageBps) ? Math.max(0, currentSlippageBps) : 0;
    const next = current + config.slippageStepBps;
    return Math.min(config.maxSlippageBps, next);
}

export function computeRetryBackoffMs(input: {
    attempt: number;
    config: ExecutionRetryConfig;
    random?: () => number;
}): number {
    const attempt = Math.max(1, Math.floor(input.attempt));
    const exp = input.config.backoffBaseMs * (2 ** (attempt - 1));
    const capped = Math.min(input.config.backoffCapMs, exp);
    const randFn = input.random ?? Math.random;
    const rand = Math.min(1, Math.max(0, randFn()));
    const jittered = capped * (0.75 + (0.5 * rand));
    return Math.max(0, Math.min(input.config.backoffCapMs, Math.round(jittered)));
}

export function decideRetryAmount(input: {
    desiredBase: number;
    fillableBase: number;
    allowPartialSizing: boolean;
    minBase: number;
}): RetryAmountDecision {
    const desiredBase = Number.isFinite(input.desiredBase) ? input.desiredBase : 0;
    const fillableBase = Number.isFinite(input.fillableBase) ? input.fillableBase : 0;
    const minBase = Number.isFinite(input.minBase) ? Math.max(0, input.minBase) : 0;

    if (fillableBase <= 1e-12) {
        return {
            nextBase: null,
            reason: 'no-depth',
            shrunk: false,
        };
    }

    if (fillableBase + 1e-12 < desiredBase) {
        if (!input.allowPartialSizing) {
            return {
                nextBase: null,
                reason: 'insufficient-depth',
                shrunk: false,
            };
        }
        if (fillableBase + 1e-12 < minBase) {
            return {
                nextBase: null,
                reason: 'below-min',
                shrunk: true,
            };
        }
        return {
            nextBase: fillableBase,
            reason: 'ok',
            shrunk: true,
        };
    }

    if (desiredBase + 1e-12 < minBase) {
        return {
            nextBase: null,
            reason: 'below-min',
            shrunk: false,
        };
    }

    return {
        nextBase: desiredBase,
        reason: 'ok',
        shrunk: false,
    };
}
