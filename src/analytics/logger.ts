import pino from 'pino';
import { loadConfig } from '../config';

const config = loadConfig();

export const logger = pino({
    level: config.analytics.logLevel,
    transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
    },
});

export const auditLog = logger.child({ stream: 'audit' });
