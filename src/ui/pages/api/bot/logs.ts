import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { logBuffer, LogLevel, LogEntry } from '../../../../analytics/logBuffer';

export interface LogsResponse {
    logs: LogEntry[];
    counts: Record<LogLevel, number>;
    total: number;
    requestId: string;
}

async function handler(req: LocalRequest, res: NextApiResponse<LogsResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Parse query parameters
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const since = req.query.since ? parseInt(req.query.since as string) : undefined;
        const source = req.query.source as string | undefined;

        // Parse level filter (can be comma-separated)
        let levelFilter: LogLevel[] | undefined;
        if (req.query.level) {
            const levels = (req.query.level as string).split(',') as LogLevel[];
            levelFilter = levels.filter((l) => ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(l));
        }

        const logs = logBuffer.getLogs({
            limit,
            ...(levelFilter && levelFilter.length > 0 && { level: levelFilter }),
            ...(since && { since }),
            ...(source && { source }),
        });

        const counts = logBuffer.getCounts();

        return res.status(200).json({
            logs,
            counts,
            total: logBuffer.size,
            requestId: req.requestId,
        });
    } catch (err) {
        console.error('Error fetching logs:', err);
        return res.status(500).json({ error: 'Failed to fetch logs' });
    }
}

export default withLocalApi(withApiRouteContext(handler));
