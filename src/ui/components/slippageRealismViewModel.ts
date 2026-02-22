export type SlippageCheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NO_DATA';
export type SlippageVerdict = 'GOOD' | 'WARN' | 'DEGRADED' | 'NO_DATA';

export interface SlippageRealismSummary {
    events: number;
    fills: number;
    avgDecisionToValidatedMs: number | null;
    missingFillSnapshotRate: number;
    staleFillSnapshotRate: number;
    tsMonotonicityViolationRate: number;
    negSlippageRate: number;
    tooGoodRate: number;
    tooBadRate: number;
}

export interface SlippageRealismConfigModel {
    decisionFreshnessMs: number;
    maxMissingFillSnapshotRate: number;
    maxStaleFillSnapshotRate: number;
    maxTsMonotonicityViolationRate: number;
    maxTouchSanityViolationRate: number;
    maxRecomputeMismatchRate: number;
    maxNegRateTier1: number;
    maxNegRateTier2: number;
    maxNegRateTier3: number;
    tooGoodBpsBuffer: number;
    tooBadBpsBuffer: number;
    sizeMonotonicityBps: number;
}

export interface SlippageRealismViewModel {
    verdict: SlippageVerdict;
    reasons: string[];
    checks: Array<{
        key: string;
        label: string;
        actual: number | null;
        limit: number | null;
        unit: '%' | 'bps' | 'ms';
        status: SlippageCheckStatus;
    }>;
}

const warnBuffer = 0.85;

function resolveStatus(actual: number | null, limit: number | null): SlippageCheckStatus {
    if (actual == null || limit == null || !Number.isFinite(actual) || !Number.isFinite(limit)) return 'NO_DATA';
    if (actual > limit) return 'FAIL';
    if (limit > 0 && actual >= limit * warnBuffer) return 'WARN';
    return 'PASS';
}

export function deriveSlippageRealismViewModel(
    summary: SlippageRealismSummary | null,
    config: SlippageRealismConfigModel | null,
): SlippageRealismViewModel {
    if (!summary || !config || summary.events <= 0) {
        return {
            verdict: 'NO_DATA',
            reasons: ['Waiting for slippage realism samples'],
            checks: [],
        };
    }

    const checks: SlippageRealismViewModel['checks'] = [
        {
            key: 'missingFillSnapshot',
            label: 'Missing fill snapshot rate',
            actual: summary.missingFillSnapshotRate,
            limit: config.maxMissingFillSnapshotRate,
            unit: '%',
            status: resolveStatus(summary.missingFillSnapshotRate, config.maxMissingFillSnapshotRate),
        },
        {
            key: 'staleFillSnapshot',
            label: 'Stale fill snapshot rate',
            actual: summary.staleFillSnapshotRate,
            limit: config.maxStaleFillSnapshotRate,
            unit: '%',
            status: resolveStatus(summary.staleFillSnapshotRate, config.maxStaleFillSnapshotRate),
        },
        {
            key: 'tsMonotonicity',
            label: 'TS monotonicity violation rate',
            actual: summary.tsMonotonicityViolationRate,
            limit: config.maxTsMonotonicityViolationRate,
            unit: '%',
            status: resolveStatus(summary.tsMonotonicityViolationRate, config.maxTsMonotonicityViolationRate),
        },
        {
            key: 'touchSanity',
            label: 'Touch sanity violation rate',
            actual: null,
            limit: config.maxTouchSanityViolationRate,
            unit: '%',
            status: 'NO_DATA',
        },
        {
            key: 'recomputeMismatch',
            label: 'Recompute mismatch rate',
            actual: null,
            limit: config.maxRecomputeMismatchRate,
            unit: '%',
            status: 'NO_DATA',
        },
        {
            key: 'negTier1',
            label: 'Negative slippage rate (tier1)',
            actual: summary.negSlippageRate,
            limit: config.maxNegRateTier1,
            unit: '%',
            status: resolveStatus(summary.negSlippageRate, config.maxNegRateTier1),
        },
        {
            key: 'negTier2',
            label: 'Negative slippage rate (tier2)',
            actual: summary.negSlippageRate,
            limit: config.maxNegRateTier2,
            unit: '%',
            status: resolveStatus(summary.negSlippageRate, config.maxNegRateTier2),
        },
        {
            key: 'negTier3',
            label: 'Negative slippage rate (tier3)',
            actual: summary.negSlippageRate,
            limit: config.maxNegRateTier3,
            unit: '%',
            status: resolveStatus(summary.negSlippageRate, config.maxNegRateTier3),
        },
        {
            key: 'decisionLatency',
            label: 'Decision-to-fill latency',
            actual: summary.avgDecisionToValidatedMs,
            limit: config.decisionFreshnessMs,
            unit: 'ms',
            status: resolveStatus(summary.avgDecisionToValidatedMs, config.decisionFreshnessMs),
        },
        {
            key: 'sizeMonotonicity',
            label: 'Size monotonicity deviation',
            actual: null,
            limit: config.sizeMonotonicityBps,
            unit: 'bps',
            status: 'NO_DATA',
        },
    ];

    const fails = checks.filter((check) => check.status === 'FAIL');
    const warns = checks.filter((check) => check.status === 'WARN');
    const hasUsable = checks.some((check) => check.status !== 'NO_DATA');
    const verdict: SlippageVerdict = !hasUsable
        ? 'NO_DATA'
        : fails.length > 0
            ? 'DEGRADED'
            : warns.length > 0
                ? 'WARN'
                : 'GOOD';

    const reasons: string[] = [];
    if (verdict === 'NO_DATA') {
        reasons.push('No measurable slippage realism metrics available yet');
    } else if (fails.length > 0) {
        reasons.push(`Policy breaches: ${fails.length}`);
        reasons.push(fails[0]!.label);
    } else if (warns.length > 0) {
        reasons.push(`Near-threshold checks: ${warns.length}`);
        reasons.push(warns[0]!.label);
    } else {
        reasons.push('All measurable slippage realism checks are within .env limits');
    }

    return {
        verdict,
        reasons,
        checks,
    };
}
