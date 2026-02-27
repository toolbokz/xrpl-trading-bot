/**
 * Central feature-flag helpers for audit-safe rollouts.
 *
 * Default behavior:
 * - Unset flags are OFF.
 * - Truthy values: 1, true, yes, on
 */

export function isFeatureEnabled(
    key: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const raw = env[key];
    if (typeof raw !== 'string') return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === '1'
        || normalized === 'true'
        || normalized === 'yes'
        || normalized === 'on';
}

/**
 * Enables optional audit guardrails (timeouts, stricter request context checks, etc).
 */
export function isAuditGuardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return isFeatureEnabled('FEATURE_AUDIT_GUARDS', env);
}

/**
 * Enables strict startup configuration enforcement.
 */
export function isStrictConfigEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return isFeatureEnabled('FEATURE_STRICT_CONFIG', env);
}

/**
 * Enables verbose execution lifecycle telemetry emissions.
 */
export function isExecTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return isFeatureEnabled('FEATURE_EXEC_TELEMETRY', env);
}
