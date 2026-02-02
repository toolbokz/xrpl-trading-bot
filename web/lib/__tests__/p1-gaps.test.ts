/**
 * Tests for Sprint 1 P1 gap implementations.
 * @vitest-environment node
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Helper to safely manipulate env vars in tests
const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
        delete (process.env as Record<string, string | undefined>)[key];
    } else {
        process.env[key] = value;
    }
};

// ============================================================================
// API Key Uniqueness Tests
// ============================================================================
describe('API Key Uniqueness (P1-4)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        setEnv('BOT_API_KEYS', undefined);
    });

    it('should accept unique API key IDs', async () => {
        process.env.BOT_API_KEYS = JSON.stringify([
            { id: 'key-001', secret: 'a'.repeat(32), role: 'admin' },
            { id: 'key-002', secret: 'b'.repeat(32), role: 'operator' },
        ]);

        const { clearEnvCache, loadBotAuthEnv } = await import('../botAuth/env');
        clearEnvCache();

        const keys = loadBotAuthEnv().BOT_API_KEYS;
        expect(keys).toHaveLength(2);
    });

    it('should reject duplicate API key IDs', async () => {
        process.env.BOT_API_KEYS = JSON.stringify([
            { id: 'key-001', secret: 'a'.repeat(32), role: 'admin' },
            { id: 'key-001', secret: 'b'.repeat(32), role: 'operator' },
        ]);

        const { clearEnvCache, loadBotAuthEnv, ApiKeyConfigError } = await import('../botAuth/env');
        clearEnvCache();

        expect(() => loadBotAuthEnv()).toThrow(/Duplicate API key ID/);
    });

    it('should normalize IDs by trimming whitespace', async () => {
        process.env.BOT_API_KEYS = JSON.stringify([
            { id: '  key-001  ', secret: 'a'.repeat(32), role: 'admin' },
            { id: 'key-001', secret: 'b'.repeat(32), role: 'operator' },
        ]);

        const { clearEnvCache, loadBotAuthEnv } = await import('../botAuth/env');
        clearEnvCache();

        expect(() => loadBotAuthEnv()).toThrow(/Duplicate API key ID/);
    });

    it('should require minimum 6 character ID', async () => {
        process.env.BOT_API_KEYS = JSON.stringify([
            { id: 'short', secret: 'a'.repeat(32), role: 'admin' },
        ]);

        const { clearEnvCache, loadBotAuthEnv } = await import('../botAuth/env');
        clearEnvCache();

        expect(() => loadBotAuthEnv()).toThrow(/at least 6 characters/);
    });
});

// ============================================================================
// Rate Limiting Tests
// ============================================================================
describe('Rate Limiting (Read/Write Differentiation)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        setEnv('BOT_API_RATE_LIMIT_READ_PER_MIN', undefined);
        setEnv('BOT_API_RATE_LIMIT_WRITE_PER_MIN', undefined);
    });

    it('should classify GET/HEAD/OPTIONS as read operations', async () => {
        const { getRateLimitType } = await import('../botAuth/rateLimit');

        expect(getRateLimitType('GET')).toBe('read');
        expect(getRateLimitType('HEAD')).toBe('read');
        expect(getRateLimitType('OPTIONS')).toBe('read');
    });

    it('should classify POST/PUT/DELETE/PATCH as write operations', async () => {
        const { getRateLimitType } = await import('../botAuth/rateLimit');

        expect(getRateLimitType('POST')).toBe('write');
        expect(getRateLimitType('PUT')).toBe('write');
        expect(getRateLimitType('DELETE')).toBe('write');
        expect(getRateLimitType('PATCH')).toBe('write');
    });

    it('should use separate buckets for read and write', async () => {
        const { checkRateLimit, clearRateLimitStore } = await import('../botAuth/rateLimit');
        clearRateLimitStore();

        // Make some read requests
        const readResult1 = await checkRateLimit('test-key', '127.0.0.1', 'read');
        const readResult2 = await checkRateLimit('test-key', '127.0.0.1', 'read');

        // Make a write request - should have its own counter
        const writeResult = await checkRateLimit('test-key', '127.0.0.1', 'write');

        expect(readResult1.remaining).toBe(59); // Default read limit is 60
        expect(readResult2.remaining).toBe(58);
        expect(writeResult.remaining).toBe(19); // Default write limit is 20, separate bucket
        expect(writeResult.type).toBe('write');
    });

    it('should use default limits of 60 read / 20 write', async () => {
        const { checkRateLimit, clearRateLimitStore } = await import('../botAuth/rateLimit');
        clearRateLimitStore();

        const readResult = await checkRateLimit('test', '1.2.3.4', 'read');
        const writeResult = await checkRateLimit('test', '1.2.3.4', 'write');

        expect(readResult.limit).toBe(60);
        expect(writeResult.limit).toBe(20);
    });

    it('should respect custom rate limits from env', async () => {
        process.env.BOT_API_RATE_LIMIT_READ_PER_MIN = '100';
        process.env.BOT_API_RATE_LIMIT_WRITE_PER_MIN = '10';

        // Clear module cache to pick up new env vars
        vi.resetModules();
        const { checkRateLimit, clearRateLimitStore } = await import('../botAuth/rateLimit');
        clearRateLimitStore();

        const readResult = await checkRateLimit('test', '1.2.3.4', 'read');
        const writeResult = await checkRateLimit('test', '1.2.3.4', 'write');

        expect(readResult.limit).toBe(100);
        expect(writeResult.limit).toBe(10);
    });
});

// ============================================================================
// CORS Validation Tests
// ============================================================================
describe('CORS Validation', () => {
    beforeEach(() => {
        vi.resetModules();
        setEnv('BOT_API_ALLOWED_ORIGINS', undefined);
        setEnv('NODE_ENV', undefined);
    });

    afterEach(() => {
        setEnv('BOT_API_ALLOWED_ORIGINS', undefined);
        setEnv('NODE_ENV', undefined);
    });

    it('should parse comma-separated origins', async () => {
        const { parseAllowedOrigins } = await import('../http/cors');

        const origins = parseAllowedOrigins('https://app.example.com,https://admin.example.com');
        expect(origins).toEqual(['https://app.example.com', 'https://admin.example.com']);
    });

    it('should reject invalid origins', async () => {
        const { parseAllowedOrigins } = await import('../http/cors');

        const origins = parseAllowedOrigins('invalid,https://valid.com');
        expect(origins).toEqual(['https://valid.com']);
    });

    it('should allow all origins in development', async () => {
        setEnv('NODE_ENV', 'development');

        const { validateOrigin, clearCorsConfigCache } = await import('../http/cors');
        clearCorsConfigCache();

        const result = validateOrigin('https://unknown.com', {
            allowedOrigins: null,
            isProduction: false,
        });

        expect(result.allowed).toBe(true);
        expect(result.reason).toContain('Development');
    });

    it('should reject unknown origins in production without allowlist', async () => {
        setEnv('NODE_ENV', 'production');

        const { validateOrigin, clearCorsConfigCache } = await import('../http/cors');
        clearCorsConfigCache();

        const result = validateOrigin('https://unknown.com', {
            allowedOrigins: null,
            isProduction: true,
        });

        expect(result.allowed).toBe(false);
    });

    it('should allow listed origins in production', async () => {
        setEnv('NODE_ENV', 'production');
        process.env.BOT_API_ALLOWED_ORIGINS = 'https://app.example.com';

        const { validateOrigin, clearCorsConfigCache } = await import('../http/cors');
        clearCorsConfigCache();

        const result = validateOrigin('https://app.example.com', {
            allowedOrigins: ['https://app.example.com'],
            isProduction: true,
        });

        expect(result.allowed).toBe(true);
    });

    it('should allow requests without origin header (server-to-server)', async () => {
        const { validateOrigin } = await import('../http/cors');

        const result = validateOrigin(undefined, {
            allowedOrigins: ['https://app.example.com'],
            isProduction: true,
        });

        expect(result.allowed).toBe(true);
        expect(result.reason).toContain('server-to-server');
    });
});

// ============================================================================
// Persistent Audit Logging Tests
// ============================================================================
describe('Persistent Audit Logging', () => {
    beforeEach(() => {
        vi.resetModules();
        setEnv('AUDIT_LOG_SINK', undefined);
        setEnv('NODE_ENV', undefined);
    });

    afterEach(() => {
        setEnv('AUDIT_LOG_SINK', undefined);
        setEnv('NODE_ENV', undefined);
    });

    it('should parse stdout sink', async () => {
        const { parseAuditSink } = await import('../audit/auditLogger');

        const result = parseAuditSink('stdout');
        expect(result.sink).toBe('stdout');
    });

    it('should parse file sink with custom path', async () => {
        const { parseAuditSink } = await import('../audit/auditLogger');

        const result = parseAuditSink('file:./custom/audit.log');
        expect(result.sink).toBe('file');
        expect(result.filePath).toBe('./custom/audit.log');
    });

    it('should parse none sink', async () => {
        const { parseAuditSink } = await import('../audit/auditLogger');

        const result = parseAuditSink('none');
        expect(result.sink).toBe('none');
    });

    it('should default to file in production', async () => {
        setEnv('NODE_ENV', 'production');

        const { parseAuditSink } = await import('../audit/auditLogger');

        const result = parseAuditSink('');
        expect(result.sink).toBe('file');
        expect(result.filePath).toBe('./data/audit.log');
    });

    it('should default to stdout in development', async () => {
        setEnv('NODE_ENV', 'development');

        const { parseAuditSink } = await import('../audit/auditLogger');

        const result = parseAuditSink('');
        expect(result.sink).toBe('stdout');
    });

    it('should write entry to stdout when configured', async () => {
        process.env.AUDIT_LOG_SINK = 'stdout';

        const { writeAuditEntry, clearAuditConfigCache } = await import('../audit/auditLogger');
        clearAuditConfigCache();

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        writeAuditEntry({
            requestId: 'req_test',
            timestamp: '2024-01-01T00:00:00Z',
            endpoint: '/api/bot/status',
            method: 'GET',
            apiKeyId: 'test-key',
            role: 'admin',
            permission: 'bot:read',
            outcome: 'success',
        });

        expect(stdoutSpy).toHaveBeenCalled();
        const output = stdoutSpy.mock.calls[0]?.[0] as string | undefined;
        expect(output).toContain('"_type":"AUDIT"');
        expect(output).toContain('"requestId":"req_test"');

        stdoutSpy.mockRestore();
    });

    it('should not write when sink is none', async () => {
        process.env.AUDIT_LOG_SINK = 'none';

        const { writeAuditEntry, clearAuditConfigCache } = await import('../audit/auditLogger');
        clearAuditConfigCache();

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        writeAuditEntry({
            requestId: 'req_test',
            timestamp: '2024-01-01T00:00:00Z',
            endpoint: '/api/bot/status',
            method: 'GET',
            apiKeyId: 'test-key',
            role: 'admin',
            permission: 'bot:read',
            outcome: 'success',
        });

        expect(stdoutSpy).not.toHaveBeenCalled();
        stdoutSpy.mockRestore();
    });
});
