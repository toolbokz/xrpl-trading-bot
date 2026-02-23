import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { getCacheSnapshot, isSingleProcessMode } from '../../../lib/runtimeBridge';

export const config = {
    api: { bodyParser: false },
};

function handler(req: LocalRequest, res: NextApiResponse) {
    const runtime = ensureRuntimeHooks();
    const riskStatus = runtime.getRiskStatus();
    const cache = isSingleProcessMode() ? getCacheSnapshot() : null;
    const nowMs = Date.now();
    const pairMeta = {
        pairKey: cache?.pairKey ?? '',
        asOfMs: cache?.asOfMs ?? nowMs,
        stalenessMs: Math.max(0, nowMs - (cache?.asOfMs ?? nowMs)),
        executionAllowed: cache?.executionAllowed ?? false,
        runtimeState: cache?.runtimeState ?? null,
    };

    // Hard risk guard payload (pair-keyed, deterministic)
    const hardRisk = runtime.getHardRiskPayload();

    // Exposure tracker snapshot (live position tracking)
    const exposure = runtime.getExposureSnapshot();

    if (!riskStatus) {
        // Runtime not started - return defaults from config
        const config = runtime.getConfig();
        res.status(200).json({
            ...pairMeta,
            maxExposure: config.risk.maxExposurePerIssuer,
            currentExposure: 0,
            dailyLossLimit: config.risk.maxDailyLoss,
            dailyLossCurrent: 0,
            killSwitch: false,
            consecutiveFailures: 0,
            maxTradeSize: config.risk.maxTradeSize,
            reserveFloorXRP: config.risk.reserveFloorXRP,
            positionSize: config.strategy.positionSize,
            hardRisk,
            source: 'config',
            requestId: req.requestId,
        });
        return;
    }

    res.status(200).json({
        ...pairMeta,
        ...riskStatus,
        positionSize: runtime.getConfig().strategy.positionSize,
        hardRisk,
        exposure,
        source: 'runtime',
        requestId: req.requestId,
    });
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
