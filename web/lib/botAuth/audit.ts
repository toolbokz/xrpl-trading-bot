/**
 * Audit logging for bot API.
 * Logs privileged actions with request context.
 * 
 * Uses both pino structured logging and persistent file-based audit logging.
 */

import { v4 as uuidv4 } from 'uuid';
import { writeAuditEntry, type PersistentAuditEntry } from '../audit/auditLogger';

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

// Use pino logger for structured logging
let pinoLogger: any = null;

// Lazy-load pino to avoid circular dependencies
function getLogger() {
    if (!pinoLogger) {
        try {
            // Dynamic import to avoid bundling issues
            pinoLogger = require('pino')({
                level: process.env.LOG_LEVEL || 'info',
                transport: process.env.NODE_ENV !== 'production' ? {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'SYS:standard' },
                } : undefined,
            });
        } catch {
            // Fallback to console-based logger with same interface
            pinoLogger = {
                info: (obj: any, msg?: string) => console.log(JSON.stringify({ ...obj, msg, level: 'info' })),
                warn: (obj: any, msg?: string) => console.warn(JSON.stringify({ ...obj, msg, level: 'warn' })),
                error: (obj: any, msg?: string) => console.error(JSON.stringify({ ...obj, msg, level: 'error' })),
                child: () => pinoLogger,
            };
        }
    }
    return pinoLogger;
}

/**
 * Log an audit entry using both structured logging and persistent file logging.
 * In production, this writes to both pino and the audit log file.
 */
export function logAudit(entry: AuditLogEntry): void {
    const logger = getLogger();
    const logEntry = {
        ...entry,
        _type: 'AUDIT',
    };

    // Use structured logging with appropriate level
    if (entry.outcome === 'error' || entry.outcome === 'denied') {
        logger.warn(logEntry, `Audit: ${entry.outcome} - ${entry.method} ${entry.endpoint}`);
    } else if (entry.outcome === 'rate_limited') {
        logger.warn(logEntry, `Audit: rate_limited - ${entry.method} ${entry.endpoint}`);
    } else {
        logger.info(logEntry, `Audit: ${entry.outcome} - ${entry.method} ${entry.endpoint}`);
    }

    // Also write to persistent audit log (file-based)
    writeAuditEntry(entry as PersistentAuditEntry);
}

/**
 * Generate a unique request ID.
 * Uses UUID v4 for uniqueness and traceability.
 */
export function generateRequestId(): string {
    return `req_${uuidv4()}`;
}
