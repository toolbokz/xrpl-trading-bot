/**
 * CORS (Cross-Origin Resource Sharing) validation for bot API.
 * 
 * In production, this enforces an allowlist of origins from BOT_API_ALLOWED_ORIGINS.
 * In development, all origins are allowed by default.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

export interface CorsConfig {
    /** Allowed origins (null = allow all in dev, deny all non-browser in prod) */
    allowedOrigins: string[] | null;
    /** Whether we're in production mode */
    isProduction: boolean;
}

let cachedConfig: CorsConfig | null = null;

/**
 * Parse BOT_API_ALLOWED_ORIGINS environment variable.
 * Format: comma-separated list of origins (e.g., "https://app.example.com,https://admin.example.com")
 */
export function parseAllowedOrigins(envValue: string | undefined): string[] | null {
    if (!envValue || envValue.trim() === '') {
        return null;
    }

    const origins = envValue
        .split(',')
        .map(origin => origin.trim().toLowerCase())
        .filter(origin => {
            // Validate that each origin looks like a valid URL
            if (!origin) return false;
            try {
                const url = new URL(origin);
                // Only allow http(s) schemes
                return url.protocol === 'http:' || url.protocol === 'https:';
            } catch {
                console.warn(`[CORS] Invalid origin in BOT_API_ALLOWED_ORIGINS: "${origin}"`);
                return false;
            }
        });

    return origins.length > 0 ? origins : null;
}

/**
 * Load CORS configuration from environment.
 */
export function loadCorsConfig(): CorsConfig {
    if (cachedConfig) return cachedConfig;

    cachedConfig = {
        allowedOrigins: parseAllowedOrigins(process.env.BOT_API_ALLOWED_ORIGINS),
        isProduction: process.env.NODE_ENV === 'production',
    };

    if (cachedConfig.isProduction && !cachedConfig.allowedOrigins) {
        console.warn('[CORS] BOT_API_ALLOWED_ORIGINS not set in production - CORS will be restrictive');
    }

    return cachedConfig;
}

/**
 * Clear cached CORS config (for testing).
 */
export function clearCorsConfigCache(): void {
    cachedConfig = null;
}

/**
 * Validate the origin header against allowed origins.
 * 
 * @returns Object with validation result and the normalized origin
 */
export function validateOrigin(
    origin: string | undefined,
    config: CorsConfig
): { allowed: boolean; origin: string | null; reason?: string } {
    // No origin header = non-browser request (curl, server-to-server, etc.)
    // These are allowed through HMAC auth, not CORS
    if (!origin) {
        return { allowed: true, origin: null, reason: 'No origin (server-to-server or non-browser)' };
    }

    const normalizedOrigin = origin.trim().toLowerCase();

    // Development mode: allow all origins
    if (!config.isProduction) {
        return { allowed: true, origin: normalizedOrigin, reason: 'Development mode' };
    }

    // Production mode: check allowlist
    if (!config.allowedOrigins) {
        // No allowlist in production = reject all browser requests
        return {
            allowed: false,
            origin: normalizedOrigin,
            reason: 'No allowed origins configured in production'
        };
    }

    // Check if origin is in allowlist
    if (config.allowedOrigins.includes(normalizedOrigin)) {
        return { allowed: true, origin: normalizedOrigin };
    }

    return {
        allowed: false,
        origin: normalizedOrigin,
        reason: `Origin "${normalizedOrigin}" not in allowed list`
    };
}

/**
 * Apply CORS headers to response.
 * Should be called early in the request handling.
 */
export function applyCorsHeaders(
    req: NextApiRequest,
    res: NextApiResponse,
    config?: CorsConfig
): { allowed: boolean; reason?: string } {
    const corsConfig = config ?? loadCorsConfig();
    const origin = req.headers.origin as string | undefined;

    const validation = validateOrigin(origin, corsConfig);

    if (validation.allowed && validation.origin) {
        // Set CORS headers for allowed origins
        res.setHeader('Access-Control-Allow-Origin', validation.origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers',
            'X-API-KEY, X-SIGNATURE, X-TIMESTAMP, X-NONCE, X-REQUEST-ID, Content-Type');
        res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, X-RateLimit-Remaining, X-RateLimit-Reset');
        res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
    }

    // Always set Vary: Origin for proper caching
    res.setHeader('Vary', 'Origin');

    return validation;
}

/**
 * Handle CORS preflight (OPTIONS) request.
 * Returns true if this was a preflight request that was handled.
 */
export function handleCorsPreflightIfNeeded(
    req: NextApiRequest,
    res: NextApiResponse
): boolean {
    if (req.method !== 'OPTIONS') {
        return false;
    }

    const corsConfig = loadCorsConfig();
    const { allowed, reason } = applyCorsHeaders(req, res, corsConfig);

    if (!allowed) {
        res.status(403).json({
            error: 'CORS origin not allowed',
            reason: corsConfig.isProduction ? undefined : reason
        });
        return true;
    }

    // Successful preflight
    res.status(204).end();
    return true;
}

/**
 * CORS middleware check for use in withBotAuth.
 * Returns null if CORS is allowed, or error info if denied.
 */
export function checkCors(
    req: NextApiRequest,
    res: NextApiResponse
): { error: string; reason?: string } | null {
    const corsConfig = loadCorsConfig();
    const { allowed, reason } = applyCorsHeaders(req, res, corsConfig);

    if (!allowed) {
        const result: { error: string; reason?: string } = {
            error: 'CORS origin not allowed'
        };
        if (!corsConfig.isProduction && reason) {
            result.reason = reason;
        }
        return result;
    }

    return null;
}
