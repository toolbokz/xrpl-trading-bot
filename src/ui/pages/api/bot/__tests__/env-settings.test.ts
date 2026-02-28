import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – hoisted so they're available before module load
// ---------------------------------------------------------------------------

const { mockReadFileSync, mockWriteFileSync, mockExistsSync, mockAccessSync } = vi.hoisted(() => ({
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockExistsSync: vi.fn(),
    mockAccessSync: vi.fn(),
}));

vi.mock('fs', () => ({
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
    accessSync: mockAccessSync,
    constants: { R_OK: 4, W_OK: 2 },
}));

vi.mock('path', async () => {
    const actual = await vi.importActual<typeof import('path')>('path');
    return { ...actual };
});

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
    jsonError: (res: any, status: number, error: string, requestId: string) => {
        res.status(status).json({ error, requestId });
    },
}));

vi.mock('../../../../lib/localApi/withApiRouteContext', () => ({
    withApiRouteContext: (handler: Function) => handler,
}));

vi.mock('../../../../lib/localApi/audit', () => ({
    logSensitiveAction: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import handler after mocks are set up
// ---------------------------------------------------------------------------

import handler from '../env-settings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_ENV = [
    'LOG_LEVEL=info',
    'PAPER_TRADING=true',
    'MAX_TRADE_SIZE=500',
    'XRPL_NETWORK=testnet',
    '# BOT_LOCAL_ONLY=true',
    'BOT_LOCAL_ONLY=true',
    'EDGE_COST_GATE_ENABLED=true',
    'EDGE_ESTIMATE_MULTIPLIER_BPS=5',
].join('\n');

function createMockReq(overrides: Record<string, unknown> = {}) {
    return {
        method: 'GET',
        requestId: 'test-req-env-001',
        parsedBody: null,
        ...overrides,
    } as any;
}

function createMockRes() {
    const res: any = {
        statusCode: 0,
        body: null as any,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(data: any) {
            res.body = data;
            return res;
        },
    };
    return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/bot/env-settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: deployed path doesn't exist → use CWD fallback
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue(SAMPLE_ENV);
    });

    it('returns grouped settings with values from .env', async () => {
        const req = createMockReq();
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.groups).toBeDefined();
        expect(Array.isArray(res.body.groups)).toBe(true);
        // Find the edge-cost group
        const edgeCostGroup = res.body.groups.find((g: any) => g.id === 'edge-cost');
        expect(edgeCostGroup).toBeDefined();
        const gateEnabled = edgeCostGroup.settings.find((s: any) => s.key === 'EDGE_COST_GATE_ENABLED');
        expect(gateEnabled).toBeDefined();
        expect(gateEnabled.value).toBe('true');
    });

    it('redacts sensitive keys', async () => {
        mockReadFileSync.mockReturnValue('XRPL_SECRET_NUMBERS_MAINNET_ENC=mySecret123\nLOG_LEVEL=info');
        const req = createMockReq();
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        const allSettings = res.body.groups.flatMap((g: any) => g.settings);
        const secret = allSettings.find((s: any) => s.key === 'XRPL_SECRET_NUMBERS_MAINNET_ENC');
        // Redacted keys should not exist in any group since they're in security group
        // but if found, the value should be redacted
        if (secret) {
            expect(secret.value).toBe('••••••');
        }
    });

    it('marks read-only keys correctly', async () => {
        const req = createMockReq();
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        const allSettings = res.body.groups.flatMap((g: any) => g.settings);
        const botLocalOnly = allSettings.find((s: any) => s.key === 'BOT_LOCAL_ONLY');
        expect(botLocalOnly).toBeDefined();
        expect(botLocalOnly.readOnly).toBe(true);
    });

    it('returns 500 when .env cannot be read', async () => {
        mockReadFileSync.mockImplementation(() => {
            throw new Error('ENOENT: no such file or directory');
        });

        const req = createMockReq();
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toMatch(/Failed to read \.env/);
    });
});

describe('PUT /api/bot/env-settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue(SAMPLE_ENV);
        mockWriteFileSync.mockImplementation(() => { });
    });

    it('updates a writable setting and writes to .env', async () => {
        const req = createMockReq({
            method: 'PUT',
            parsedBody: { changes: { EDGE_ESTIMATE_MULTIPLIER_BPS: '10' } },
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.applied).toContain('EDGE_ESTIMATE_MULTIPLIER_BPS');
        expect(res.body.blocked).toEqual([]);
        // Verify writeFileSync was called with updated content
        expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
        const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
        expect(writtenContent).toContain('EDGE_ESTIMATE_MULTIPLIER_BPS=10');
    });

    it('applies multiple changes at once', async () => {
        const req = createMockReq({
            method: 'PUT',
            parsedBody: {
                changes: {
                    EDGE_COST_GATE_ENABLED: 'false',
                    EDGE_ESTIMATE_MULTIPLIER_BPS: '20',
                    LOG_LEVEL: 'debug',
                },
            },
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.applied).toHaveLength(3);
        const written = mockWriteFileSync.mock.calls[0][1] as string;
        expect(written).toContain('EDGE_COST_GATE_ENABLED=false');
        expect(written).toContain('EDGE_ESTIMATE_MULTIPLIER_BPS=20');
        expect(written).toContain('LOG_LEVEL=debug');
    });

    it('blocks read-only keys', async () => {
        const req = createMockReq({
            method: 'PUT',
            parsedBody: { changes: { BOT_LOCAL_ONLY: 'false', LOG_LEVEL: 'debug' } },
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.blocked).toContain('BOT_LOCAL_ONLY');
        expect(res.body.applied).toContain('LOG_LEVEL');
        expect(res.body.applied).not.toContain('BOT_LOCAL_ONLY');
    });

    it('blocks redacted / sensitive keys', async () => {
        const req = createMockReq({
            method: 'PUT',
            parsedBody: { changes: { XRPL_SECRET_NUMBERS_MAINNET_ENC: 'hack' } },
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.blocked).toContain('XRPL_SECRET_NUMBERS_MAINNET_ENC');
        expect(res.body.applied).toEqual([]);
    });

    it('returns 400 when body has no changes field', async () => {
        const req = createMockReq({
            method: 'PUT',
            parsedBody: { wrong: 'shape' },
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/changes/);
    });

    it('returns 500 when .env file is not writable (EROFS)', async () => {
        mockWriteFileSync.mockImplementation(() => {
            throw new Error('EROFS: read-only file system, open \'/opt/xrpl-trading-bot/.env\'');
        });

        const req = createMockReq({
            method: 'PUT',
            parsedBody: { changes: { LOG_LEVEL: 'debug' } },
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toMatch(/Failed to write \.env/);
        expect(res.body.error).toMatch(/EROFS/);
    });

    it('appends a new key when it does not exist in .env', async () => {
        mockReadFileSync.mockReturnValue('LOG_LEVEL=info\n');
        const req = createMockReq({
            method: 'PUT',
            parsedBody: { changes: { EDGE_COST_GATE_ENABLED: 'true' } },
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        const written = mockWriteFileSync.mock.calls[0][1] as string;
        expect(written).toContain('EDGE_COST_GATE_ENABLED=true');
        // Original content should still be present
        expect(written).toContain('LOG_LEVEL=info');
    });
});

describe('envFilePath — write-access check', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('falls back to CWD when deployed path exists but is not writable', async () => {
        // Deployed path exists but accessSync throws (not writable)
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockImplementation(() => {
            throw new Error('EROFS');
        });
        mockReadFileSync.mockReturnValue('LOG_LEVEL=info');

        const req = createMockReq();
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        // filePath should NOT be the deployed path
        expect(res.body.filePath).not.toBe('/opt/xrpl-trading-bot/.env');
    });

    it('uses deployed path when it exists and is writable', async () => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockImplementation(() => { }); // no throw = writable
        mockReadFileSync.mockReturnValue('LOG_LEVEL=info');

        const req = createMockReq();
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.filePath).toBe('/opt/xrpl-trading-bot/.env');
    });
});

describe('method validation', () => {
    it('returns 405 for POST requests', async () => {
        mockExistsSync.mockReturnValue(false);
        const req = createMockReq({ method: 'POST' });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(405);
    });
});
