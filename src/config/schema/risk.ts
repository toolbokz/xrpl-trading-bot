import { parseOptionalInteger, parseOptionalNumber, pushIssue } from './common';
import type { EnvValidationIssue } from './types';

export function validateRiskEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationIssue[] {
    const issues: EnvValidationIssue[] = [];

    const maxExposure = parseOptionalNumber({ env, envVar: 'MAX_EXPOSURE_PER_ISSUER', domain: 'risk', issues, min: 0 });
    const maxTradeSize = parseOptionalNumber({ env, envVar: 'MAX_TRADE_SIZE', domain: 'risk', issues, min: 0 });
    const positionSize = parseOptionalNumber({ env, envVar: 'POSITION_SIZE_XRP', domain: 'risk', issues, min: 0 });
    const baseOrderSize = parseOptionalNumber({ env, envVar: 'BASE_ORDER_SIZE_XRP', domain: 'risk', issues, min: 0 });
    const maxDailyLoss = parseOptionalNumber({ env, envVar: 'MAX_DAILY_LOSS_XRP', domain: 'risk', issues, min: 0 });
    parseOptionalNumber({ env, envVar: 'EXECUTION_MIN_BASE_FRAC', domain: 'risk', issues, min: 0, max: 1 });

    parseOptionalNumber({ env, envVar: 'RESERVE_FLOOR_XRP', domain: 'risk', issues, min: 0 });
    parseOptionalInteger({ env, envVar: 'CONSECUTIVE_FAILURE_KILL_SWITCH', domain: 'risk', issues, min: 1 });

    if (typeof maxExposure === 'number' && maxExposure <= 0) {
        pushIssue({
            issues,
            domain: 'risk',
            severity: 'error',
            code: 'MAX_EXPOSURE_PER_ISSUER_NON_POSITIVE',
            envVar: 'MAX_EXPOSURE_PER_ISSUER',
            message: `MAX_EXPOSURE_PER_ISSUER must be > 0, got ${maxExposure}`,
        });
    }

    if (typeof maxTradeSize === 'number' && maxTradeSize <= 0) {
        pushIssue({
            issues,
            domain: 'risk',
            severity: 'error',
            code: 'MAX_TRADE_SIZE_NON_POSITIVE',
            envVar: 'MAX_TRADE_SIZE',
            message: `MAX_TRADE_SIZE must be > 0, got ${maxTradeSize}`,
        });
    }

    // Validate the effective base order size (new knob or legacy)
    const effectiveBaseSize = baseOrderSize ?? positionSize;
    if (typeof effectiveBaseSize === 'number' && effectiveBaseSize <= 0) {
        pushIssue({
            issues,
            domain: 'risk',
            severity: 'error',
            code: 'BASE_ORDER_SIZE_XRP_NON_POSITIVE',
            envVar: baseOrderSize !== undefined ? 'BASE_ORDER_SIZE_XRP' : 'POSITION_SIZE_XRP',
            message: `${baseOrderSize !== undefined ? 'BASE_ORDER_SIZE_XRP' : 'POSITION_SIZE_XRP'} must be > 0, got ${effectiveBaseSize}`,
        });
    }

    // Deprecation warning for POSITION_SIZE_XRP when BASE_ORDER_SIZE_XRP is not set
    if (baseOrderSize === undefined && positionSize !== undefined) {
        pushIssue({
            issues,
            domain: 'risk',
            severity: 'warning',
            code: 'POSITION_SIZE_XRP_DEPRECATED',
            envVar: 'POSITION_SIZE_XRP',
            message: 'POSITION_SIZE_XRP is deprecated; migrate to BASE_ORDER_SIZE_XRP.',
        });
    }

    if (typeof maxDailyLoss === 'number' && maxDailyLoss <= 0) {
        pushIssue({
            issues,
            domain: 'risk',
            severity: 'error',
            code: 'MAX_DAILY_LOSS_XRP_NON_POSITIVE',
            envVar: 'MAX_DAILY_LOSS_XRP',
            message: `MAX_DAILY_LOSS_XRP must be > 0, got ${maxDailyLoss}`,
        });
    }

    return issues;
}
