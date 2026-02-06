/**
 * Persistent audit logging for bot API.
 * 
 * Writes JSON lines to a file or stdout for sensitive operations.
 * Supports rotation and configurable sink via AUDIT_LOG_SINK env var.
 * 
 * Sinks:
 * - "stdout" - Write to stdout (default in development)
 * - "file" or "file:./path/to/audit.log" - Write to file (default: ./data/audit.log)
 * - "none" - Disable persistent audit logging
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PersistentAuditEntry {
    /** Unique request ID for correlation */
    requestId: string;
    /** ISO 8601 timestamp */
    timestamp: string;
    /** API endpoint path */
    endpoint: string;
    /** HTTP method */
    method: string;
    /** API key ID used */
    apiKeyId: string;
    /** User role */
    role: string;
    /** Permission required */
    permission: string;
    /** Outcome of the operation */
    outcome: 'success' | 'denied' | 'error' | 'rate_limited';
    /** Error message if applicable */
    error?: string;
    /** Client IP address */
    ip?: string;
    /** User agent string */
    userAgent?: string;
    /** Duration in milliseconds (if available) */
    durationMs?: number;
    /** Additional context for sensitive operations */
    details?: Record<string, unknown>;
}

export type AuditSinkType = 'stdout' | 'file' | 'none';

export interface AuditConfig {
    sink: AuditSinkType;
    filePath: string;
    minLevel: 'all' | 'denied' | 'error';
}

let cachedConfig: AuditConfig | null = null;
let writeStream: fs.WriteStream | null = null;

/**
 * Parse AUDIT_LOG_SINK environment variable.
 * 
 * Formats:
 * - "stdout" - Write to stdout
 * - "file" - Write to default file (./data/audit.log)
 * - "file:./custom/path.log" - Write to custom file path
 * - "none" - Disable audit logging
 */
export function parseAuditSink(envValue: string | undefined): { sink: AuditSinkType; filePath: string } {
    const value = (envValue || '').trim().toLowerCase();

    if (value === 'stdout') {
        return { sink: 'stdout', filePath: '' };
    }

    if (value === 'none' || value === 'disabled') {
        return { sink: 'none', filePath: '' };
    }

    if (value.startsWith('file:')) {
        const customPath = envValue!.slice(5).trim();
        return { sink: 'file', filePath: customPath || './data/audit.log' };
    }

    if (value === 'file' || value === '') {
        // Default: file sink in production, stdout in development
        const isProduction = process.env.NODE_ENV === 'production';
        if (isProduction) {
            return { sink: 'file', filePath: './data/audit.log' };
        }
        return { sink: 'stdout', filePath: '' };
    }

    // Treat unknown values as file paths for backward compatibility
    return { sink: 'file', filePath: value };
}

/**
 * Load audit configuration from environment.
 */
export function loadAuditConfig(): AuditConfig {
    if (cachedConfig) return cachedConfig;

    const { sink, filePath } = parseAuditSink(process.env.AUDIT_LOG_SINK);
    const minLevel = (process.env.AUDIT_LOG_MIN_LEVEL || 'all') as AuditConfig['minLevel'];

    cachedConfig = {
        sink,
        filePath,
        minLevel: ['all', 'denied', 'error'].includes(minLevel) ? minLevel : 'all',
    };

    return cachedConfig;
}

/**
 * Clear cached config (for testing).
 */
export function clearAuditConfigCache(): void {
    cachedConfig = null;
    if (writeStream) {
        writeStream.end();
        writeStream = null;
    }
}

/**
 * Ensure the directory for the audit log file exists.
 */
function ensureAuditDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Get or create the write stream for file-based logging.
 */
function getWriteStream(filePath: string): fs.WriteStream {
    if (!writeStream) {
        ensureAuditDir(filePath);
        writeStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });

        writeStream.on('error', (err) => {
            console.error('[AuditLogger] Write stream error:', err);
            writeStream = null;
        });
    }
    return writeStream;
}

/**
 * Check if an entry should be logged based on minimum level.
 */
function shouldLog(entry: PersistentAuditEntry, minLevel: AuditConfig['minLevel']): boolean {
    if (minLevel === 'all') return true;
    if (minLevel === 'error') return entry.outcome === 'error';
    if (minLevel === 'denied') return entry.outcome === 'denied' || entry.outcome === 'error';
    return true;
}

/**
 * Write an audit entry to the configured sink.
 * 
 * This is a synchronous-appearing function that handles writes asynchronously
 * internally to avoid blocking the request path.
 */
export function writeAuditEntry(entry: PersistentAuditEntry): void {
    const config = loadAuditConfig();

    if (config.sink === 'none') {
        return;
    }

    if (!shouldLog(entry, config.minLevel)) {
        return;
    }

    const line = JSON.stringify({
        _type: 'AUDIT',
        ...entry,
    }) + '\n';

    if (config.sink === 'stdout') {
        process.stdout.write(line);
        return;
    }

    if (config.sink === 'file') {
        try {
            const stream = getWriteStream(config.filePath);
            stream.write(line);
        } catch (err) {
            // Fallback to console on write error
            console.error('[AuditLogger] Failed to write to file, falling back to stdout:', err);
            process.stdout.write(line);
        }
    }
}

/**
 * Log a sensitive operation with additional details.
 * Use this for operations that require extra audit trail.
 */
export function logSensitiveOperation(
    baseEntry: Omit<PersistentAuditEntry, 'details'>,
    details: Record<string, unknown>
): void {
    writeAuditEntry({
        ...baseEntry,
        details,
    });
}

/**
 * Flush any pending writes and close the stream.
 * Call this during graceful shutdown.
 */
export async function closeAuditLogger(): Promise<void> {
    return new Promise((resolve) => {
        if (writeStream) {
            writeStream.end(() => {
                writeStream = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

/**
 * Get audit log file path (for external tools to read).
 */
export function getAuditLogPath(): string | null {
    const config = loadAuditConfig();
    return config.sink === 'file' ? config.filePath : null;
}
