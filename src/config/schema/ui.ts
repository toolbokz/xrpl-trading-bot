import { parseOptionalBoolean, pushIssue, readEnvString } from './common';
import type { EnvValidationIssue } from './types';

export function validateUiEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationIssue[] {
    const issues: EnvValidationIssue[] = [];

    const botLocalOnly = parseOptionalBoolean({ env, envVar: 'BOT_LOCAL_ONLY', domain: 'ui', issues });
    const botAllowRemote = parseOptionalBoolean({ env, envVar: 'BOT_ALLOW_REMOTE', domain: 'ui', issues });
    const botApiDevMode = parseOptionalBoolean({ env, envVar: 'BOT_API_DEV_MODE', domain: 'ui', issues });
    const singleProcessMode = parseOptionalBoolean({ env, envVar: 'SINGLE_PROCESS_MODE', domain: 'ui', issues });

    const nodeEnv = (readEnvString(env, 'NODE_ENV') ?? '').toLowerCase();
    const isProduction = nodeEnv === 'production';

    if (singleProcessMode !== true) {
        pushIssue({
            issues,
            domain: 'ui',
            severity: 'warning',
            code: 'SINGLE_PROCESS_MODE_OFF',
            envVar: 'SINGLE_PROCESS_MODE',
            message: 'SINGLE_PROCESS_MODE is not true; API/runtime wiring may diverge.',
        });
    }

    if (botAllowRemote === true) {
        pushIssue({
            issues,
            domain: 'ui',
            severity: 'warning',
            code: 'BOT_ALLOW_REMOTE_ENABLED',
            envVar: 'BOT_ALLOW_REMOTE',
            message: 'BOT_ALLOW_REMOTE=true weakens localhost-only protections.',
        });
    }

    if (botAllowRemote === true && botLocalOnly === true) {
        pushIssue({
            issues,
            domain: 'ui',
            severity: 'warning',
            code: 'LOCALHOST_FLAGS_CONFLICT',
            envVar: 'BOT_LOCAL_ONLY/BOT_ALLOW_REMOTE',
            message: 'BOT_LOCAL_ONLY=true and BOT_ALLOW_REMOTE=true are conflicting signals.',
        });
    }

    if (isProduction && botApiDevMode === true) {
        pushIssue({
            issues,
            domain: 'ui',
            severity: 'warning',
            code: 'BOT_API_DEV_MODE_ENABLED_IN_PROD',
            envVar: 'BOT_API_DEV_MODE',
            message: 'BOT_API_DEV_MODE=true in production relaxes proxy-header checks.',
        });
    }

    const localApiToken = readEnvString(env, 'LOCAL_API_TOKEN');
    if (isProduction && (!localApiToken || localApiToken.length < 12)) {
        pushIssue({
            issues,
            domain: 'ui',
            severity: 'warning',
            code: 'LOCAL_API_TOKEN_WEAK_OR_MISSING',
            envVar: 'LOCAL_API_TOKEN',
            message: 'LOCAL_API_TOKEN is missing or shorter than 12 characters in production.',
        });
    }

    if (isProduction && botAllowRemote !== true && botLocalOnly !== true) {
        pushIssue({
            issues,
            domain: 'ui',
            severity: 'warning',
            code: 'BOT_LOCAL_ONLY_NOT_ENFORCED',
            envVar: 'BOT_LOCAL_ONLY',
            message: 'Production mode should set BOT_LOCAL_ONLY=true unless a deliberate remote override is in place.',
        });
    }

    return issues;
}
