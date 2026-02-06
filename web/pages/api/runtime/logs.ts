/**
 * GET /api/runtime/logs
 *
 * Returns structured logs from the runtime log buffer.
 *
 * Query params:
 *   ?tail=N         — number of most recent logs (default: 100, max: 500)
 *   ?level=X        — filter by log level (info, warn, error, debug)
 *   ?source=X       — filter by log source (runtime, xrpl, market, risk, execution)
 *   ?since=N        — only logs after this epoch ms
 *
 * Response shape:
 *   { requestId, count, logs[], counts }
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { logBuffer, LogLevel, LogEntry } from '../../../../src/analytics/logBuffer';

const VALID_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

interface LogsResponse {
    requestId: string;
    /** Number of logs returned. */
    count: number;
    /** Log entries (newest first). */
    logs: LogEntry[];
    /** Count of logs by level in the full buffer. */
    counts: Record<LogLevel, number>;
}

function handler(req: LocalRequest, res: NextApiResponse<LogsResponse>) {
    const tail = Math.min(
        Math.max(1, parseInt(String(req.query.tail ?? '100'), 10) || 100),
        500,
    );
    const levelParam = req.query.level as string | undefined;
    const source = req.query.source as string | undefined;
    const since = parseInt(String(req.query.since ?? ''), 10);

    const level = levelParam && VALID_LEVELS.includes(levelParam as LogLevel)
        ? levelParam as LogLevel
        : undefined;

    const logs = logBuffer.getLogs({
        limit: tail,
        level,
        source,
        since: Number.isFinite(since) && since > 0 ? since : undefined,
    });

    return res.status(200).json({
        requestId: req.requestId,
        count: logs.length,
        logs,
        counts: logBuffer.getCounts(),
    });
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
