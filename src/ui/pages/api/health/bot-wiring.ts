import type { NextApiResponse } from 'next';
import { withLocalApi, type LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { buildBotWiringHealthReport } from '../../../lib/health/botWiringHealth';
import { logger } from '../../../../analytics/logger';

type BotWiringApiResponse = Awaited<ReturnType<typeof buildBotWiringHealthReport>> & {
    requestId: string;
};

type BotWiringErrorResponse = {
    ok: false;
    error: string;
    requestId: string;
};

async function handler(
    req: LocalRequest,
    res: NextApiResponse<BotWiringApiResponse | BotWiringErrorResponse>,
): Promise<void> {
    try {
        const report = await buildBotWiringHealthReport();
        res.status(report.ok ? 200 : 503).json({
            ...report,
            requestId: req.requestId,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'bot wiring health check failed';
        logger.error({ err }, '[API /health/bot-wiring] Error');
        res.status(500).json({
            ok: false,
            error: message,
            requestId: req.requestId,
        });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
