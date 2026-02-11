import {
    DEFAULT_FAIR_VALUE_MODEL_CONFIG,
    FairValueAnchorInput,
    FairValueModelConfig,
    BackgroundScannerFairValueSnapshot,
    BackgroundScannerFairValueSource,
} from './types';

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
    return sorted[mid]!;
};

const isEligibleVerdict = (verdict: FairValueAnchorInput['verdict']): boolean =>
    verdict === 'AVAILABLE' || verdict === 'DEGRADED';

export function computeFairValue(
    anchors: FairValueAnchorInput[],
    config: Partial<FairValueModelConfig> = {},
): BackgroundScannerFairValueSnapshot {
    const cfg: FairValueModelConfig = { ...DEFAULT_FAIR_VALUE_MODEL_CONFIG, ...config };

    const viable = anchors.filter((anchor) =>
        anchor.mid > 0
        && Number.isFinite(anchor.mid)
        && anchor.stalenessMs <= cfg.maxStalenessMs
        && isEligibleVerdict(anchor.verdict),
    );

    if (viable.length === 0) {
        return {
            xrpMid: null,
            confidence: 0,
            sourcesUsed: [],
            divergenceBpsVsXrpRlusd: null,
        };
    }

    const med = median(viable.map((anchor) => anchor.mid));
    const filtered = viable.filter((anchor) => {
        if (med <= 0) return false;
        const deviationBps = Math.abs(anchor.mid - med) / med * 10_000;
        return deviationBps <= cfg.outlierThresholdBps;
    });

    if (filtered.length === 0) {
        return {
            xrpMid: null,
            confidence: 0,
            sourcesUsed: [],
            divergenceBpsVsXrpRlusd: null,
        };
    }

    const weighted = filtered.map((anchor) => {
        const spread = Math.max(cfg.minSpreadBps, anchor.spreadBps || cfg.minSpreadBps);
        const spreadWeight = 1 / spread;
        const stalenessWeight = clamp(1 - (anchor.stalenessMs / cfg.maxStalenessMs), 0.15, 1);
        const verdictWeight = anchor.verdict === 'DEGRADED' ? cfg.degradedPenalty : 1;
        const weight = spreadWeight * stalenessWeight * verdictWeight;
        return { anchor, weight };
    }).filter((row) => Number.isFinite(row.weight) && row.weight > 0);

    const totalWeight = weighted.reduce((sum, row) => sum + row.weight, 0);
    if (totalWeight <= 0) {
        return {
            xrpMid: null,
            confidence: 0,
            sourcesUsed: [],
            divergenceBpsVsXrpRlusd: null,
        };
    }

    const xrpMid = weighted.reduce((sum, row) => sum + row.anchor.mid * row.weight, 0) / totalWeight;
    const sourcesUsed: BackgroundScannerFairValueSource[] = weighted.map((row) => ({
        pairKey: row.anchor.pairKey,
        mid: row.anchor.mid,
        weight: row.weight / totalWeight,
        stalenessMs: row.anchor.stalenessMs,
    }));

    const averageSpread = weighted.reduce((sum, row) => sum + row.anchor.spreadBps, 0) / weighted.length;
    const averageStaleness = weighted.reduce((sum, row) => sum + row.anchor.stalenessMs, 0) / weighted.length;

    const sourceScore = clamp(sourcesUsed.length / 3, 0, 1);
    const spreadScore = clamp(1 - (averageSpread / 120), 0, 1);
    const stalenessScore = clamp(1 - (averageStaleness / cfg.maxStalenessMs), 0, 1);
    const outlierScore = clamp(filtered.length / viable.length, 0, 1);

    const confidence = Math.round(clamp(
        (sourceScore * 0.35 + spreadScore * 0.3 + stalenessScore * 0.25 + outlierScore * 0.1) * 100,
        0,
        100,
    ));

    return {
        xrpMid,
        confidence,
        sourcesUsed,
        divergenceBpsVsXrpRlusd: null,
    };
}
