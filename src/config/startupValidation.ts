import { z } from 'zod';
import { loadConfig, type AppConfig } from './index';
import { isStrictConfigEnabled } from './featureFlags';
import { validateAllEnv } from './schema';

export type StartupValidationSeverity = 'error' | 'warning';
export type StartupEnvironment = 'development' | 'staging' | 'production' | 'test';

export interface StartupValidationIssue {
    code: string;
    severity: StartupValidationSeverity;
    message: string;
    envVar?: string | undefined;
}

export interface StartupValidationReport {
    ok: boolean;
    strictEnabled: boolean;
    failFast: boolean;
    environment: StartupEnvironment;
    checkedAtMs: number;
    issues: StartupValidationIssue[];
}

export interface StartupValidationLogger {
    info: (meta: Record<string, unknown>, message: string) => void;
    warn: (meta: Record<string, unknown>, message: string) => void;
}

const appConfigSchema = z.object({
    xrpl: z.object({
        endpoint: z.string().min(1),
        network: z.string().min(1),
        maxReconnects: z.number().int().min(1),
        initialReconnectDelayMs: z.number().int().min(0),
        maxReconnectDelayMs: z.number().int().min(0),
    }),
    tradingPair: z.object({
        baseCurrency: z.string().min(1),
        baseIssuer: z.string().optional(),
        quoteCurrency: z.string().min(1),
        quoteIssuer: z.string().optional(),
    }),
    paperTrading: z.boolean(),
    risk: z.object({
        maxExposurePerIssuer: z.number().positive(),
        maxTradeSize: z.number().positive(),
        maxDailyLoss: z.number().positive(),
        reserveFloorXRP: z.number().min(0),
    }),
    strategy: z.object({
        positionSize: z.number().positive(),
        maxSpreadBps: z.number().min(0),
        maxExitSpreadBps: z.number().min(0),
        maxSlippageBps: z.number().min(0),
        orderBookStaleMs: z.number().int().positive(),
        cooldownMs: z.number().int().min(0),
    }),
});

const fallbackLogger: StartupValidationLogger = {
    info: (meta, message) => console.info(message, meta),
    warn: (meta, message) => console.warn(message, meta),
};

let lastLoggedSignature: string | null = null;

function resolveEnvironment(env: NodeJS.ProcessEnv): StartupEnvironment {
    const nodeEnv = (env.NODE_ENV ?? '').toLowerCase();
    const appEnv = (env.APP_ENV ?? '').toLowerCase();

    if (nodeEnv === 'test') return 'test';
    if (nodeEnv === 'production') return 'production';
    if (appEnv === 'staging' || appEnv === 'stage') return 'staging';
    return 'development';
}

function hasWalletCredential(env: NodeJS.ProcessEnv): boolean {
    return [
        env.XRPL_SEED,
        env.XRPL_SECRET,
        env.XRPL_SEED_MAINNET,
        env.XRPL_SECRET_MAINNET,
        env.XRPL_SEED_TESTNET,
        env.XRPL_SECRET_TESTNET,
        env.XRPL_SECRET_NUMBERS,
        env.XRPL_SECRET_NUMBERS_MAINNET,
        env.XRPL_SECRET_NUMBERS_TESTNET,
    ].some((value) => typeof value === 'string' && value.trim().length > 0);
}

function isXrp(code: string): boolean {
    return code.trim().toUpperCase() === 'XRP';
}

function buildIssues(
    env: NodeJS.ProcessEnv,
    config: AppConfig,
): StartupValidationIssue[] {
    const issues: StartupValidationIssue[] = [];

    const envValidation = validateAllEnv(env);
    for (const envIssue of envValidation.issues) {
        issues.push({
            code: envIssue.code,
            severity: envIssue.severity,
            message: envIssue.message,
            envVar: envIssue.envVar,
        });
    }

    const cfgValidation = appConfigSchema.safeParse(config);
    if (!cfgValidation.success) {
        for (const issue of cfgValidation.error.issues) {
            issues.push({
                code: 'CONFIG_SCHEMA_INVALID',
                severity: 'error',
                message: `${issue.path.join('.')}: ${issue.message}`,
            });
        }
    }

    if (!/^wss?:\/\//i.test(config.xrpl.endpoint)) {
        issues.push({
            code: 'XRPL_ENDPOINT_INVALID',
            severity: 'error',
            envVar: 'XRPL_WSS_URL/XRPL_ENDPOINT',
            message: `XRPL endpoint must be ws:// or wss://, got "${config.xrpl.endpoint}"`,
        });
    }

    if (config.tradingPair.baseCurrency.toUpperCase() === config.tradingPair.quoteCurrency.toUpperCase()) {
        issues.push({
            code: 'PAIR_IDENTICAL_ASSETS',
            severity: 'error',
            message: `Trading pair assets must differ: ${config.tradingPair.baseCurrency}/${config.tradingPair.quoteCurrency}`,
        });
    }

    if (!isXrp(config.tradingPair.baseCurrency) && !config.tradingPair.baseIssuer) {
        issues.push({
            code: 'BASE_ISSUER_REQUIRED',
            severity: 'error',
            envVar: 'TRADE_BASE_ISSUER',
            message: `Base currency ${config.tradingPair.baseCurrency} requires TRADE_BASE_ISSUER`,
        });
    }

    if (!isXrp(config.tradingPair.quoteCurrency) && !config.tradingPair.quoteIssuer) {
        issues.push({
            code: 'QUOTE_ISSUER_REQUIRED',
            severity: 'error',
            envVar: 'TRADE_QUOTE_ISSUER',
            message: `Quote currency ${config.tradingPair.quoteCurrency} requires TRADE_QUOTE_ISSUER`,
        });
    }

    if (config.paperTrading === false && !hasWalletCredential(env)) {
        issues.push({
            code: 'LIVE_WALLET_CREDENTIALS_MISSING',
            severity: 'error',
            envVar: 'XRPL_SEED/XRPL_SECRET/XRPL_SECRET_NUMBERS',
            message: 'Live trading requires wallet credentials',
        });
    }

    const positionSize = config.strategy?.positionSize;
    const maxTradeSize = config.risk?.maxTradeSize;
    if (typeof positionSize === 'number' && typeof maxTradeSize === 'number' && positionSize > maxTradeSize) {
        issues.push({
            code: 'POSITION_GT_MAX_TRADE',
            severity: 'warning',
            envVar: 'POSITION_SIZE_XRP/MAX_TRADE_SIZE',
            message: `POSITION_SIZE_XRP (${positionSize}) exceeds MAX_TRADE_SIZE (${maxTradeSize})`,
        });
    }

    return issues;
}

function buildIssueSignature(issues: StartupValidationIssue[], strictEnabled: boolean, environment: StartupEnvironment): string {
    const compact = issues
        .map((issue) => `${issue.severity}:${issue.code}:${issue.message}`)
        .sort()
        .join('|');
    return `${environment}|strict=${strictEnabled}|${compact}`;
}

export function summarizeIssues(issues: StartupValidationIssue[]): string {
    if (issues.length === 0) return 'none';
    return issues
        .map((issue) => {
            const envLabel = issue.envVar ? ` (${issue.envVar})` : '';
            return `[${issue.severity}] ${issue.code}${envLabel}: ${issue.message}`;
        })
        .join('; ');
}

export function validateStartupConfig(
    env: NodeJS.ProcessEnv = process.env,
    config: AppConfig = loadConfig(),
): StartupValidationReport {
    const strictEnabled = isStrictConfigEnabled(env);
    const environment = resolveEnvironment(env);
    // Keep current behavior from audit hardening: strict mode fails fast in non-production only.
    const failFast = strictEnabled && environment !== 'production';
    const issues = buildIssues(env, config);
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;

    return {
        ok: errorCount === 0,
        strictEnabled,
        failFast,
        environment,
        checkedAtMs: Date.now(),
        issues,
    };
}

export function enforceStartupConfigValidation(
    env: NodeJS.ProcessEnv = process.env,
    config: AppConfig = loadConfig(),
    logger: StartupValidationLogger = fallbackLogger,
): StartupValidationReport {
    const report = validateStartupConfig(env, config);
    const signature = buildIssueSignature(report.issues, report.strictEnabled, report.environment);

    if (signature !== lastLoggedSignature) {
        const errorIssues = report.issues.filter((issue) => issue.severity === 'error');
        const warningIssues = report.issues.filter((issue) => issue.severity === 'warning');

        logger.info({
            strictEnabled: report.strictEnabled,
            environment: report.environment,
            errorCount: errorIssues.length,
            warningCount: warningIssues.length,
        }, '[StartupValidation] Configuration check complete');

        if (errorIssues.length > 0 || warningIssues.length > 0) {
            logger.warn({
                strictEnabled: report.strictEnabled,
                failFast: report.failFast,
                issues: report.issues,
            }, '[StartupValidation] Configuration issues detected');
        }

        lastLoggedSignature = signature;
    }

    if (report.strictEnabled && report.failFast) {
        const hasErrors = report.issues.some((issue) => issue.severity === 'error');
        if (hasErrors) {
            throw new Error(
                `Strict config validation failed: ${summarizeIssues(report.issues.filter((issue) => issue.severity === 'error'))}`
            );
        }
    }

    return report;
}

export function __resetStartupValidationForTests(): void {
    lastLoggedSignature = null;
}
