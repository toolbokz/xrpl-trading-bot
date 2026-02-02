/**
 * Type definitions for local-only API middleware.
 * Simplified auth model since bot runs localhost-only.
 */

import type { NextApiRequest } from 'next';

/**
 * Extended request type for local API handlers.
 * Contains requestId for tracing and parsed body.
 */
export interface LocalRequest extends NextApiRequest {
    /** Unique request ID for tracing (UUID v4) */
    requestId: string;
    /** Parsed JSON body (if present) */
    parsedBody: unknown;
}

/**
 * Response shape for JSON error responses.
 */
export interface LocalApiError {
    error: string;
    reason?: string;
    requestId: string;
}

/**
 * Configuration for local API middleware.
 */
export interface LocalApiConfig {
    /** Allowed HTTP methods for this endpoint */
    methods?: string[];
    /** Skip audit logging for high-frequency readonly endpoints */
    skipAudit?: boolean;
    /** Custom rate limit (requests per minute) - optional local throttle */
    rateLimit?: number;
}
