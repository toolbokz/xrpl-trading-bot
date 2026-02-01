/**
 * Audit logging for bot API.
 * Logs privileged actions with request context.
 */

export interface AuditLogEntry {
    requestId: string;
    timestamp: string;
    endpoint: string;
    method: string;
    apiKeyId: string;
    role: string;
    permission: string;
    outcome: 'success' | 'denied' | 'error' | 'rate_limited';
    error?: string;
    ip?: string;
    userAgent?: string;
}

/**
 * Log an audit entry.
 * In production, this should write to a secure audit log system.
 */
export function logAudit(entry: AuditLogEntry): void {
    const logEntry = {
        ...entry,
        // Ensure we're not logging anything sensitive
        _type: 'AUDIT',
    };

    // Use structured logging
    if (entry.outcome === 'error' || entry.outcome === 'denied') {
        console.error('[AUDIT]', JSON.stringify(logEntry));
    } else {
        console.log('[AUDIT]', JSON.stringify(logEntry));
    }
}

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
