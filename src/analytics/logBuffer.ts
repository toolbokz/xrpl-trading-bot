/**
 * Log Buffer - Captures logs for streaming to the dashboard
 * 
 * This module provides a ring buffer that captures logs from pino
 * and makes them available via API for the frontend LogsPanel.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
    id: string;
    ts: number;
    level: LogLevel;
    message: string;
    source?: string;
    data?: Record<string, unknown>;
}

const MAX_BUFFER_SIZE = 500;

class LogBuffer {
    private buffer: LogEntry[] = [];
    private idCounter = 0;

    /**
     * Add a log entry to the buffer.
     * Uses push (O(1) amortized) instead of unshift (O(n)).
     * Buffer is stored oldest-first; getLogs reverses for newest-first output.
     */
    push(level: LogLevel, message: string, source?: string, data?: Record<string, unknown>): void {
        const entry: LogEntry = {
            id: `log-${Date.now()}-${++this.idCounter}`,
            ts: Date.now(),
            level,
            message,
            ...(source && { source }),
            ...(data && { data }),
        };

        this.buffer.push(entry); // oldest-first internally, O(1) amortized

        // Trim oldest entries when over capacity
        if (this.buffer.length > MAX_BUFFER_SIZE) {
            // Remove oldest 10% to avoid trimming every single push
            const trimCount = Math.max(1, Math.floor(MAX_BUFFER_SIZE * 0.1));
            this.buffer.splice(0, trimCount);
        }
    }

    /**
     * Get logs with optional filtering.
     * Returns newest-first order by iterating the internal buffer backwards.
     */
    getLogs(options: {
        limit?: number;
        level?: LogLevel | LogLevel[];
        since?: number;
        source?: string;
    } = {}): LogEntry[] {
        const { limit = 100, level, since, source } = options;
        const levels = level ? (Array.isArray(level) ? level : [level]) : null;
        const result: LogEntry[] = [];

        // Walk backwards (newest first) and collect up to `limit` matching entries
        for (let i = this.buffer.length - 1; i >= 0 && result.length < limit; i--) {
            const entry = this.buffer[i]!;
            if (levels && !levels.includes(entry.level)) continue;
            if (source && entry.source !== source) continue;
            if (since && entry.ts <= since) continue;
            result.push(entry);
        }

        return result;
    }

    /**
     * Get count of logs by level
     */
    getCounts(): Record<LogLevel, number> {
        const counts: Record<LogLevel, number> = {
            trace: 0,
            debug: 0,
            info: 0,
            warn: 0,
            error: 0,
            fatal: 0,
        };

        for (const entry of this.buffer) {
            counts[entry.level]++;
        }

        return counts;
    }

    /**
     * Clear all logs
     */
    clear(): void {
        this.buffer = [];
    }

    /**
     * Get buffer size
     */
    get size(): number {
        return this.buffer.length;
    }
}

// Singleton instance
export const logBuffer = new LogBuffer();

// Helper functions for logging with automatic buffer capture
export function bufferLog(
    level: LogLevel,
    message: string,
    source?: string,
    data?: Record<string, unknown>
): void {
    logBuffer.push(level, message, source, data);
}

// Convenience methods
export const logInfo = (message: string, source?: string, data?: Record<string, unknown>) =>
    bufferLog('info', message, source, data);

export const logWarn = (message: string, source?: string, data?: Record<string, unknown>) =>
    bufferLog('warn', message, source, data);

export const logError = (message: string, source?: string, data?: Record<string, unknown>) =>
    bufferLog('error', message, source, data);

export const logDebug = (message: string, source?: string, data?: Record<string, unknown>) =>
    bufferLog('debug', message, source, data);
