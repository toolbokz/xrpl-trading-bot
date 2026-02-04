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
     * Add a log entry to the buffer
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

        this.buffer.unshift(entry); // newest first

        // Trim to max size
        if (this.buffer.length > MAX_BUFFER_SIZE) {
            this.buffer = this.buffer.slice(0, MAX_BUFFER_SIZE);
        }
    }

    /**
     * Get logs with optional filtering
     */
    getLogs(options: {
        limit?: number;
        level?: LogLevel | LogLevel[];
        since?: number;
        source?: string;
    } = {}): LogEntry[] {
        const { limit = 100, level, since, source } = options;

        let result = this.buffer;

        // Filter by level(s)
        if (level) {
            const levels = Array.isArray(level) ? level : [level];
            result = result.filter((entry) => levels.includes(entry.level));
        }

        // Filter by source
        if (source) {
            result = result.filter((entry) => entry.source === source);
        }

        // Filter by timestamp (since)
        if (since) {
            result = result.filter((entry) => entry.ts > since);
        }

        return result.slice(0, limit);
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
