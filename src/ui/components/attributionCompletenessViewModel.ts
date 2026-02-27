export type AttributionCheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NO_DATA';
export type AttributionVerdict = 'GOOD' | 'WARN' | 'DEGRADED' | 'NO_DATA';

export interface AttributionCompletenessConfigModel {
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
}

export interface AttributionWindowMetrics {
    events: number;
    unknownRate: number;
    collisionsPer10k: number;
    orphanFillsPer10k: number;
}

export interface AttributionCompletenessInput {
    daily: AttributionWindowMetrics | null;
    weekly: AttributionWindowMetrics | null;
    monthly: AttributionWindowMetrics | null;
    tsMonotonicityRate30d: number | null;
}

export interface AttributionCompletenessViewModel {
    verdict: AttributionVerdict;
    reasons: string[];
    checks: Array<{
        key: string;
        label: string;
        actual: number | null;
        limit: number | null;
        unit: '%' | 'per10k' | 'hours';
        status: AttributionCheckStatus;
    }>;
}

const warnBuffer = 0.85;

function resolveStatus(actual: number | null, limit: number | null): AttributionCheckStatus {
    if (actual == null || limit == null || !Number.isFinite(actual) || !Number.isFinite(limit)) return 'NO_DATA';
    if (actual > limit) return 'FAIL';
    if (limit > 0 && actual >= limit * warnBuffer) return 'WARN';
    return 'PASS';
}

export function deriveAttributionCompletenessViewModel(
    input: AttributionCompletenessInput | null,
    config: AttributionCompletenessConfigModel | null,
): AttributionCompletenessViewModel {
    if (!input || !config) {
        return {
            verdict: 'NO_DATA',
            reasons: ['Waiting for attribution completeness data'],
            checks: [],
        };
    }

    const checks: AttributionCompletenessViewModel['checks'] = [
        {
            key: 'unknownDaily',
            label: 'Unknown rate (daily)',
            actual: input.daily?.unknownRate ?? null,
            limit: config.unknownRateMaxDaily,
            unit: '%',
            status: resolveStatus(input.daily?.unknownRate ?? null, config.unknownRateMaxDaily),
        },
        {
            key: 'unknown7d',
            label: 'Unknown rate (7d)',
            actual: input.weekly?.unknownRate ?? null,
            limit: config.unknownRateMax7d,
            unit: '%',
            status: resolveStatus(input.weekly?.unknownRate ?? null, config.unknownRateMax7d),
        },
        {
            key: 'unknown30d',
            label: 'Unknown rate (30d)',
            actual: input.monthly?.unknownRate ?? null,
            limit: config.unknownRateMax30d,
            unit: '%',
            status: resolveStatus(input.monthly?.unknownRate ?? null, config.unknownRateMax30d),
        },
        {
            key: 'collisions',
            label: 'Collisions per 10k',
            actual: input.monthly?.collisionsPer10k ?? null,
            limit: config.collisionsMaxPer10k,
            unit: 'per10k',
            status: resolveStatus(input.monthly?.collisionsPer10k ?? null, config.collisionsMaxPer10k),
        },
        {
            key: 'orphanFills',
            label: 'Orphan fills per 10k',
            actual: input.monthly?.orphanFillsPer10k ?? null,
            limit: config.orphanFillsMaxPer10k,
            unit: 'per10k',
            status: resolveStatus(input.monthly?.orphanFillsPer10k ?? null, config.orphanFillsMaxPer10k),
        },
        {
            key: 'orphanOrders',
            label: 'Orphan orders per 10k',
            actual: null,
            limit: config.orphanOrdersMaxPer10k,
            unit: 'per10k',
            status: 'NO_DATA',
        },
        {
            key: 'dupFinal',
            label: 'Dup/final conflicts per 10k',
            actual: null,
            limit: config.dupFinalMaxPer10k,
            unit: 'per10k',
            status: 'NO_DATA',
        },
        {
            key: 'derivedShare',
            label: 'Derived share',
            actual: null,
            limit: config.derivedShareMax,
            unit: '%',
            status: 'NO_DATA',
        },
        {
            key: 'derivedReversal',
            label: 'Derived reversal rate',
            actual: null,
            limit: config.derivedReversalMax,
            unit: '%',
            status: 'NO_DATA',
        },
        {
            key: 'quarantineP95',
            label: 'Quarantine P95 hours',
            actual: null,
            limit: config.quarantineP95MaxHours,
            unit: 'hours',
            status: 'NO_DATA',
        },
        {
            key: 'tsMonotonicity',
            label: 'TS monotonicity violation rate',
            actual: input.tsMonotonicityRate30d,
            limit: config.tsMonotonicityMaxRate,
            unit: '%',
            status: resolveStatus(input.tsMonotonicityRate30d, config.tsMonotonicityMaxRate),
        },
    ];

    const fails = checks.filter((check) => check.status === 'FAIL');
    const warns = checks.filter((check) => check.status === 'WARN');
    const hasUsable = checks.some((check) => check.status !== 'NO_DATA');
    const verdict: AttributionVerdict = !hasUsable
        ? 'NO_DATA'
        : fails.length > 0
            ? 'DEGRADED'
            : warns.length > 0
                ? 'WARN'
                : 'GOOD';

    const reasons: string[] = [];
    if (verdict === 'NO_DATA') {
        reasons.push('No measurable attribution completeness metrics available yet');
    } else if (fails.length > 0) {
        reasons.push(`Policy breaches: ${fails.length}`);
        reasons.push(fails[0]!.label);
    } else if (warns.length > 0) {
        reasons.push(`Near-threshold checks: ${warns.length}`);
        reasons.push(warns[0]!.label);
    } else {
        reasons.push('All measurable attribution checks are within .env limits');
    }

    return {
        verdict,
        reasons,
        checks,
    };
}
