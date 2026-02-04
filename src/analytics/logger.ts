import pino from 'pino';
import { loadConfig } from '../config';
import { logBuffer, LogLevel } from './logBuffer';

const config = loadConfig();

// Map pino numeric levels to our LogLevel type
const pinoLevelToLogLevel: Record<number, LogLevel> = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
};

// Custom pino destination that also writes to our log buffer
const bufferStream = {
    write(msg: string): void {
        try {
            const parsed = JSON.parse(msg);
            const level = pinoLevelToLogLevel[parsed.level] || 'info';
            const message = parsed.msg || parsed.message || '';
            const source = parsed.source || parsed.stream || parsed.module;

            // Extract additional data (exclude standard pino fields)
            const { level: _l, time: _t, msg: _m, message: _msg, pid: _p, hostname: _h, source: _s, stream: _st, module: _mod, ...data } = parsed;

            logBuffer.push(level, message, source, Object.keys(data).length > 0 ? data : undefined);
        } catch {
            // If parsing fails, log raw message as info
            logBuffer.push('info', msg.trim());
        }
    },
};

// Create multistream to output to both console and buffer
const streams = [
    { stream: bufferStream },
    {
        stream: pino.transport({
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
        }),
    },
];

export const logger = pino(
    {
        level: config.analytics.logLevel,
    },
    pino.multistream(streams)
);

export const auditLog = logger.child({ source: 'audit' });

// Child loggers for different modules (for better UI filtering)
export const runtimeLog = logger.child({ source: 'runtime' });
export const xrplLog = logger.child({ source: 'xrpl' });
export const marketLog = logger.child({ source: 'market' });
export const strategyLog = logger.child({ source: 'strategy' });
export const riskLog = logger.child({ source: 'risk' });
export const executionLog = logger.child({ source: 'execution' });
