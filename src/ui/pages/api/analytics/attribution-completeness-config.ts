import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';

export const config = {
    api: { bodyParser: false },
};

interface AttributionCompletenessConfigResponse {
    requestId: string;
    timestamp: string;
    config: {
        unknownRateMaxDaily: number;
        unknownRateMax7d: number;
        unknownRateMax30d: number;
        collisionsMaxPer10k: number;
        orphanFillsMaxPer10k: number;
        orphanOrdersMaxPer10k: number;
        dupFinalMaxPer10k: number;
        derivedShareMax: number;
        derivedReversalMax: number;
        quarantineP95MaxHours: number;
        tsMonotonicityMaxRate: number;
        derivedWindowMs: number;
        derivedSizeTolerance: number;
        derivedConfidenceMin: number;
        mappingModes: string[];
        quarantineDefaultStatuses: string[];
    };
}

const num = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value: string | undefined): string[] => (
    value
        ? value.split(',').map((part) => part.trim()).filter(Boolean)
        : []
);

function handler(req: LocalRequest, res: NextApiResponse<AttributionCompletenessConfigResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(200).json({
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        config: {
            unknownRateMaxDaily: num(process.env.ATTRIBUTION_UNKNOWN_RATE_MAX_DAILY, 0.01),
            unknownRateMax7d: num(process.env.ATTRIBUTION_UNKNOWN_RATE_MAX_7D, 0.005),
            unknownRateMax30d: num(process.env.ATTRIBUTION_UNKNOWN_RATE_MAX_30D, 0.002),
            collisionsMaxPer10k: num(process.env.ATTRIBUTION_COLLISIONS_MAX_PER_10K, 2),
            orphanFillsMaxPer10k: num(process.env.ATTRIBUTION_ORPHAN_FILLS_MAX_PER_10K, 1),
            orphanOrdersMaxPer10k: num(process.env.ATTRIBUTION_ORPHAN_ORDERS_MAX_PER_10K, 1),
            dupFinalMaxPer10k: num(process.env.ATTRIBUTION_DUP_FINAL_MAX_PER_10K, 1),
            derivedShareMax: num(process.env.ATTRIBUTION_DERIVED_SHARE_MAX, 0.05),
            derivedReversalMax: num(process.env.ATTRIBUTION_DERIVED_REVERSAL_MAX, 0.01),
            quarantineP95MaxHours: num(process.env.ATTRIBUTION_QUARANTINE_P95_MAX_HOURS, 24),
            tsMonotonicityMaxRate: num(process.env.ATTRIBUTION_TS_MONOTONICITY_MAX_RATE, 0.001),
            derivedWindowMs: num(process.env.ATTRIBUTION_DERIVED_WINDOW_MS, 3000),
            derivedSizeTolerance: num(process.env.ATTRIBUTION_DERIVED_SIZE_TOLERANCE, 0.02),
            derivedConfidenceMin: num(process.env.ATTRIBUTION_DERIVED_CONFIDENCE_MIN, 0.95),
            mappingModes: list(process.env.ATTRIBUTION_MAPPING_MODES),
            quarantineDefaultStatuses: list(process.env.ATTRIBUTION_QUARANTINE_DEFAULT_STATUSES),
        },
    });
}

export default withLocalApi(withApiRouteContext(handler));
