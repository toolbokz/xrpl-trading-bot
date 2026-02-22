import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';

export const config = {
    api: { bodyParser: false },
};

interface SlippageRealismConfigResponse {
    requestId: string;
    timestamp: string;
    config: {
        decisionFreshnessMs: number;
        sendFreshnessMs: number;
        fillFreshnessMs: number;
        illiqFillFreshnessMs: number;
        feeBps: number;
        tooGoodSpreadWeight: number;
        tooGoodBpsBuffer: number;
        maxMissingFillSnapshotRate: number;
        maxStaleFillSnapshotRate: number;
        maxTsMonotonicityViolationRate: number;
        maxTouchSanityViolationRate: number;
        maxRecomputeMismatchRate: number;
        maxNegRateTier1: number;
        maxNegRateTier2: number;
        maxNegRateTier3: number;
        feeBpsTier1: number;
        feeBpsTier2: number;
        feeBpsTier3: number;
        sourceSkewMultiplier: number;
        tooBadBpsBuffer: number;
        sizeMonotonicityBps: number;
    };
}

const num = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

function handler(req: LocalRequest, res: NextApiResponse<SlippageRealismConfigResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(200).json({
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        config: {
            decisionFreshnessMs: num(process.env.SLIPPAGE_REALISM_DECISION_FRESHNESS_MS, 1000),
            sendFreshnessMs: num(process.env.SLIPPAGE_REALISM_SEND_FRESHNESS_MS, 500),
            fillFreshnessMs: num(process.env.SLIPPAGE_REALISM_FILL_FRESHNESS_MS, 500),
            illiqFillFreshnessMs: num(process.env.SLIPPAGE_REALISM_ILLIQ_FILL_FRESHNESS_MS, 1000),
            feeBps: num(process.env.SLIPPAGE_REALISM_FEE_BPS, 0),
            tooGoodSpreadWeight: num(process.env.SLIPPAGE_REALISM_TOO_GOOD_SPREAD_WEIGHT, 0.25),
            tooGoodBpsBuffer: num(process.env.SLIPPAGE_REALISM_TOO_GOOD_BPS_BUFFER, 2),
            maxMissingFillSnapshotRate: num(process.env.SLIPPAGE_REALISM_MAX_MISSING_FILL_SNAPSHOT_RATE, 0.02),
            maxStaleFillSnapshotRate: num(process.env.SLIPPAGE_REALISM_MAX_STALE_FILL_SNAPSHOT_RATE, 0.02),
            maxTsMonotonicityViolationRate: num(process.env.SLIPPAGE_REALISM_MAX_TS_MONOTONICITY_VIOLATION_RATE, 0.001),
            maxTouchSanityViolationRate: num(process.env.SLIPPAGE_REALISM_MAX_TOUCH_SANITY_VIOLATION_RATE, 0.0005),
            maxRecomputeMismatchRate: num(process.env.SLIPPAGE_REALISM_MAX_RECOMPUTE_MISMATCH_RATE, 0.01),
            maxNegRateTier1: num(process.env.SLIPPAGE_REALISM_MAX_NEG_RATE_TIER1, 0.05),
            maxNegRateTier2: num(process.env.SLIPPAGE_REALISM_MAX_NEG_RATE_TIER2, 0.1),
            maxNegRateTier3: num(process.env.SLIPPAGE_REALISM_MAX_NEG_RATE_TIER3, 0.15),
            feeBpsTier1: num(process.env.SLIPPAGE_REALISM_FEE_BPS_TIER1, 5),
            feeBpsTier2: num(process.env.SLIPPAGE_REALISM_FEE_BPS_TIER2, 10),
            feeBpsTier3: num(process.env.SLIPPAGE_REALISM_FEE_BPS_TIER3, 15),
            sourceSkewMultiplier: num(process.env.SLIPPAGE_REALISM_SOURCE_SKEW_MULTIPLIER, 1.5),
            tooBadBpsBuffer: num(process.env.SLIPPAGE_REALISM_TOO_BAD_BPS_BUFFER, 5),
            sizeMonotonicityBps: num(process.env.SLIPPAGE_REALISM_SIZE_MONOTONICITY_BPS, 5),
        },
    });
}

export default withLocalApi(handler);
