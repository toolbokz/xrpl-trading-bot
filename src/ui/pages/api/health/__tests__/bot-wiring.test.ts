import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBuildBotWiringHealthReport } = vi.hoisted(() => ({
    mockBuildBotWiringHealthReport: vi.fn(),
}));

vi.mock('../../../../lib/health/botWiringHealth', () => ({
    buildBotWiringHealthReport: mockBuildBotWiringHealthReport,
}));

vi.mock('../../../../lib/localApi', () => ({
    withLocalApi: (handler: Function) => handler,
}));

vi.mock('../../../../../analytics/logger', () => ({
    logger: {
        error: vi.fn(),
    },
}));

import handler from '../bot-wiring';

function createMockReq() {
    return {
        method: 'GET',
        requestId: 'req-health-bot-wiring-001',
    } as any;
}

function createMockRes() {
    const res: any = {
        statusCode: 0,
        body: null,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(data: unknown) {
            res.body = data;
            return res;
        },
    };
    return res;
}

describe('GET /api/health/bot-wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 200 when wiring checks pass', async () => {
        mockBuildBotWiringHealthReport.mockResolvedValue({
            ok: true,
            timestamp: '2026-02-23T00:00:00.000Z',
            checks: {
                config: { ok: true, strictEnabled: false, failFast: false, environment: 'development', issues: [] },
                db: { ok: true, latencyMs: 1, detail: 'ok' },
                redis: { ok: true, enabled: false, latencyMs: null, detail: 'skipped' },
                xrplServerInfo: { ok: true, latencyMs: 2, detail: 'ok', data: { validatedLedger: 1, networkId: 0 } },
                orderBook: { ok: true, latencyMs: 3, detail: 'ok', data: { pairKey: 'XRP/RLUSD', offers: 1, ledgerIndex: 1 } },
                worker: {
                    ok: true,
                    liveness: 'OK',
                    mode: 'single',
                    botState: 'RUNNING',
                    runtimeStarted: true,
                    runtimeReady: true,
                    warmingUp: false,
                    heartbeatMaxAgeMs: 15000,
                    heartbeat: {
                        ts: 1771800000000,
                        tickId: 7,
                        ageMs: 1000,
                        inFlight: false,
                        lastError: null,
                        lastSubmitTs: 1771799999000,
                        lastValidatedTs: 1771799999500,
                    },
                    detail: 'ok',
                },
            },
            warnings: [],
        });

        const req = createMockReq();
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.requestId).toBe('req-health-bot-wiring-001');
    });

    it('returns 503 when wiring checks report degraded status', async () => {
        mockBuildBotWiringHealthReport.mockResolvedValue({
            ok: false,
            timestamp: '2026-02-23T00:00:00.000Z',
            checks: {
                config: { ok: false, strictEnabled: false, failFast: false, environment: 'development', issues: [] },
                db: { ok: false, latencyMs: 1, detail: 'db down' },
                redis: { ok: true, enabled: false, latencyMs: null, detail: 'skipped' },
                xrplServerInfo: { ok: false, latencyMs: 2, detail: 'down', data: { validatedLedger: null, networkId: null } },
                orderBook: { ok: false, latencyMs: 3, detail: 'down', data: { pairKey: 'XRP/RLUSD', offers: 0, ledgerIndex: null } },
                worker: {
                    ok: true,
                    liveness: 'OK',
                    mode: 'single',
                    botState: 'STOPPED',
                    runtimeStarted: false,
                    runtimeReady: false,
                    warmingUp: false,
                    heartbeatMaxAgeMs: 15000,
                    heartbeat: null,
                    detail: 'stopped',
                },
            },
            warnings: ['xrpl-server-info-failed'],
        });

        const req = createMockReq();
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.body.ok).toBe(false);
    });

    it('returns 500 when health probe throws', async () => {
        mockBuildBotWiringHealthReport.mockRejectedValue(new Error('probe boom'));

        const req = createMockReq();
        const res = createMockRes();
        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual(expect.objectContaining({
            ok: false,
            error: 'probe boom',
            requestId: 'req-health-bot-wiring-001',
        }));
    });
});
