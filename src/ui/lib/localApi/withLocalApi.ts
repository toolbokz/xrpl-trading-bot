/**
 * withLocalApi - Minimal localhost-only middleware for Next.js API routes.
 *
 * Features:
 * - Rejects any non-localhost request
 * - Rejects proxied requests (X-Forwarded-For, X-Real-IP headers)
 * - Optional LOCAL_API_TOKEN header validation (if configured)
 * - Attaches requestId (UUID) to each request
 * - Parses JSON body automatically
 * - Provides helper for JSON error responses
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { v4 as uuidv4 } from 'uuid';
import type { LocalRequest, LocalApiConfig, LocalApiError } from './types';
import { logAudit } from './audit';

/**
 * Check if an IP address is localhost.
 */
function isLocalhostIp(ip: string | undefined): boolean {
    if (!ip) return false;
    const normalized = ip.toLowerCase().trim();
    // IPv4 localhost
    if (normalized === '127.0.0.1' || normalized.startsWith('127.')) return true;
    // IPv6 localhost
    if (normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
    // Literal localhost
    if (normalized === 'localhost') return true;
    return false;
}

/**
 * Get client IP from request, considering socket.remoteAddress.
 */
function getClientIp(req: NextApiRequest): string | undefined {
    // Use socket.remoteAddress (direct connection IP)
    const socketAddr = req.socket?.remoteAddress;
    return socketAddr;
}

/**
 * Check if request appears to be proxied.
 * Proxied requests are rejected in localhost-only mode.
 */
function isProxiedRequest(req: NextApiRequest): { proxied: boolean; header?: string } {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        return { proxied: true, header: 'x-forwarded-for' };
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
        return { proxied: true, header: 'x-real-ip' };
    }
    return { proxied: false };
}

/**
 * Check if LOCAL_API_TOKEN is configured and validate it.
 * Returns true if token is valid or not required.
 */
function validateLocalToken(req: NextApiRequest): { valid: boolean; reason?: string } {
    const requiredToken = process.env.LOCAL_API_TOKEN;
    if (!requiredToken) {
        // Token not configured - no validation needed
        return { valid: true };
    }

    const providedToken = req.headers['x-local-api-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!providedToken) {
        return { valid: false, reason: 'LOCAL_API_TOKEN header required' };
    }
    if (providedToken !== requiredToken) {
        return { valid: false, reason: 'Invalid LOCAL_API_TOKEN' };
    }
    return { valid: true };
}

/**
 * Helper to send JSON error response with requestId.
 */
export function jsonError(
    res: NextApiResponse,
    statusCode: number,
    error: string,
    requestId: string,
    reason?: string
): void {
    const body: LocalApiError = { error, requestId };
    if (reason) body.reason = reason;
    res.status(statusCode).json(body);
}

/**
 * Check if a request is from localhost.
 * Returns null if allowed, or error details if rejected.
 */
export function isLocalRequest(req: NextApiRequest): { allowed: true } | { allowed: false; error: string; reason: string } {
    // In dev mode, skip proxy header checks (Next.js dev server adds x-forwarded-for)
    const isDevMode = process.env.BOT_API_DEV_MODE === 'true';

    // Check for proxy headers (reject proxied requests in production)
    if (!isDevMode) {
        const proxyCheck = isProxiedRequest(req);
        if (proxyCheck.proxied) {
            return {
                allowed: false,
                error: 'Proxied requests not allowed',
                reason: `Request contains ${proxyCheck.header} header indicating proxy`,
            };
        }
    }

    // Check client IP
    const clientIp = getClientIp(req);
    if (!isLocalhostIp(clientIp)) {
        return {
            allowed: false,
            error: 'Remote access denied',
            reason: `Connection from ${clientIp || 'unknown'} rejected - localhost only`,
        };
    }

    return { allowed: true };
}

/**
 * Parse JSON body from request (handles both pre-parsed and raw).
 */
async function parseBody(req: NextApiRequest): Promise<unknown> {
    // If body already parsed by Next.js
    if (req.body !== undefined && req.body !== null) {
        return req.body;
    }
    // Parse raw body for bodyParser: false routes
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw || raw.trim() === '') {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

type LocalHandler = (req: LocalRequest, res: NextApiResponse) => Promise<void> | void;

/**
 * Wrap a Next.js API handler with localhost-only security.
 */
export function withLocalApi(
    handler: LocalHandler,
    config: LocalApiConfig = {}
): (req: NextApiRequest, res: NextApiResponse) => Promise<void> {
    return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
        // Generate requestId
        const inboundRequestId = req.headers['x-request-id'];
        const requestId = typeof inboundRequestId === 'string' && inboundRequestId.length > 0
            ? inboundRequestId
            : uuidv4();

        // Always include requestId in response
        res.setHeader('X-Request-ID', requestId);

        // SECURITY: Block non-localhost requests
        const localCheck = isLocalRequest(req);
        if (!localCheck.allowed) {
            jsonError(res, 403, localCheck.error, requestId, localCheck.reason);
            return;
        }

        // SECURITY: Validate optional LOCAL_API_TOKEN
        const tokenCheck = validateLocalToken(req);
        if (!tokenCheck.valid) {
            jsonError(res, 401, 'Unauthorized', requestId, tokenCheck.reason);
            return;
        }

        // Check HTTP method
        if (config.methods && !config.methods.includes(req.method || 'GET')) {
            res.setHeader('Allow', config.methods.join(', '));
            jsonError(res, 405, 'Method not allowed', requestId);
            return;
        }

        // Parse body
        const parsedBody = await parseBody(req);

        // Create LocalRequest
        const localReq = req as LocalRequest;
        localReq.requestId = requestId;
        localReq.parsedBody = parsedBody;

        // Audit log (non-blocking, best-effort)
        if (!config.skipAudit) {
            const auditPath = req.url?.split('?')[0] ?? '/unknown';
            logAudit({
                timestamp: new Date().toISOString(),
                requestId,
                method: req.method || 'GET',
                path: auditPath,
                ip: getClientIp(req) || 'unknown',
            }).catch(() => { /* ignore audit failures */ });
        }

        // Call the actual handler
        try {
            await handler(localReq, res);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Internal server error';
            jsonError(res, 500, message, requestId);
        }
    };
}

export type { LocalRequest, LocalApiConfig };
