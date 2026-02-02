/**
 * Localhost Safety Guard for Next.js API Routes
 * 
 * This module ensures API routes can only be accessed from localhost.
 * Remote access is completely blocked for security.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

export class RemoteAccessDeniedError extends Error {
    constructor(reason: string) {
        super(`Remote access disabled. ${reason}`);
        this.name = 'RemoteAccessDeniedError';
    }
}

/**
 * Check if running on a cloud platform (server-side check).
 */
export function isCloudEnvironment(): { isCloud: boolean; platform: string | null } {
    // Vercel
    if (process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL) {
        return { isCloud: true, platform: 'Vercel' };
    }

    // AWS
    if (process.env.AWS_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME) {
        return { isCloud: true, platform: 'AWS' };
    }

    // Google Cloud
    if (process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) {
        return { isCloud: true, platform: 'Google Cloud' };
    }

    // Azure
    if (process.env.AZURE_FUNCTIONS_ENVIRONMENT || process.env.WEBSITE_SITE_NAME) {
        return { isCloud: true, platform: 'Azure' };
    }

    // Heroku
    if (process.env.DYNO || process.env.HEROKU_APP_NAME) {
        return { isCloud: true, platform: 'Heroku' };
    }

    // Railway
    if (process.env.RAILWAY_ENVIRONMENT) {
        return { isCloud: true, platform: 'Railway' };
    }

    // Render
    if (process.env.RENDER) {
        return { isCloud: true, platform: 'Render' };
    }

    // Fly.io
    if (process.env.FLY_APP_NAME) {
        return { isCloud: true, platform: 'Fly.io' };
    }

    // Netlify
    if (process.env.NETLIFY) {
        return { isCloud: true, platform: 'Netlify' };
    }

    // Docker (if explicitly set and not local-only)
    if (process.env.DOCKER === 'true' && process.env.BOT_LOCAL_ONLY !== 'true') {
        return { isCloud: true, platform: 'Docker (without BOT_LOCAL_ONLY)' };
    }

    return { isCloud: false, platform: null };
}

/**
 * Check if an IP address is localhost.
 */
export function isLocalhostIp(ip: string | undefined): boolean {
    if (!ip) return false;

    const normalizedIp = ip.toLowerCase().trim();

    // IPv4 localhost
    if (normalizedIp === '127.0.0.1' || normalizedIp.startsWith('127.')) {
        return true;
    }

    // IPv6 localhost
    if (normalizedIp === '::1' || normalizedIp === '::ffff:127.0.0.1') {
        return true;
    }

    // Literal localhost
    if (normalizedIp === 'localhost') {
        return true;
    }

    return false;
}

/**
 * Get the client IP from a Next.js request.
 */
export function getClientIpInfo(req: NextApiRequest): {
    ip: string;
    isProxied: boolean;
    forwardedFor: string | null;
} {
    // Check for proxy headers
    const forwardedFor = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];

    if (forwardedFor) {
        const ips = Array.isArray(forwardedFor)
            ? forwardedFor[0]
            : forwardedFor.split(',')[0];
        return {
            ip: ips?.trim() ?? 'unknown',
            isProxied: true,
            forwardedFor: Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor,
        };
    }

    if (realIp) {
        return {
            ip: Array.isArray(realIp) ? realIp[0] ?? 'unknown' : realIp,
            isProxied: true,
            forwardedFor: null,
        };
    }

    // Direct connection
    const socketAddress = req.socket?.remoteAddress ?? 'unknown';
    return {
        ip: socketAddress,
        isProxied: false,
        forwardedFor: null,
    };
}

/**
 * Configuration for localhost-only mode.
 */
export interface LocalOnlyConfig {
    allowRemote: boolean;
    forceLocalOnly: boolean;
    isProduction: boolean;
    cloudCheck: { isCloud: boolean; platform: string | null };
}

/**
 * Load localhost-only configuration from environment.
 */
export function loadLocalOnlyConfig(): LocalOnlyConfig {
    return {
        allowRemote: process.env.BOT_ALLOW_REMOTE === 'true',
        forceLocalOnly: process.env.BOT_LOCAL_ONLY === 'true',
        isProduction: process.env.NODE_ENV === 'production',
        cloudCheck: isCloudEnvironment(),
    };
}

/**
 * Result of localhost validation.
 */
export interface LocalhostCheckResult {
    allowed: boolean;
    reason: string;
    clientIp: string;
    isProxied: boolean;
}

/**
 * Validate that a request is from localhost.
 * Returns validation result without sending a response.
 */
export function validateLocalhostRequest(req: NextApiRequest): LocalhostCheckResult {
    const config = loadLocalOnlyConfig();
    const clientInfo = getClientIpInfo(req);

    // Allow override for advanced users
    if (config.allowRemote) {
        return {
            allowed: true,
            reason: 'Remote access allowed via BOT_ALLOW_REMOTE',
            clientIp: clientInfo.ip,
            isProxied: clientInfo.isProxied,
        };
    }

    // Block cloud environments
    if (config.cloudCheck.isCloud) {
        return {
            allowed: false,
            reason: `Cloud execution blocked (${config.cloudCheck.platform})`,
            clientIp: clientInfo.ip,
            isProxied: clientInfo.isProxied,
        };
    }

    // Block proxied requests (indicates remote access)
    if (clientInfo.isProxied) {
        return {
            allowed: false,
            reason: 'Proxied request detected (X-Forwarded-For present)',
            clientIp: clientInfo.ip,
            isProxied: true,
        };
    }

    // Check if IP is localhost
    if (!isLocalhostIp(clientInfo.ip)) {
        return {
            allowed: false,
            reason: `Non-localhost IP: ${clientInfo.ip}`,
            clientIp: clientInfo.ip,
            isProxied: false,
        };
    }

    return {
        allowed: true,
        reason: 'Request from localhost',
        clientIp: clientInfo.ip,
        isProxied: false,
    };
}

/**
 * Middleware to enforce localhost-only access.
 * Call this at the start of any sensitive API route.
 * 
 * @returns null if allowed, or an error response object to send
 */
export function enforceLocalhostRequest(
    req: NextApiRequest,
    _res: NextApiResponse
): { error: string; reason: string; status: 403 } | null {
    const result = validateLocalhostRequest(req);

    if (!result.allowed) {
        // Log the blocked attempt
        console.warn('[Security] Remote access blocked:', {
            reason: result.reason,
            clientIp: result.clientIp,
            isProxied: result.isProxied,
            path: req.url,
            method: req.method,
        });

        return {
            error: 'Remote access disabled',
            reason: result.reason,
            status: 403,
        };
    }

    return null;
}

/**
 * Validate that the server itself should be allowed to run.
 * Call this on server startup.
 */
export function validateServerStartup(): { allowed: boolean; reason: string } {
    const config = loadLocalOnlyConfig();

    if (config.allowRemote) {
        if (config.isProduction) {
            console.warn('⚠️  DANGER: BOT_ALLOW_REMOTE is enabled in production!');
            console.warn('⚠️  Your wallet and funds may be exposed to remote attackers.');
        }
        return { allowed: true, reason: 'Remote access explicitly allowed' };
    }

    if (config.cloudCheck.isCloud) {
        return {
            allowed: false,
            reason: `Cloud execution blocked: ${config.cloudCheck.platform}`,
        };
    }

    if (config.isProduction && !config.forceLocalOnly) {
        return {
            allowed: false,
            reason: 'Production mode requires BOT_LOCAL_ONLY=true',
        };
    }

    return { allowed: true, reason: 'Local execution allowed' };
}
