/**
 * Local audit logging for API requests.
 * Appends JSONL to ./data/audit.log (gitignored).
 * 
 * Non-blocking, best-effort logging - failures are silently ignored.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const AUDIT_DIR = path.join(process.cwd(), 'data');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');

// Sensitive fields to redact
const SENSITIVE_FIELDS = ['secret', 'password', 'token', 'apiKey', 'seed', 'privateKey', 'mnemonic'];

/**
 * Audit log entry structure.
 */
export interface AuditEntry {
    timestamp: string;
    requestId: string;
    method: string;
    path: string;
    ip: string;
    statusCode?: number;
    action?: string;
    details?: Record<string, unknown>;
}

/**
 * Redact sensitive fields from an object.
 */
function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_FIELDS.some(f => lowerKey.includes(f))) {
            result[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            result[key] = redactSensitive(value as Record<string, unknown>);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Ensure audit directory exists.
 */
async function ensureAuditDir(): Promise<void> {
    try {
        await fs.mkdir(AUDIT_DIR, { recursive: true });
    } catch {
        // Ignore - directory may already exist
    }
}

/**
 * Append audit entry to log file (JSONL format).
 * Non-blocking, best-effort - errors are ignored.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
    try {
        await ensureAuditDir();

        // Redact any sensitive data in details
        const safeEntry = {
            ...entry,
            details: entry.details ? redactSensitive(entry.details) : undefined,
        };

        const line = JSON.stringify(safeEntry) + '\n';
        await fs.appendFile(AUDIT_FILE, line, 'utf8');
    } catch {
        // Silent failure - audit is best-effort
    }
}

/**
 * Log a sensitive action (run/pause/kill/orders/position-size/trading-pair).
 */
export async function logSensitiveAction(
    requestId: string,
    action: string,
    details?: Record<string, unknown>
): Promise<void> {
    const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        requestId,
        method: 'ACTION',
        path: action,
        ip: 'local',
        action,
    };
    if (details !== undefined) {
        entry.details = details;
    }
    await logAudit(entry);
}
