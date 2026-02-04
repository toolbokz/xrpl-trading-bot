import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';

export const config = {
    api: { bodyParser: false },
};

function handler(req: LocalRequest, res: NextApiResponse) {
    const runtime = ensureRuntimeHooks();
    const riskStatus = runtime.getRiskStatus();

    if (!riskStatus) {
        // Runtime not started - return defaults from config
        const config = runtime.getConfig();
        res.status(200).json({
            maxExposure: config.risk.maxExposurePerIssuer,
            currentExposure: 0,
            dailyLossLimit: config.risk.maxDailyLoss,
            dailyLossCurrent: 0,
            killSwitch: false,
            consecutiveFailures: 0,
            maxTradeSize: config.risk.maxTradeSize,
            reserveFloorXRP: config.risk.reserveFloorXRP,
            positionSize: config.strategy.positionSize,
            source: 'config',
            requestId: req.requestId,
        });
        return;
    }

    res.status(200).json({
        ...riskStatus,
        positionSize: runtime.getConfig().strategy.positionSize,
        source: 'runtime',
        requestId: req.requestId,
    });
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
