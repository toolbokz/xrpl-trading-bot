import type { AvailabilityVerdict } from '../availabilityScanner';

export type BackgroundScannerVerdict = AvailabilityVerdict | 'UNKNOWN';

export interface BackgroundScannerMarketSnapshot {
    bid: number;
    ask: number;
    mid: number;
    spreadBps: number;
    depthTopNotional: number;
    updatedAtMs: number;
    stalenessMs: number;
    verdict: BackgroundScannerVerdict;
}

export interface BackgroundScannerFairValueSource {
    pairKey: string;
    mid: number;
    weight: number;
    stalenessMs: number;
}

export interface BackgroundScannerFairValueSnapshot {
    xrpMid: number | null;
    confidence: number;
    sourcesUsed: BackgroundScannerFairValueSource[];
    divergenceBpsVsXrpRlusd: number | null;
}

export interface BackgroundScannerHealthSnapshot {
    score: number;
    lastOkAtMs: number | null;
    lastErrorAtMs: number | null;
    consecutiveFailures: number;
    lastError?: string;
}

export interface BackgroundScannerCrossMarketSnapshot {
    liquidityScore: number;
    volatilityScore: number;
    notes: string[];
    bestPairs?: BackgroundScannerBestPairScore[];
}

export interface BackgroundScannerBestPairScore {
    pairKey: string;
    score: number;
    spreadBps: number;
    depthTopNotional: number;
    stalenessMs: number;
    verdict: BackgroundScannerVerdict;
}

export interface BackgroundScannerSnapshot {
    asOfMs: number;
    health: BackgroundScannerHealthSnapshot;
    fairValue: BackgroundScannerFairValueSnapshot;
    crossMarket: BackgroundScannerCrossMarketSnapshot;
    markets: Record<string, BackgroundScannerMarketSnapshot>;
}

export interface FairValueAnchorInput {
    pairKey: string;
    mid: number;
    spreadBps: number;
    stalenessMs: number;
    verdict: BackgroundScannerVerdict;
}

export interface FairValueModelConfig {
    maxStalenessMs: number;
    outlierThresholdBps: number;
    degradedPenalty: number;
    minSpreadBps: number;
}

export interface BackgroundScannerConfig {
    enabled: boolean;
    maxMarkets: number;
    maxRps: number;
    tier1IntervalMs: number;
    tier2IntervalMs: number;
    requestTimeoutMs: number;
    maxStalenessMs: number;
    discoveryEnabled?: boolean | undefined;
    discoveryMinLiquidityUsd?: number | undefined;
    discoveryMinVolumeUsd?: number | undefined;
    discoveryMaxRuntimeMs?: number | undefined;
}

export const DEFAULT_BACKGROUND_SCANNER_CONFIG: BackgroundScannerConfig = {
    enabled: true,
    maxMarkets: 30,
    maxRps: 2,
    tier1IntervalMs: 3000,
    tier2IntervalMs: 15000,
    requestTimeoutMs: 5000,
    maxStalenessMs: 20000,
    discoveryEnabled: false,
    discoveryMinLiquidityUsd: 50_000,
    discoveryMinVolumeUsd: 10_000,
    discoveryMaxRuntimeMs: 3000,
};

export const DEFAULT_FAIR_VALUE_MODEL_CONFIG: FairValueModelConfig = {
    maxStalenessMs: 20000,
    outlierThresholdBps: 150,
    degradedPenalty: 0.6,
    minSpreadBps: 1,
};
