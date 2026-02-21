import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { getCacheSnapshot, isSingleProcessMode } from '../../../lib/runtimeBridge';
import type { VolatilityStopSource } from '../../../../market/volatilityEstimator';

export const config = {
    api: { bodyParser: false },
};

export interface VolatilityStopApiResponse {
    requestId: string;
    timestamp: string;
    pairKey: string;
    asOfMs: number;
    stalenessMs: number;
    executionAllowed: boolean;
    runtimeState: string | null;
    config: {
        enabled: boolean;
        warmupMs: number;
        minSamples: number;
        alpha: number;
        multiplier: number;
        minBps: number;
        maxBps: number;
        useForEnhanced: boolean;
        fixedStopLossBps: number;
    };
    runtime: {
        enabled: boolean;
        volBps: number;
        volReady: boolean;
        sampleCount: number;
        stopLossBpsUsed: number;
        enhancedStopBpsUsed: number;
        source: VolatilityStopSource;
    } | null;
}

function handler(req: LocalRequest, res: NextApiResponse<VolatilityStopApiResponse>) {
    const runtime = ensureRuntimeHooks();
    const cfg = runtime.getConfig();
    const cache = isSingleProcessMode() ? getCacheSnapshot() : null;
    const nowMs = Date.now();
    const volCfg = cfg.strategy.volatilityStop;

    const pairKey = cache?.pairKey ?? `${cfg.tradingPair.baseCurrency}/${cfg.tradingPair.quoteCurrency}`;
    const asOfMs = cache?.asOfMs ?? nowMs;
    const snapshot = cache?.volatilityStop ?? null;

    res.status(200).json({
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        pairKey,
        asOfMs,
        stalenessMs: Math.max(0, nowMs - asOfMs),
        executionAllowed: cache?.executionAllowed ?? false,
        runtimeState: cache?.runtimeState ?? null,
        config: {
            enabled: volCfg?.enabled === true,
            warmupMs: volCfg?.warmupMs ?? 60_000,
            minSamples: volCfg?.minSamples ?? 50,
            alpha: volCfg?.alpha ?? 0.2,
            multiplier: volCfg?.multiplier ?? 2,
            minBps: volCfg?.minBps ?? cfg.strategy.stopLossBps,
            maxBps: volCfg?.maxBps ?? cfg.strategy.stopLossBps,
            useForEnhanced: volCfg?.useForEnhanced !== false,
            fixedStopLossBps: cfg.strategy.stopLossBps,
        },
        runtime: snapshot ? {
            enabled: snapshot.enabled,
            volBps: snapshot.volBps,
            volReady: snapshot.volReady,
            sampleCount: snapshot.sampleCount,
            stopLossBpsUsed: snapshot.stopLossBpsUsed,
            enhancedStopBpsUsed: snapshot.enhancedStopBpsUsed,
            source: snapshot.source,
        } : null,
    });
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
