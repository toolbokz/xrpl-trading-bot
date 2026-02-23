export type MarketDataReadinessReason = 'NO_MARKET_DATA' | 'STALE_MARKET_DATA';

export interface MarketDataReadinessContext {
    paper: boolean;
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    spreadBps: number | null;
    snapshotAgeMs: number | null;
    bookMaxAgeMs?: number;
}

export interface MarketDataReadinessResult {
    ok: boolean;
    reason?: MarketDataReadinessReason;
    warning?: MarketDataReadinessReason;
}

const DEFAULT_BOOK_MAX_AGE_MS = 1500;

function isFiniteNumber(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function resolveReadinessReason(ctx: MarketDataReadinessContext): MarketDataReadinessReason | null {
    if (!isFiniteNumber(ctx.bestBid) || !isFiniteNumber(ctx.bestAsk) || !isFiniteNumber(ctx.mid) || !isFiniteNumber(ctx.spreadBps)) {
        return 'NO_MARKET_DATA';
    }

    if (!isFiniteNumber(ctx.snapshotAgeMs)) {
        return 'NO_MARKET_DATA';
    }

    const maxAgeMs = isFiniteNumber(ctx.bookMaxAgeMs) && ctx.bookMaxAgeMs >= 0
        ? ctx.bookMaxAgeMs
        : DEFAULT_BOOK_MAX_AGE_MS;
    if (ctx.snapshotAgeMs > maxAgeMs) {
        return 'STALE_MARKET_DATA';
    }

    return null;
}

export function assertMarketDataReady(ctx: MarketDataReadinessContext): MarketDataReadinessResult {
    const reason = resolveReadinessReason(ctx);
    if (reason == null) {
        return { ok: true };
    }

    if (ctx.paper) {
        return {
            ok: true,
            warning: reason,
        };
    }

    return {
        ok: false,
        reason,
    };
}
