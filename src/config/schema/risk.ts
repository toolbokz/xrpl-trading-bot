import { parseOptionalInteger, parseOptionalNumber, pushIssue } from './common';
import type { EnvValidationIssue } from './types';

export function validateRiskEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationIssue[] {
    const issues: EnvValidationIssue[] = [];

    const maxExposure = parseOptionalNumber({ env, envVar: 'MAX_EXPOSURE_PER_ISSUER', domain: 'risk', issues, min: 0 });
    const maxTradeSize = parseOptionalNumber({ env, envVar: 'MAX_TRADE_SIZE', domain: 'risk', issues, min: 0 });
    const positionSize = parseOptionalNumber({ env, envVar: 'POSITION_SIZE_XRP', domain: 'risk', issues, min: 0 });
    const maxDailyLoss = parseOptionalNumber({ env, envVar: 'MAX_DAILY_LOSS_XRP', domain: 'risk', issues, min: 0 });

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

    if (typeof positionSize === 'number' && positionSize <= 0) {
        pushIssue({
            issues,
            domain: 'risk',
            severity: 'error',
            code: 'POSITION_SIZE_XRP_NON_POSITIVE',
            envVar: 'POSITION_SIZE_XRP',
            message: `POSITION_SIZE_XRP must be > 0, got ${positionSize}`,
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
