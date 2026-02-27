import {
    parseOptionalBoolean,
    parseOptionalEnum,
    parseOptionalInteger,
    parseOptionalNumber,
    pushIssue,
} from './common';
import type { EnvValidationIssue } from './types';

export function validateExecutionEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationIssue[] {
    const issues: EnvValidationIssue[] = [];

    const minBase = parseOptionalNumber({ env, envVar: 'EXECUTION_MIN_BASE_XRP', domain: 'execution', issues, min: 0 });
    const minQuote = parseOptionalNumber({ env, envVar: 'EXECUTION_MIN_QUOTE_RLUSD', domain: 'execution', issues, min: 0 });
    const legacyMinBase = parseOptionalNumber({ env, envVar: 'EXECUTION_MIN_BASE', domain: 'execution', issues, min: 0 });
    const legacyMinQuote = parseOptionalNumber({ env, envVar: 'EXECUTION_MIN_QUOTE', domain: 'execution', issues, min: 0 });
    parseOptionalNumber({ env, envVar: 'MAX_SLIPPAGE_BPS', domain: 'execution', issues, min: 0, max: 10_000 });
    parseOptionalNumber({ env, envVar: 'EXECUTION_SLIPPAGE_BPS_DEFAULT', domain: 'execution', issues, min: 0, max: 500 });
    parseOptionalNumber({ env, envVar: 'EXECUTION_MAX_SLIPPAGE_BPS_VS_MID', domain: 'execution', issues, min: 0, max: 1_000 });
    parseOptionalBoolean({ env, envVar: 'EXECUTION_ALLOW_PARTIAL_SIZING', domain: 'execution', issues });

    parseOptionalInteger({ env, envVar: 'EXECUTION_DEPTH_LEVELS', domain: 'execution', issues, min: 1, max: 100 });
    const minFillRatio = parseOptionalNumber({ env, envVar: 'EXECUTION_MIN_FILL_RATIO', domain: 'execution', issues, min: 0.05, max: 1 });
    const legacyIocMinFillRatio = parseOptionalNumber({ env, envVar: 'EXECUTION_IOC_MIN_FILL_RATIO', domain: 'execution', issues, min: 0.05, max: 1 });
    parseOptionalNumber({ env, envVar: 'EXECUTION_REPRICE_MAX_BPS', domain: 'execution', issues, min: 0, max: 100 });

    parseOptionalInteger({ env, envVar: 'EXECUTION_MAX_RETRIES', domain: 'execution', issues, min: 0, max: 20 });
    parseOptionalInteger({ env, envVar: 'EXECUTION_IDEMPOTENCY_WINDOW_MS', domain: 'execution', issues, min: 500, max: 120_000 });

    parseOptionalInteger({ env, envVar: 'EXECUTION_LAST_LEDGER_SLACK', domain: 'execution', issues, min: 4, max: 12 });

    parseOptionalNumber({ env, envVar: 'REPRICE_DRIFT_THRESHOLD_BPS', domain: 'execution', issues, min: 0 });
    parseOptionalInteger({ env, envVar: 'REPRICE_HARD_STALENESS_MS', domain: 'execution', issues, min: 0 });
    parseOptionalInteger({ env, envVar: 'REPRICE_CHURN_LIMIT_PER_MIN', domain: 'execution', issues, min: 0 });

    const orderType = parseOptionalEnum({
        env,
        envVar: 'EXECUTION_ORDER_TYPE',
        domain: 'execution',
        issues,
        allowed: ['IOC', 'FOK', 'RESTING', 'SMART'],
    });

    if (orderType === 'RESTING') {
        pushIssue({
            issues,
            domain: 'execution',
            severity: 'warning',
            code: 'EXECUTION_ORDER_TYPE_RESTING_UNSUPPORTED',
            envVar: 'EXECUTION_ORDER_TYPE',
            message: 'RESTING order type is not implemented in runtime order-flag mapping; runtime currently falls back to IOC/FOK logic.',
        });
    }

    if (legacyIocMinFillRatio !== undefined) {
        pushIssue({
            issues,
            domain: 'execution',
            severity: 'warning',
            code: 'EXECUTION_IOC_MIN_FILL_RATIO_DEPRECATED',
            envVar: 'EXECUTION_IOC_MIN_FILL_RATIO',
            message: 'EXECUTION_IOC_MIN_FILL_RATIO is deprecated; use EXECUTION_MIN_FILL_RATIO.',
        });
    }

    const effectiveMinFillRatio = minFillRatio ?? legacyIocMinFillRatio;
    if (orderType === 'FOK' && effectiveMinFillRatio !== undefined && Math.abs(effectiveMinFillRatio - 1) > 1e-12) {
        pushIssue({
            issues,
            domain: 'execution',
            severity: 'error',
            code: 'EXECUTION_FOK_MIN_FILL_RATIO_INVALID',
            envVar: 'EXECUTION_ORDER_TYPE/EXECUTION_MIN_FILL_RATIO',
            message: 'EXECUTION_ORDER_TYPE=FOK requires EXECUTION_MIN_FILL_RATIO=1.0.',
        });
    }

    if (legacyMinBase !== undefined) {
        pushIssue({
            issues,
            domain: 'execution',
            severity: 'warning',
            code: 'EXECUTION_MIN_BASE_DEPRECATED',
            envVar: 'EXECUTION_MIN_BASE',
            message: 'EXECUTION_MIN_BASE is deprecated; use EXECUTION_MIN_BASE_XRP.',
        });
    }

    if (legacyMinQuote !== undefined) {
        pushIssue({
            issues,
            domain: 'execution',
            severity: 'warning',
            code: 'EXECUTION_MIN_QUOTE_DEPRECATED',
            envVar: 'EXECUTION_MIN_QUOTE',
            message: 'EXECUTION_MIN_QUOTE is deprecated; use EXECUTION_MIN_QUOTE_RLUSD.',
        });
    }

    if (minBase === 0) {
        pushIssue({
            issues,
            domain: 'execution',
            severity: 'warning',
            code: 'EXECUTION_MIN_BASE_ZERO',
            envVar: 'EXECUTION_MIN_BASE_XRP',
            message: 'EXECUTION_MIN_BASE_XRP=0 disables base-size floor checks.',
        });
    }

    if (minQuote === 0) {
        pushIssue({
            issues,
            domain: 'execution',
            severity: 'warning',
            code: 'EXECUTION_MIN_QUOTE_ZERO',
            envVar: 'EXECUTION_MIN_QUOTE_RLUSD',
            message: 'EXECUTION_MIN_QUOTE_RLUSD=0 disables quote-size floor checks.',
        });
    }

    return issues;
}
