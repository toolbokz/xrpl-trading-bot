import { z } from 'zod';
import {
    parseOptionalInteger,
    parseOptionalNumber,
    pushIssue,
    readEnvString,
} from './common';
import type { EnvValidationIssue } from './types';

const wsEndpointSchema = z.string().regex(/^wss?:\/\//i, 'must start with ws:// or wss://');

function validateWsEndpoint(
    value: string,
    envVar: string,
    issues: EnvValidationIssue[],
): void {
    const parsed = wsEndpointSchema.safeParse(value);
    if (parsed.success) return;

    pushIssue({
        issues,
        domain: 'xrpl',
        severity: 'error',
        code: `${envVar}_INVALID`,
        envVar,
        message: `${envVar} must be a ws:// or wss:// URL, got "${value}"`,
    });
}

export function validateXrplEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationIssue[] {
    const issues: EnvValidationIssue[] = [];

    const xrplWssUrl = readEnvString(env, 'XRPL_WSS_URL');
    const xrplEndpoint = readEnvString(env, 'XRPL_ENDPOINT');
    const xrplWssUrlsRaw = readEnvString(env, 'XRPL_WSS_URLS');

    const listEndpoints = xrplWssUrlsRaw
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) ?? [];

    if (!xrplWssUrl && !xrplEndpoint && listEndpoints.length === 0) {
        pushIssue({
            issues,
            domain: 'xrpl',
            severity: 'error',
            code: 'XRPL_ENDPOINT_REQUIRED',
            envVar: 'XRPL_WSS_URL/XRPL_ENDPOINT/XRPL_WSS_URLS',
            message: 'At least one XRPL endpoint is required (XRPL_WSS_URL, XRPL_ENDPOINT, or XRPL_WSS_URLS).',
        });
    }

    if (xrplWssUrl) validateWsEndpoint(xrplWssUrl, 'XRPL_WSS_URL', issues);
    if (xrplEndpoint) validateWsEndpoint(xrplEndpoint, 'XRPL_ENDPOINT', issues);
    for (const endpoint of listEndpoints) {
        validateWsEndpoint(endpoint, 'XRPL_WSS_URLS', issues);
    }

    if (xrplWssUrl && xrplEndpoint && xrplWssUrl !== xrplEndpoint) {
        pushIssue({
            issues,
            domain: 'xrpl',
            severity: 'warning',
            code: 'XRPL_PRIMARY_ENDPOINT_MISMATCH',
            envVar: 'XRPL_WSS_URL/XRPL_ENDPOINT',
            message: `XRPL_WSS_URL (${xrplWssUrl}) and XRPL_ENDPOINT (${xrplEndpoint}) differ; runtime paths may pick different endpoints.`,
        });
    }

    parseOptionalInteger({ env, envVar: 'XRPL_REQUEST_TIMEOUT_MS', domain: 'xrpl', issues, min: 1_000 });
    parseOptionalInteger({ env, envVar: 'XRPL_RESERVE_REQUEST_TIMEOUT_MS', domain: 'xrpl', issues, min: 500 });
    parseOptionalInteger({ env, envVar: 'XRPL_CONNECT_TIMEOUT_MS', domain: 'xrpl', issues, min: 1_000 });
    parseOptionalInteger({ env, envVar: 'XRPL_429_COOLDOWN_MS', domain: 'xrpl', issues, min: 1_000 });

    parseOptionalInteger({ env, envVar: 'XRPL_MAX_RECONNECTS', domain: 'xrpl', issues, min: 1 });
    const reconnectDelay = parseOptionalInteger({
        env,
        envVar: 'XRPL_RECONNECT_DELAY_MS',
        domain: 'xrpl',
        issues,
        min: 0,
    });
    const reconnectMaxDelay = parseOptionalInteger({
        env,
        envVar: 'XRPL_RECONNECT_MAX_DELAY_MS',
        domain: 'xrpl',
        issues,
        min: 0,
    });

    const initialReconnectDelay = parseOptionalInteger({
        env,
        envVar: 'XRPL_INITIAL_RECONNECT_DELAY_MS',
        domain: 'xrpl',
        issues,
        min: 0,
    });
    const maxReconnectDelay = parseOptionalInteger({
        env,
        envVar: 'XRPL_MAX_RECONNECT_DELAY_MS',
        domain: 'xrpl',
        issues,
        min: 0,
    });
    parseOptionalInteger({ env, envVar: 'XRPL_MIN_CONNECT_INTERVAL_MS', domain: 'xrpl', issues, min: 0 });
    parseOptionalNumber({ env, envVar: 'XRPL_BACKOFF_429_MULTIPLIER', domain: 'xrpl', issues, min: 1, max: 10 });

    if (
        typeof reconnectDelay === 'number'
        && typeof reconnectMaxDelay === 'number'
        && reconnectMaxDelay < reconnectDelay
    ) {
        pushIssue({
            issues,
            domain: 'xrpl',
            severity: 'error',
            code: 'XRPL_RECONNECT_DELAY_INVALID_RANGE',
            envVar: 'XRPL_RECONNECT_DELAY_MS/XRPL_RECONNECT_MAX_DELAY_MS',
            message: `XRPL_RECONNECT_MAX_DELAY_MS (${reconnectMaxDelay}) must be >= XRPL_RECONNECT_DELAY_MS (${reconnectDelay}).`,
        });
    }

    if (
        typeof initialReconnectDelay === 'number'
        && typeof maxReconnectDelay === 'number'
        && maxReconnectDelay < initialReconnectDelay
    ) {
        pushIssue({
            issues,
            domain: 'xrpl',
            severity: 'error',
            code: 'XRPL_SHARED_RECONNECT_DELAY_INVALID_RANGE',
            envVar: 'XRPL_INITIAL_RECONNECT_DELAY_MS/XRPL_MAX_RECONNECT_DELAY_MS',
            message: `XRPL_MAX_RECONNECT_DELAY_MS (${maxReconnectDelay}) must be >= XRPL_INITIAL_RECONNECT_DELAY_MS (${initialReconnectDelay}).`,
        });
    }

    if (
        typeof reconnectDelay === 'number'
        && typeof initialReconnectDelay === 'number'
        && reconnectDelay !== initialReconnectDelay
    ) {
        pushIssue({
            issues,
            domain: 'xrpl',
            severity: 'warning',
            code: 'XRPL_INITIAL_RECONNECT_DELAY_DIVERGES',
            envVar: 'XRPL_RECONNECT_DELAY_MS/XRPL_INITIAL_RECONNECT_DELAY_MS',
            message: `Reconnect delay envs diverge (${reconnectDelay} vs ${initialReconnectDelay}); different clients may back off differently.`,
        });
    }

    if (
        typeof reconnectMaxDelay === 'number'
        && typeof maxReconnectDelay === 'number'
        && reconnectMaxDelay !== maxReconnectDelay
    ) {
        pushIssue({
            issues,
            domain: 'xrpl',
            severity: 'warning',
            code: 'XRPL_MAX_RECONNECT_DELAY_DIVERGES',
            envVar: 'XRPL_RECONNECT_MAX_DELAY_MS/XRPL_MAX_RECONNECT_DELAY_MS',
            message: `Max reconnect delay envs diverge (${reconnectMaxDelay} vs ${maxReconnectDelay}); different clients may cap backoff differently.`,
        });
    }

    // Optional fee controls (validated when present).
    parseOptionalInteger({ env, envVar: 'XRPL_MAX_FEE_DROPS', domain: 'xrpl', issues, min: 10 });
    parseOptionalNumber({ env, envVar: 'XRPL_FEE_MULTIPLIER', domain: 'xrpl', issues, min: 0.1, max: 10 });

    return issues;
}
