import type { VolatilityStopApiResponse } from '../pages/api/bot/volatility-stop';

export type VolatilityStopMode = 'OFF' | 'WARMING' | 'ACTIVE';

const clamp = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, value))
);

export function deriveVolatilityStopMode(data: VolatilityStopApiResponse | null): VolatilityStopMode {
    if (!data || !data.config.enabled) return 'OFF';
    if (data.runtime?.volReady && data.runtime.source === 'adaptive') return 'ACTIVE';
    return 'WARMING';
}

export function deriveWarmupProgressPct(data: VolatilityStopApiResponse | null): number {
    if (!data || !data.config.enabled) return 0;
    const runtime = data.runtime;
    if (!runtime) return 0;
    if (runtime.volReady) return 100;
    if (data.config.minSamples <= 0) return 0;
    return clamp((runtime.sampleCount / data.config.minSamples) * 100, 0, 99);
}

export function deriveEffectiveStopBps(data: VolatilityStopApiResponse | null): number {
    if (!data) return 0;
    return data.runtime?.stopLossBpsUsed ?? data.config.fixedStopLossBps;
}
