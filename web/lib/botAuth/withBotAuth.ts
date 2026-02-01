/**
 * withBotAuth - HMAC authentication and RBAC wrapper for Next.js API routes.
 *
 * Features:
 * - HMAC signature verification
 * - Timestamp validation (replay protection)
 * - Nonce validation (replay protection)
 * - Rate limiting per (apiKey + ip)
 * - Role-based access control
 * - IP allowlist (optional)
 * - Audit logging for privileged actions
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { loadBotAuthEnv, getApiKeyById, type ApiKey } from './env';
import { verifySignature, isTimestampValid } from './hmac';
import { readRawBody, parseJsonBody } from './rawBody';
import { checkAndStoreNonce } from './nonceStore';
import { checkRateLimit } from './rateLimit';
import { hasPermission, type Permission, type Role } from './permissions';
import { logAudit, generateRequestId } from './audit';

export interface AuthenticatedRequest extends NextApiRequest {
    auth: {
        apiKeyId: string;
        role: Role;
        requestId: string;
    };
    rawBody: string;
    parsedBody: unknown;
}

export interface BotAuthOptions {
    /** Required permission for this endpoint */
    permission: Permission;
    /** Allowed HTTP methods (defaults to all) */
    methods?: string[];
    /** Per-method permissions (overrides main permission) */
    methodPermissions?: Record<string, Permission>;
    /** Skip audit logging (for high-frequency readonly endpoints) */
    skipAudit?: boolean;
}

type AuthenticatedHandler = (
    req: AuthenticatedRequest,
    res: NextApiResponse
) => Promise<void> | void;

/**
 * Wrap a Next.js API handler with HMAC authentication and RBAC.
 */
export function withBotAuth(
    handler: AuthenticatedHandler,
    options: BotAuthOptions
) {
    return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
        const requestId = generateRequestId();
        const env = loadBotAuthEnv();

        // Get client IP
        const ip = getClientIp(req);

        // Check HTTP method
        if (options.methods && !options.methods.includes(req.method || '')) {
            res.status(405).json({ error: 'Method not allowed' });
            return;
        }

        // Determine required permission (per-method or default)
        const permission =
            options.methodPermissions?.[req.method || ''] ?? options.permission;

        // Read raw body for signature verification
        let rawBody: string;
        try {
            rawBody = await readRawBody(req);
        } catch (err) {
            res.status(400).json({ error: 'Failed to read request body' });
            return;
        }

        // Extract auth headers
        const apiKeyId = req.headers['x-api-key'] as string | undefined;
        const signature = req.headers['x-signature'] as string | undefined;
        const timestamp = req.headers['x-timestamp'] as string | undefined;
        const nonce = req.headers['x-nonce'] as string | undefined;

        // Validate required headers
        if (!apiKeyId || !signature || !timestamp || !nonce) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId: apiKeyId || 'unknown',
                role: 'unknown',
                permission,
                outcome: 'denied',
                error: 'Missing authentication headers',
                ip,
            });

            res.status(401).json({
                error: 'Missing authentication headers',
                required: ['X-API-KEY', 'X-SIGNATURE', 'X-TIMESTAMP', 'X-NONCE'],
            });
            return;
        }

        // Look up API key
        const apiKey = getApiKeyById(apiKeyId);
        if (!apiKey) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: 'unknown',
                permission,
                outcome: 'denied',
                error: 'Invalid API key',
                ip,
            });

            res.status(401).json({ error: 'Invalid API key' });
            return;
        }

        // Check IP allowlist (if configured)
        if (env.BOT_API_ALLOWED_IPS && !env.BOT_API_ALLOWED_IPS.includes(ip)) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'denied',
                error: 'IP not allowed',
                ip,
            });

            res.status(403).json({ error: 'IP not allowed' });
            return;
        }

        // Validate timestamp
        if (!isTimestampValid(timestamp, env.BOT_API_TTL_SECONDS)) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'denied',
                error: 'Timestamp expired or invalid',
                ip,
            });

            res.status(401).json({ error: 'Request timestamp expired or invalid' });
            return;
        }

        // Check nonce (replay protection)
        const nonceValid = await checkAndStoreNonce(
            nonce,
            apiKeyId,
            env.BOT_API_TTL_SECONDS * 2 // Store nonces for 2x TTL
        );

        if (!nonceValid) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'denied',
                error: 'Nonce already used (replay attack?)',
                ip,
            });

            res.status(401).json({ error: 'Nonce already used' });
            return;
        }

        // Verify HMAC signature
        const path = req.url?.split('?')[0] || '';
        const signatureValid = verifySignature({
            method: req.method || 'GET',
            path,
            timestamp,
            nonce,
            rawBody,
            signature,
            secret: apiKey.secret,
        });

        if (!signatureValid) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'denied',
                error: 'Invalid signature',
                ip,
            });

            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        // Check rate limit
        const rateLimitResult = await checkRateLimit(apiKeyId, ip);
        if (!rateLimitResult.allowed) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'rate_limited',
                ip,
            });

            res.setHeader('X-RateLimit-Remaining', '0');
            res.setHeader('X-RateLimit-Reset', rateLimitResult.resetAt.toString());
            res.status(429).json({
                error: 'Rate limit exceeded',
                retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000),
            });
            return;
        }

        // Set rate limit headers
        res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
        res.setHeader('X-RateLimit-Reset', rateLimitResult.resetAt.toString());

        // Check RBAC permission
        if (!hasPermission(apiKey.role, permission)) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'denied',
                error: `Role '${apiKey.role}' lacks permission '${permission}'`,
                ip,
            });

            res.status(403).json({
                error: 'Permission denied',
                required: permission,
                yourRole: apiKey.role,
            });
            return;
        }

        // Parse body for the handler
        const parsedBody = parseJsonBody(rawBody);

        // Create authenticated request
        const authReq = req as AuthenticatedRequest;
        authReq.auth = {
            apiKeyId,
            role: apiKey.role,
            requestId,
        };
        authReq.rawBody = rawBody;
        authReq.parsedBody = parsedBody;

        // Log successful auth for privileged actions
        if (!options.skipAudit && apiKey.role !== 'readonly') {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'success',
                ip,
            });
        }

        // Call the actual handler
        try {
            await handler(authReq, res);
        } catch (err: any) {
            logAudit({
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: req.url || '',
                method: req.method || '',
                apiKeyId,
                role: apiKey.role,
                permission,
                outcome: 'error',
                error: err?.message || 'Unknown error',
                ip,
            });

            res.status(500).json({
                error: 'Internal server error',
                requestId,
            });
        }
    };
}

/**
 * Get client IP from request headers.
 */
function getClientIp(req: NextApiRequest): string {
    // Check various headers that proxies/load balancers set
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        const ips = Array.isArray(forwardedFor)
            ? forwardedFor[0]
            : forwardedFor.split(',')[0];
        return ips.trim();
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp) {
        return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    // Fallback to socket address
    return req.socket?.remoteAddress || 'unknown';
}

export { type Permission, type Role } from './permissions';
