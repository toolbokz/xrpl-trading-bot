import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';

export const config = {
    api: { bodyParser: false },
};

interface LatencyImpactConfigResponse {
    requestId: string;
    timestamp: string;
    config: {
        quantiles: number;
        defaultField: string;
        decisionFreshnessMs: number;
        sendFreshnessMs: number;
        fillFreshnessMs: number;
        maxTsMonotonicityViolationRate: number;
        maxMissingFillSnapshotRate: number;
        maxMissingAckRate: number;
        maxMissingMarkoutRate: number;
        maxNegRateAgeDelta: number;
        slippageImprovementBps: number;
        weeklyP50DriftLimitBps: number;
        weeklyP90DriftLimitBps: number;
    };
}

const num = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

function handler(req: LocalRequest, res: NextApiResponse<LatencyImpactConfigResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(200).json({
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        config: {
            quantiles: num(process.env.LATENCY_IMPACT_QUANTILES, 5),
            defaultField: process.env.LATENCY_IMPACT_DEFAULT_FIELD ?? 'decisionToFill',
            decisionFreshnessMs: num(process.env.LATENCY_IMPACT_DECISION_FRESHNESS_MS, 1000),
            sendFreshnessMs: num(process.env.LATENCY_IMPACT_SEND_FRESHNESS_MS, 500),
            fillFreshnessMs: num(process.env.LATENCY_IMPACT_FILL_FRESHNESS_MS, 500),
            maxTsMonotonicityViolationRate: num(process.env.LATENCY_IMPACT_MAX_TS_MONOTONICITY_VIOLATION_RATE, 0.001),
            maxMissingFillSnapshotRate: num(process.env.LATENCY_IMPACT_MAX_MISSING_FILL_SNAPSHOT_RATE, 0.02),
            maxMissingAckRate: num(process.env.LATENCY_IMPACT_MAX_MISSING_ACK_RATE, 0.2),
            maxMissingMarkoutRate: num(process.env.LATENCY_IMPACT_MAX_MISSING_MARKOUT_RATE, 0.4),
            maxNegRateAgeDelta: num(process.env.LATENCY_IMPACT_MAX_NEG_RATE_AGE_DELTA, 0.05),
            slippageImprovementBps: num(process.env.LATENCY_IMPACT_SLIPPAGE_IMPROVEMENT_BPS, 5),
            weeklyP50DriftLimitBps: num(process.env.LATENCY_IMPACT_WEEKLY_P50_DRIFT_LIMIT, 0.2),
            weeklyP90DriftLimitBps: num(process.env.LATENCY_IMPACT_WEEKLY_P90_DRIFT_LIMIT, 0.2),
        },
    });
}

export default withLocalApi(withApiRouteContext(handler));
