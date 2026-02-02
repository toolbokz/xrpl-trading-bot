/**
 * Unit tests for src/security/localOnly.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock process.env before importing the module
const originalEnv = process.env;

describe('localOnly security module', () => {
    beforeEach(() => {
        // Reset environment for each test
        vi.resetModules();
        process.env = { ...originalEnv };
        // Clear all cloud detection env vars
        delete process.env.VERCEL;
        delete process.env.VERCEL_ENV;
        delete process.env.VERCEL_URL;
        delete process.env.NOW_REGION;
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
        delete process.env.AWS_EXECUTION_ENV;
        delete process.env.AWS_REGION;
        delete process.env.GOOGLE_CLOUD_PROJECT;
        delete process.env.GCP_PROJECT;
        delete process.env.GCLOUD_PROJECT;
        delete process.env.K_SERVICE;
        delete process.env.WEBSITE_SITE_NAME;
        delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
        delete process.env.DYNO;
        delete process.env.HEROKU_APP_NAME;
        delete process.env.RAILWAY_STATIC_URL;
        delete process.env.RAILWAY_PROJECT_ID;
        delete process.env.RAILWAY_ENVIRONMENT;
        delete process.env.RENDER;
        delete process.env.RENDER_SERVICE_ID;
        delete process.env.RENDER_SERVICE_NAME;
        delete process.env.FLY_APP_NAME;
        delete process.env.FLY_REGION;
        delete process.env.DIGITALOCEAN_APP_ID;
        delete process.env.DIGITALOCEAN_APP_NAME;
        delete process.env.DIGITALOCEAN_TOKEN;
        delete process.env.NETLIFY;
        delete process.env.NETLIFY_BUILD_BASE;
        delete process.env.NETLIFY_DEV;
        delete process.env.KUBERNETES_SERVICE_HOST;
        delete process.env.KUBERNETES_PORT;
        delete process.env.BOT_LOCAL_ONLY;
        delete process.env.BOT_ALLOW_REMOTE;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('detectCloudPlatform', () => {
        it('should return null when no cloud env vars are set', async () => {
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBeNull();
        });

        it('should detect Vercel', async () => {
            process.env.VERCEL = '1';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Vercel');
        });

        it('should detect AWS', async () => {
            process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('AWS');
        });

        it('should detect Google Cloud Platform', async () => {
            process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Google Cloud Platform');
        });

        it('should detect Microsoft Azure', async () => {
            process.env.WEBSITE_SITE_NAME = 'my-app';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Microsoft Azure');
        });

        it('should detect Heroku', async () => {
            process.env.DYNO = 'web.1';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Heroku');
        });

        it('should detect Railway', async () => {
            process.env.RAILWAY_PROJECT_ID = 'abc123';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Railway');
        });

        it('should detect Render', async () => {
            process.env.RENDER = '1';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Render');
        });

        it('should detect Fly.io', async () => {
            process.env.FLY_APP_NAME = 'my-app';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Fly.io');
        });

        it('should detect DigitalOcean', async () => {
            process.env.DIGITALOCEAN_APP_ID = 'abc123';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('DigitalOcean');
        });

        it('should detect Netlify', async () => {
            process.env.NETLIFY = 'true';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Netlify');
        });

        it('should detect Kubernetes', async () => {
            process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
            const { detectCloudPlatform } = await import('../../security/localOnly');
            expect(detectCloudPlatform()).toBe('Kubernetes');
        });
    });

    describe('isLocalhostAddress', () => {
        it('should return true for 127.0.0.1', async () => {
            const { isLocalhostAddress } = await import('../../security/localOnly');
            expect(isLocalhostAddress('127.0.0.1')).toBe(true);
        });

        it('should return true for any 127.x.x.x address', async () => {
            const { isLocalhostAddress } = await import('../../security/localOnly');
            expect(isLocalhostAddress('127.0.0.2')).toBe(true);
            expect(isLocalhostAddress('127.255.255.255')).toBe(true);
        });

        it('should return true for ::1', async () => {
            const { isLocalhostAddress } = await import('../../security/localOnly');
            expect(isLocalhostAddress('::1')).toBe(true);
        });

        it('should return true for localhost', async () => {
            const { isLocalhostAddress } = await import('../../security/localOnly');
            expect(isLocalhostAddress('localhost')).toBe(true);
        });

        it('should return false for external IPs', async () => {
            const { isLocalhostAddress } = await import('../../security/localOnly');
            expect(isLocalhostAddress('192.168.1.1')).toBe(false);
            expect(isLocalhostAddress('10.0.0.1')).toBe(false);
            expect(isLocalhostAddress('8.8.8.8')).toBe(false);
        });
    });

    describe('loadLocalOnlyConfig', () => {
        it('should respect BOT_ALLOW_REMOTE=true', async () => {
            process.env.BOT_ALLOW_REMOTE = 'true';
            const { loadLocalOnlyConfig } = await import('../../security/localOnly');
            const config = loadLocalOnlyConfig();
            expect(config.allowRemote).toBe(true);
        });

        it('should default allowRemote to false', async () => {
            const { loadLocalOnlyConfig } = await import('../../security/localOnly');
            const config = loadLocalOnlyConfig();
            expect(config.allowRemote).toBe(false);
        });

        it('should detect cloud platform', async () => {
            process.env.VERCEL = '1';
            const { loadLocalOnlyConfig } = await import('../../security/localOnly');
            const config = loadLocalOnlyConfig();
            expect(config.cloudPlatform).toBe('Vercel');
        });
    });

    describe('enforceLocalOnly', () => {
        it('should not throw on localhost when no cloud detected', async () => {
            const { enforceLocalOnly } = await import('../../security/localOnly');
            // This should not throw (no cloud env vars set)
            expect(() => enforceLocalOnly('test')).not.toThrow();
        });

        it('should throw CloudExecutionBlockedError on Vercel', async () => {
            process.env.VERCEL = '1';
            const { enforceLocalOnly, CloudExecutionBlockedError } = await import('../../security/localOnly');
            expect(() => enforceLocalOnly('test')).toThrow(CloudExecutionBlockedError);
        });

        it('should throw CloudExecutionBlockedError on AWS', async () => {
            process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
            const { enforceLocalOnly, CloudExecutionBlockedError } = await import('../../security/localOnly');
            expect(() => enforceLocalOnly('test')).toThrow(CloudExecutionBlockedError);
        });

        it('should not throw when BOT_ALLOW_REMOTE=true overrides', async () => {
            process.env.BOT_ALLOW_REMOTE = 'true';
            process.env.VERCEL = '1';
            const { enforceLocalOnly } = await import('../../security/localOnly');
            expect(() => enforceLocalOnly('test')).not.toThrow();
        });
    });

    describe('getLocalOnlyStatus', () => {
        it('should return isLocal=true on localhost', async () => {
            const { getLocalOnlyStatus } = await import('../../security/localOnly');
            const status = getLocalOnlyStatus();
            expect(status.isLocal).toBe(true);
        });

        it('should return isLocal=false with cloud platform', async () => {
            process.env.VERCEL = '1';
            const { getLocalOnlyStatus } = await import('../../security/localOnly');
            const status = getLocalOnlyStatus();
            expect(status.isLocal).toBe(false);
            expect(status.config.cloudPlatform).toBe('Vercel');
        });
    });

    describe('isRequestFromLocalhost', () => {
        it('should return true for localhost IP', async () => {
            const { isRequestFromLocalhost } = await import('../../security/localOnly');
            expect(isRequestFromLocalhost('127.0.0.1', undefined)).toBe(true);
            expect(isRequestFromLocalhost('::1', undefined)).toBe(true);
        });

        it('should return false when X-Forwarded-For is present (indicates proxy)', async () => {
            const { isRequestFromLocalhost } = await import('../../security/localOnly');
            expect(isRequestFromLocalhost('127.0.0.1', '192.168.1.1')).toBe(false);
        });

        it('should return false for external IP', async () => {
            const { isRequestFromLocalhost } = await import('../../security/localOnly');
            expect(isRequestFromLocalhost('192.168.1.1', undefined)).toBe(false);
        });
    });
});
