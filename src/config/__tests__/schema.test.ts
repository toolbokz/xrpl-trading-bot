import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { validateAllEnv } from '../schema';

const ORIGINAL_ENV: NodeJS.ProcessEnv = { ...process.env };
const TEST_ENV_KEYS = [
    'XRPL_WSS_URL',
    'XRPL_ENDPOINT',
    'XRPL_WSS_URLS',
    'XRPL_REQUEST_TIMEOUT_MS',
    'XRPL_RESERVE_REQUEST_TIMEOUT_MS',
    'XRPL_CONNECT_TIMEOUT_MS',
    'XRPL_429_COOLDOWN_MS',
    'XRPL_MAX_RECONNECTS',
    'XRPL_RECONNECT_DELAY_MS',
    'XRPL_RECONNECT_MAX_DELAY_MS',
    'XRPL_INITIAL_RECONNECT_DELAY_MS',
    'XRPL_MAX_RECONNECT_DELAY_MS',
    'MAX_EXPOSURE_PER_ISSUER',
    'MAX_TRADE_SIZE',
    'POSITION_SIZE_XRP',
    'MAX_DAILY_LOSS_XRP',
    'CONSECUTIVE_FAILURE_KILL_SWITCH',
    'EXECUTION_SLIPPAGE_BPS_DEFAULT',
    'EXECUTION_MAX_SLIPPAGE_BPS_VS_MID',
    'EXECUTION_ALLOW_PARTIAL_SIZING',
    'BOT_LOCAL_ONLY',
    'BOT_ALLOW_REMOTE',
    'BOT_API_DEV_MODE',
    'SINGLE_PROCESS_MODE',
    'LOCAL_API_TOKEN',
];

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    for (const key of TEST_ENV_KEYS) {
        delete process.env[key];
    }
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

describe('config schema aggregation', () => {
    it('reports error when XRPL endpoint is missing', () => {
        const report = validateAllEnv(process.env);
        const codes = report.issues.map((issue) => issue.code);

        expect(codes).toContain('XRPL_ENDPOINT_REQUIRED');
        expect(report.ok).toBe(false);
    });

    it('reports error for invalid numeric timeout', () => {
        process.env.XRPL_WSS_URL = 'wss://xrplcluster.com';
        process.env.XRPL_REQUEST_TIMEOUT_MS = 'not-a-number';

        const report = validateAllEnv(process.env);
        const timeoutIssue = report.issues.find((issue) => issue.envVar === 'XRPL_REQUEST_TIMEOUT_MS');

        expect(timeoutIssue).toBeDefined();
        expect(timeoutIssue?.severity).toBe('error');
        expect(report.ok).toBe(false);
    });

    it('allows optional vars to be absent', () => {
        process.env.XRPL_WSS_URL = 'wss://xrplcluster.com';

        const report = validateAllEnv(process.env);
        const errorIssues = report.issues.filter((issue) => issue.severity === 'error');

        expect(report.ok).toBe(true);
        expect(errorIssues).toHaveLength(0);
    });
});
