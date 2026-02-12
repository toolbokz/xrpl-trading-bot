import { NextResponse } from 'next/server';
import { getCacheSnapshot } from '../../../../../runtime/runtimeSingleton';

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
}

export async function GET(): Promise<NextResponse> {
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
    };

    return NextResponse.json({
        ok: true,
        snapshot: light,
    });
}
