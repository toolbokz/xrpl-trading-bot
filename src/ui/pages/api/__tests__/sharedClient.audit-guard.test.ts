import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockClient {
    connected = false;

    constructor(_url: string, _options?: unknown) {}

    async connect(): Promise<void> {
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }

    on(_event: string, _handler: (...args: unknown[]) => void): void {}
}

const { mockLoggerWarn } = vi.hoisted(() => ({
    mockLoggerWarn: vi.fn(),
}));

vi.mock('xrpl', () => ({
    Client: vi.fn().mockImplementation(function (url: string, options?: unknown) {
        return new MockClient(url, options);
    }),
}));

vi.mock('../../../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: mockLoggerWarn,
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import {
    getXrplClient,
    disconnectXrplClient,
    __resetForTesting,
    __setConfigForTesting,
    MissingApiRouteContextError,
} from '../../../../xrpl/sharedClient';
import { markApiRouteContext, runWithRequestContext } from '../../../../xrpl/guard';

describe('sharedClient API-route context invariant', () => {
    const originalAuditFlag = process.env.FEATURE_AUDIT_GUARDS;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSingleProcess = process.env.SINGLE_PROCESS_MODE;

    beforeEach(() => {
        vi.clearAllMocks();
        __resetForTesting();
        __setConfigForTesting({
            cooldown429Ms: 10,
            connectTimeoutMs: 50,
            maxReconnectDelayMs: 50,
            initialReconnectDelayMs: 5,
            minConnectIntervalMs: 0,
        });
        delete process.env.SINGLE_PROCESS_MODE;
    });

    afterEach(async () => {
        await disconnectXrplClient();
        __resetForTesting();

        if (typeof originalAuditFlag === 'string') process.env.FEATURE_AUDIT_GUARDS = originalAuditFlag;
        else delete process.env.FEATURE_AUDIT_GUARDS;

        if (typeof originalNodeEnv === 'string') process.env.NODE_ENV = originalNodeEnv;
        else delete process.env.NODE_ENV;

        if (typeof originalSingleProcess === 'string') process.env.SINGLE_PROCESS_MODE = originalSingleProcess;
        else delete process.env.SINGLE_PROCESS_MODE;
    });

    it('does not enforce missing-route-context invariant when FEATURE_AUDIT_GUARDS=0', async () => {
        process.env.FEATURE_AUDIT_GUARDS = '0';
        process.env.NODE_ENV = 'development';

        await expect(runWithRequestContext(async () => {
            const client = await getXrplClient();
            expect(client).toBeDefined();
        })).resolves.toBeUndefined();

        expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('logs warning and throws in non-production when request context exists without API route context', async () => {
        process.env.FEATURE_AUDIT_GUARDS = '1';
        process.env.NODE_ENV = 'development';

        await expect(runWithRequestContext(async () => {
            await getXrplClient();
        })).rejects.toThrow(MissingApiRouteContextError);

        expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    });

    it('allows shared client access when API route context is present', async () => {
        process.env.FEATURE_AUDIT_GUARDS = '1';
        process.env.NODE_ENV = 'development';

        await expect(runWithRequestContext(async () => {
            markApiRouteContext();
            const client = await getXrplClient();
            expect(client).toBeDefined();
        })).resolves.toBeUndefined();

        expect(mockLoggerWarn).not.toHaveBeenCalled();
    });
});
