/**
 * Unit tests for web/lib/localApi/withLocalApi.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Socket } from 'net';

describe('withLocalApi middleware', () => {
    beforeEach(() => {
        vi.resetModules();
        // Clear LOCAL_API_TOKEN
        delete process.env.LOCAL_API_TOKEN;
    });

    const createMockReq = (overrides: Partial<{
        socket: Partial<Socket>;
        headers: Record<string, string | string[] | undefined>;
        method: string;
        url: string;
        body: unknown;
        query: Record<string, string | string[] | undefined>;
    }> = {}): NextApiRequest => {
        const req = {
            socket: { remoteAddress: '127.0.0.1', ...overrides.socket },
            headers: overrides.headers || {},
            method: overrides.method || 'GET',
            url: overrides.url || '/api/test',
            body: overrides.body,
            query: overrides.query || {},
            on: vi.fn((event, cb) => {
                if (event === 'end') cb();
                return req;
            }),
        } as unknown as NextApiRequest;
        return req;
    };

    const createMockRes = () => {
        const res: Partial<NextApiResponse> = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            send: vi.fn().mockReturnThis(),
            setHeader: vi.fn().mockReturnThis(),
        };
        return res as NextApiResponse;
    };

    describe('isLocalRequest', () => {
        it('should allow localhost request (127.0.0.1)', async () => {
            const { isLocalRequest } = await import('../localApi/withLocalApi');
            const req = createMockReq({ socket: { remoteAddress: '127.0.0.1' } });
            const result = isLocalRequest(req);
            expect(result.allowed).toBe(true);
        });

        it('should allow localhost request (::1)', async () => {
            const { isLocalRequest } = await import('../localApi/withLocalApi');
            const req = createMockReq({ socket: { remoteAddress: '::1' } });
            const result = isLocalRequest(req);
            expect(result.allowed).toBe(true);
        });

        it('should reject request with X-Forwarded-For header', async () => {
            const { isLocalRequest } = await import('../localApi/withLocalApi');
            const req = createMockReq({
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-forwarded-for': '203.0.113.195' },
            });
            const result = isLocalRequest(req);
            expect(result.allowed).toBe(false);
            if (!result.allowed) {
                expect(result.reason).toContain('x-forwarded-for');
            }
        });

        it('should reject request with X-Real-IP header', async () => {
            const { isLocalRequest } = await import('../localApi/withLocalApi');
            const req = createMockReq({
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-real-ip': '203.0.113.195' },
            });
            const result = isLocalRequest(req);
            expect(result.allowed).toBe(false);
            if (!result.allowed) {
                expect(result.reason).toContain('x-real-ip');
            }
        });

        it('should reject remote IP', async () => {
            const { isLocalRequest } = await import('../localApi/withLocalApi');
            const req = createMockReq({ socket: { remoteAddress: '203.0.113.195' } });
            const result = isLocalRequest(req);
            expect(result.allowed).toBe(false);
            if (!result.allowed) {
                expect(result.reason).toContain('203.0.113.195');
            }
        });
    });

    describe('withLocalApi wrapper', () => {
        it('should call handler for localhost request', async () => {
            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, { methods: ['GET'] });

            const req = createMockReq();
            const res = createMockRes();

            await wrapped(req, res);
            expect(handler).toHaveBeenCalled();
        });

        it('should reject remote requests with 403', async () => {
            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq({ socket: { remoteAddress: '203.0.113.195' } });
            const res = createMockRes();

            await wrapped(req, res);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                error: 'Remote access denied',
            }));
            expect(handler).not.toHaveBeenCalled();
        });

        it('should reject wrong HTTP method with 405', async () => {
            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, { methods: ['POST'] });

            const req = createMockReq({ method: 'GET' });
            const res = createMockRes();

            await wrapped(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
            expect(handler).not.toHaveBeenCalled();
        });

        it('should set X-Request-ID header', async () => {
            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq();
            const res = createMockRes();

            await wrapped(req, res);
            expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String));
        });

        it('should pass through existing X-Request-ID', async () => {
            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq({ headers: { 'x-request-id': 'existing-id' } });
            const res = createMockRes();

            await wrapped(req, res);
            expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'existing-id');
        });

        it('should attach requestId to LocalRequest', async () => {
            const { withLocalApi } = await import('../localApi/withLocalApi');
            let capturedReq: any;
            const handler = vi.fn((req) => { capturedReq = req; });
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq();
            const res = createMockRes();

            await wrapped(req, res);
            expect(capturedReq.requestId).toBeDefined();
            expect(typeof capturedReq.requestId).toBe('string');
        });
    });

    describe('LOCAL_API_TOKEN validation', () => {
        it('should allow request when token not configured', async () => {
            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq();
            const res = createMockRes();

            await wrapped(req, res);
            expect(handler).toHaveBeenCalled();
        });

        it('should reject when token required but not provided', async () => {
            process.env.LOCAL_API_TOKEN = 'secret-token';
            vi.resetModules();

            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq();
            const res = createMockRes();

            await wrapped(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(handler).not.toHaveBeenCalled();
        });

        it('should allow when correct token provided', async () => {
            process.env.LOCAL_API_TOKEN = 'secret-token';
            vi.resetModules();

            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq({ headers: { 'x-local-api-token': 'secret-token' } });
            const res = createMockRes();

            await wrapped(req, res);
            expect(handler).toHaveBeenCalled();
        });

        it('should reject when wrong token provided', async () => {
            process.env.LOCAL_API_TOKEN = 'secret-token';
            vi.resetModules();

            const { withLocalApi } = await import('../localApi/withLocalApi');
            const handler = vi.fn();
            const wrapped = withLocalApi(handler, {});

            const req = createMockReq({ headers: { 'x-local-api-token': 'wrong-token' } });
            const res = createMockRes();

            await wrapped(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
