import { describe, expect, it } from 'vitest';
import { evaluateAppRouteGuard } from '../localApi/appRouteGuard';

describe('evaluateAppRouteGuard', () => {
    it('allows localhost host without token requirement', () => {
        const headers = new Headers({ host: '127.0.0.1:3000' });
        const result = evaluateAppRouteGuard(headers, {});
        expect(result.allowed).toBe(true);
    });

    it('rejects remote host values', () => {
        const headers = new Headers({ host: 'example.com' });
        const result = evaluateAppRouteGuard(headers, {});
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.status).toBe(403);
            expect(result.error).toBe('Remote access denied');
        }
    });

    it('rejects proxied requests with remote x-forwarded-for', () => {
        const headers = new Headers({
            host: 'localhost:3000',
            'x-forwarded-for': '203.0.113.10',
        });
        const result = evaluateAppRouteGuard(headers, {});
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.status).toBe(403);
            expect(result.reason).toContain('x-forwarded-for');
        }
    });

    it('requires LOCAL_API_TOKEN when configured', () => {
        const headers = new Headers({ host: 'localhost:3000' });
        const result = evaluateAppRouteGuard(headers, { LOCAL_API_TOKEN: 'secret-token' });
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.status).toBe(401);
            expect(result.reason).toContain('LOCAL_API_TOKEN');
        }
    });

    it('accepts matching bearer token when LOCAL_API_TOKEN is configured', () => {
        const headers = new Headers({
            host: 'localhost:3000',
            authorization: 'Bearer secret-token',
        });
        const result = evaluateAppRouteGuard(headers, { LOCAL_API_TOKEN: 'secret-token' });
        expect(result.allowed).toBe(true);
    });
});
