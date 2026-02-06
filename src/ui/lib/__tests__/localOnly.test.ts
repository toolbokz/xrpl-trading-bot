/**
 * Unit tests for src/ui/lib/security/localOnly.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextApiRequest } from 'next';

// Mock process.env before importing the module
const originalEnv = process.env;

describe('web localOnly security module', () => {
    beforeEach(() => {
        // Reset environment for each test
        vi.resetModules();
        process.env = { ...originalEnv };
        // Clear all cloud detection env vars
        delete process.env.VERCEL;
        delete process.env.VERCEL_ENV;
        delete process.env.NOW_REGION;
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
        delete process.env.AWS_EXECUTION_ENV;
        delete process.env.GOOGLE_CLOUD_PROJECT;
        delete process.env.KUBERNETES_SERVICE_HOST;
        delete process.env.BOT_LOCAL_ONLY;
        delete process.env.BOT_ALLOW_REMOTE;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('isCloudEnvironment', () => {
        it('should return null when not in cloud', async () => {
            const { isCloudEnvironment } = await import('../security/localOnly');
            expect(isCloudEnvironment()).toBeNull();
        });

        it('should detect Vercel', async () => {
            process.env.VERCEL = '1';
            const { isCloudEnvironment } = await import('../security/localOnly');
            expect(isCloudEnvironment()).toBe('Vercel');
        });

        it('should detect AWS Lambda', async () => {
            process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
            const { isCloudEnvironment } = await import('../security/localOnly');
            expect(isCloudEnvironment()).toBe('AWS');
        });

        it('should detect Google Cloud', async () => {
            process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
            const { isCloudEnvironment } = await import('../security/localOnly');
            expect(isCloudEnvironment()).toBe('Google Cloud Platform');
        });
    });

    describe('isLocalhostIp', () => {
        it('should return true for 127.0.0.1', async () => {
            const { isLocalhostIp } = await import('../security/localOnly');
            expect(isLocalhostIp('127.0.0.1')).toBe(true);
        });

        it('should return true for ::1', async () => {
            const { isLocalhostIp } = await import('../security/localOnly');
            expect(isLocalhostIp('::1')).toBe(true);
        });

        it('should return true for ::ffff:127.0.0.1', async () => {
            const { isLocalhostIp } = await import('../security/localOnly');
            expect(isLocalhostIp('::ffff:127.0.0.1')).toBe(true);
        });

        it('should return false for external IPs', async () => {
            const { isLocalhostIp } = await import('../security/localOnly');
            expect(isLocalhostIp('192.168.1.1')).toBe(false);
            expect(isLocalhostIp('8.8.8.8')).toBe(false);
        });

        it('should return false for undefined', async () => {
            const { isLocalhostIp } = await import('../security/localOnly');
            expect(isLocalhostIp(undefined)).toBe(false);
        });
    });

    describe('getClientIpInfo', () => {
        it('should extract remoteAddress', async () => {
            const { getClientIpInfo } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: {},
            } as unknown as NextApiRequest;

            const info = getClientIpInfo(mockReq);
            expect(info.remoteAddress).toBe('127.0.0.1');
            expect(info.forwardedFor).toBeUndefined();
            expect(info.proxyDetected).toBe(false);
        });

        it('should detect proxy when X-Forwarded-For is present', async () => {
            const { getClientIpInfo } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-forwarded-for': '192.168.1.100' },
            } as unknown as NextApiRequest;

            const info = getClientIpInfo(mockReq);
            expect(info.remoteAddress).toBe('127.0.0.1');
            expect(info.forwardedFor).toBe('192.168.1.100');
            expect(info.proxyDetected).toBe(true);
        });

        it('should detect proxy when X-Real-IP is present', async () => {
            const { getClientIpInfo } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-real-ip': '10.0.0.50' },
            } as unknown as NextApiRequest;

            const info = getClientIpInfo(mockReq);
            expect(info.proxyDetected).toBe(true);
        });
    });

    describe('validateLocalhostRequest', () => {
        it('should allow localhost requests', async () => {
            const { validateLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: {},
            } as unknown as NextApiRequest;

            const result = validateLocalhostRequest(mockReq);
            expect(result.allowed).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it('should allow ::1 (IPv6 localhost)', async () => {
            const { validateLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '::1' },
                headers: {},
            } as unknown as NextApiRequest;

            const result = validateLocalhostRequest(mockReq);
            expect(result.allowed).toBe(true);
        });

        it('should reject external IP', async () => {
            const { validateLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '192.168.1.100' },
                headers: {},
            } as unknown as NextApiRequest;

            const result = validateLocalhostRequest(mockReq);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Remote access disabled');
        });

        it('should reject request with X-Forwarded-For (proxy detected)', async () => {
            const { validateLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-forwarded-for': '192.168.1.100' },
            } as unknown as NextApiRequest;

            const result = validateLocalhostRequest(mockReq);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Proxy');
        });

        it('should allow when BOT_ALLOW_REMOTE=true', async () => {
            process.env.BOT_ALLOW_REMOTE = 'true';
            const { validateLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '192.168.1.100' },
                headers: {},
            } as unknown as NextApiRequest;

            const result = validateLocalhostRequest(mockReq);
            expect(result.allowed).toBe(true);
            expect(result.reason).toBe('BOT_ALLOW_REMOTE override');
        });
    });

    describe('enforceLocalhostRequest', () => {
        it('should return null for allowed requests', async () => {
            const { enforceLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: {},
            } as unknown as NextApiRequest;

            const error = enforceLocalhostRequest(mockReq);
            expect(error).toBeNull();
        });

        it('should return error object for rejected requests', async () => {
            const { enforceLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '8.8.8.8' },
                headers: {},
            } as unknown as NextApiRequest;

            const error = enforceLocalhostRequest(mockReq);
            expect(error).not.toBeNull();
            expect(error?.error).toBe('Remote access disabled');
            expect(error?.remoteAddress).toBe('8.8.8.8');
        });

        it('should return error with proxy info when proxy detected', async () => {
            const { enforceLocalhostRequest } = await import('../security/localOnly');
            const mockReq = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-forwarded-for': '203.0.113.50' },
            } as unknown as NextApiRequest;

            const error = enforceLocalhostRequest(mockReq);
            expect(error).not.toBeNull();
            expect(error?.reason).toContain('Proxy');
        });
    });

    describe('validateServerStartup', () => {
        it('should pass on localhost', async () => {
            const { validateServerStartup } = await import('../security/localOnly');
            const result = validateServerStartup();
            expect(result.allowed).toBe(true);
        });

        it('should fail on cloud platform', async () => {
            process.env.VERCEL = '1';
            const { validateServerStartup } = await import('../security/localOnly');
            const result = validateServerStartup();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Cloud platform');
            expect(result.reason).toContain('Vercel');
        });

        it('should pass on cloud with BOT_ALLOW_REMOTE=true', async () => {
            process.env.VERCEL = '1';
            process.env.BOT_ALLOW_REMOTE = 'true';
            const { validateServerStartup } = await import('../security/localOnly');
            const result = validateServerStartup();
            expect(result.allowed).toBe(true);
        });
    });
});
