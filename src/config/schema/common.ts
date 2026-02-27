import { z } from 'zod';
import type { EnvSchemaDomain, EnvValidationIssue, EnvValidationSeverity } from './types';

const integerSchema = z.coerce.number().int();
const numericSchema = z.coerce.number();

const TRUE_SET = new Set(['1', 'true', 'yes', 'on']);
const FALSE_SET = new Set(['0', 'false', 'no', 'off']);

interface PushIssueArgs {
    issues: EnvValidationIssue[];
    domain: EnvSchemaDomain;
    severity: EnvValidationSeverity;
    code: string;
    message: string;
    envVar?: string;
}

export function pushIssue(args: PushIssueArgs): void {
    args.issues.push({
        domain: args.domain,
        severity: args.severity,
        code: args.code,
        message: args.message,
        envVar: args.envVar,
    });
}

export function readEnvString(env: NodeJS.ProcessEnv, envVar: string): string | undefined {
    const raw = env[envVar];
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed;
}

interface ParseOptionalIntegerArgs {
    env: NodeJS.ProcessEnv;
    envVar: string;
    domain: EnvSchemaDomain;
    issues: EnvValidationIssue[];
    min?: number;
    max?: number;
}

export function parseOptionalInteger(args: ParseOptionalIntegerArgs): number | undefined {
    const raw = readEnvString(args.env, args.envVar);
    if (raw === undefined) return undefined;

    const parsed = integerSchema.safeParse(raw);
    if (!parsed.success) {
        pushIssue({
            issues: args.issues,
            domain: args.domain,
            severity: 'error',
            code: `${args.envVar}_INVALID`,
            envVar: args.envVar,
            message: `${args.envVar} must be an integer, got "${raw}"`,
        });
        return undefined;
    }

    const value = parsed.data;
    if (typeof args.min === 'number' && value < args.min) {
        pushIssue({
            issues: args.issues,
            domain: args.domain,
            severity: 'error',
            code: `${args.envVar}_OUT_OF_RANGE`,
            envVar: args.envVar,
            message: `${args.envVar} must be >= ${args.min}, got ${value}`,
        });
    }
    if (typeof args.max === 'number' && value > args.max) {
        pushIssue({
            issues: args.issues,
            domain: args.domain,
            severity: 'error',
            code: `${args.envVar}_OUT_OF_RANGE`,
            envVar: args.envVar,
            message: `${args.envVar} must be <= ${args.max}, got ${value}`,
        });
    }

    return value;
}

interface ParseOptionalNumberArgs {
    env: NodeJS.ProcessEnv;
    envVar: string;
    domain: EnvSchemaDomain;
    issues: EnvValidationIssue[];
    min?: number;
    max?: number;
}

export function parseOptionalNumber(args: ParseOptionalNumberArgs): number | undefined {
    const raw = readEnvString(args.env, args.envVar);
    if (raw === undefined) return undefined;

    const parsed = numericSchema.safeParse(raw);
    if (!parsed.success) {
        pushIssue({
            issues: args.issues,
            domain: args.domain,
            severity: 'error',
            code: `${args.envVar}_INVALID`,
            envVar: args.envVar,
            message: `${args.envVar} must be numeric, got "${raw}"`,
        });
        return undefined;
    }

    const value = parsed.data;
    if (!Number.isFinite(value)) {
        pushIssue({
            issues: args.issues,
            domain: args.domain,
            severity: 'error',
            code: `${args.envVar}_INVALID`,
            envVar: args.envVar,
            message: `${args.envVar} must be finite, got "${raw}"`,
        });
        return undefined;
    }

    if (typeof args.min === 'number' && value < args.min) {
        pushIssue({
            issues: args.issues,
            domain: args.domain,
            severity: 'error',
            code: `${args.envVar}_OUT_OF_RANGE`,
            envVar: args.envVar,
            message: `${args.envVar} must be >= ${args.min}, got ${value}`,
        });
    }
    if (typeof args.max === 'number' && value > args.max) {
        pushIssue({
            issues: args.issues,
            domain: args.domain,
            severity: 'error',
            code: `${args.envVar}_OUT_OF_RANGE`,
            envVar: args.envVar,
            message: `${args.envVar} must be <= ${args.max}, got ${value}`,
        });
    }

    return value;
}

interface ParseOptionalBooleanArgs {
    env: NodeJS.ProcessEnv;
    envVar: string;
    domain: EnvSchemaDomain;
    issues: EnvValidationIssue[];
}

export function parseOptionalBoolean(args: ParseOptionalBooleanArgs): boolean | undefined {
    const raw = readEnvString(args.env, args.envVar);
    if (raw === undefined) return undefined;

    const normalized = raw.toLowerCase();
    if (TRUE_SET.has(normalized)) return true;
    if (FALSE_SET.has(normalized)) return false;

    pushIssue({
        issues: args.issues,
        domain: args.domain,
        severity: 'error',
        code: `${args.envVar}_INVALID`,
        envVar: args.envVar,
        message: `${args.envVar} must be a boolean-like value (true/false/1/0/yes/no/on/off), got "${raw}"`,
    });
    return undefined;
}

interface ParseOptionalEnumArgs {
    env: NodeJS.ProcessEnv;
    envVar: string;
    domain: EnvSchemaDomain;
    issues: EnvValidationIssue[];
    allowed: readonly string[];
}

export function parseOptionalEnum(args: ParseOptionalEnumArgs): string | undefined {
    const raw = readEnvString(args.env, args.envVar);
    if (raw === undefined) return undefined;

    const normalized = raw.toUpperCase();
    if (args.allowed.includes(normalized)) return normalized;

    pushIssue({
        issues: args.issues,
        domain: args.domain,
        severity: 'error',
        code: `${args.envVar}_INVALID`,
        envVar: args.envVar,
        message: `${args.envVar} must be one of ${args.allowed.join(', ')}, got "${raw}"`,
    });
    return undefined;
}
