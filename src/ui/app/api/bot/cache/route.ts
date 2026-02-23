import { NextResponse } from 'next/server';
import { getCacheSnapshot } from '../../../../../runtime/runtimeSingleton';
import { isAuditGuardsEnabled } from '../../../../../config/featureFlags';
import { evaluateAppRouteGuard } from '../../../../lib/localApi/appRouteGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LightRuntimeCacheSnapshot {
    pairKey: string;
    asOfMs: number;
    sequence: number;
    runtimeState: string | null;
    executionAllowed: boolean;
    background: unknown | null;
    orderbookMidPrice: number | null;
    orderbookSpreadBps: number | null;
    spreadDistribution: {
        updatedAtMs: number;
        lookback24h: {
            sampleCount: number;
            medianBps: number | null;
            p75Bps: number | null;
            p90Bps: number | null;
        };
        baselineMultiDay: {
            days: number;
            sampleCount: number;
            medianBps: number | null;
            p75Bps: number | null;
            p90Bps: number | null;
        };
    } | null;
    volatilityStop: {
        enabled: boolean;
        volBps: number;
        volReady: boolean;
        stopLossBpsUsed: number;
        source: string;
    } | null;
}

export async function GET(request: Request): Promise<NextResponse> {
    if (isAuditGuardsEnabled()) {
        const guardResult = evaluateAppRouteGuard(request.headers, process.env);
        if (!guardResult.allowed) {
            return NextResponse.json({
                error: guardResult.error,
                reason: guardResult.reason,
            }, {
                status: guardResult.status,
            });
        }
    }

    const snapshot = getCacheSnapshot();

    if (!snapshot) {
        return NextResponse.json({
            ok: true,
            snapshot: null,
        });
    }

    const ob = snapshot.orderbook?.data?.snapshot ?? null;
    const orderbookMidPrice = ob && ob.bestBid > 0 && ob.bestAsk > 0
        ? (ob.bestBid + ob.bestAsk) / 2
        : null;

    const light: LightRuntimeCacheSnapshot = {
        pairKey: snapshot.pairKey,
        asOfMs: snapshot.asOfMs,
        sequence: snapshot.sequence,
        runtimeState: snapshot.runtimeState,
        executionAllowed: snapshot.executionAllowed,
        background: snapshot.background ?? null,
        orderbookMidPrice,
        orderbookSpreadBps: ob?.spreadBps ?? null,
        spreadDistribution: snapshot.spreadDistribution ?? null,
        volatilityStop: snapshot.volatilityStop ? {
            enabled: snapshot.volatilityStop.enabled,
            volBps: snapshot.volatilityStop.volBps,
            volReady: snapshot.volatilityStop.volReady,
            stopLossBpsUsed: snapshot.volatilityStop.stopLossBpsUsed,
            source: snapshot.volatilityStop.source,
        } : null,
    };

    return NextResponse.json({
        ok: true,
        snapshot: light,
    });
}
