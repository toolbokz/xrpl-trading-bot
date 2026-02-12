import type { RuntimeCacheLightSnapshot } from '../lib/hooks/useRuntimeCache';

export type RadarSortKey = 'stale' | 'spread' | 'depth';

export interface ScannerSourceItem {
    pairKey: string;
    mid: number;
    weight: number;
    stalenessMs: number;
    verdict?: string;
}

export interface ScannerMarketItem {
    pairKey: string;
    mid: number;
    spreadBps: number;
    depthTopNotional: number;
    stalenessMs: number;
    verdict: string;
}

export interface ScannerBackgroundView {
    asOfMs: number | null;
    health: {
        score: number | null;
        verdict: string | null;
        degraded: boolean;
        lastOkAtMs: number | null;
        lastErrorAtMs: number | null;
        consecutiveFailures: number;
        lastError: string | null;
    };
    fairValue: {
        fairValue: number | null;
        confidence: number | null;
        divergenceBps: number | null;
        sources: ScannerSourceItem[];
    };
    markets: ScannerMarketItem[];
}

const toNum = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const toStr = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value : null;

const get = (obj: unknown, key: string): unknown =>
    obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;

export function toBackgroundView(snapshot: RuntimeCacheLightSnapshot | null | undefined): ScannerBackgroundView | null {
    const bg = snapshot?.background;
    if (!bg || typeof bg !== 'object') return null;

    const healthObj = get(bg, 'health');
    const fairObj = get(bg, 'fairValue');
    const marketsObj = get(bg, 'markets');

    const score = toNum(get(healthObj, 'score'));
    const verdict = toStr(get(healthObj, 'verdict'));
    const degraded = Boolean(get(healthObj, 'degraded'))
        || (score !== null && score < 60)
        || (toNum(get(healthObj, 'consecutiveFailures')) ?? 0) > 0;

    const fairValue =
        toNum(get(fairObj, 'fairValue'))
        ?? toNum(get(fairObj, 'xrpFairValue'))
        ?? toNum(get(fairObj, 'xrpMid'));

    const divergenceBps =
        toNum(get(fairObj, 'divergenceBps'))
        ?? toNum(get(fairObj, 'divergenceBpsVsXrpRlusd'));

    const rawSources = get(fairObj, 'sources') ?? get(fairObj, 'sourcesUsed');
    const sources: ScannerSourceItem[] = Array.isArray(rawSources)
        ? rawSources.map((item) => {
            const verdict = toStr(get(item, 'verdict'));
            return {
                pairKey: toStr(get(item, 'pairKey')) ?? 'unknown',
                mid: toNum(get(item, 'mid')) ?? 0,
                weight: toNum(get(item, 'weight')) ?? 0,
                stalenessMs: toNum(get(item, 'stalenessMs')) ?? 0,
                ...(verdict ? { verdict } : {}),
            };
        })
        : [];

    const markets: ScannerMarketItem[] = parseMarkets(marketsObj);

    return {
        asOfMs: toNum(get(bg, 'asOfMs')),
        health: {
            score,
            verdict,
            degraded,
            lastOkAtMs: toNum(get(healthObj, 'lastOkAtMs')),
            lastErrorAtMs: toNum(get(healthObj, 'lastErrorAtMs')),
            consecutiveFailures: toNum(get(healthObj, 'consecutiveFailures')) ?? 0,
            lastError: toStr(get(healthObj, 'lastError')),
        },
        fairValue: {
            fairValue,
            confidence: toNum(get(fairObj, 'confidence')),
            divergenceBps,
            sources,
        },
        markets,
    };
}

function parseMarkets(marketsObj: unknown): ScannerMarketItem[] {
    if (Array.isArray(marketsObj)) {
        return marketsObj.map((item) => ({
            pairKey: toStr(get(item, 'pairKey')) ?? 'unknown',
            mid: toNum(get(item, 'mid')) ?? 0,
            spreadBps: toNum(get(item, 'spreadBps')) ?? 0,
            depthTopNotional: toNum(get(item, 'depthTopNotional')) ?? 0,
            stalenessMs: toNum(get(item, 'stalenessMs')) ?? 0,
            verdict: toStr(get(item, 'verdict')) ?? 'UNKNOWN',
        }));
    }

    if (marketsObj && typeof marketsObj === 'object') {
        return Object.entries(marketsObj as Record<string, unknown>).map(([pairKey, item]) => ({
            pairKey,
            mid: toNum(get(item, 'mid')) ?? 0,
            spreadBps: toNum(get(item, 'spreadBps')) ?? 0,
            depthTopNotional: toNum(get(item, 'depthTopNotional')) ?? 0,
            stalenessMs: toNum(get(item, 'stalenessMs')) ?? 0,
            verdict: toStr(get(item, 'verdict')) ?? 'UNKNOWN',
        }));
    }

    return [];
}

export function sortMarkets(markets: ScannerMarketItem[], sortBy: RadarSortKey): ScannerMarketItem[] {
    const copy = [...markets];
    copy.sort((a, b) => {
        if (sortBy === 'spread') return b.spreadBps - a.spreadBps;
        if (sortBy === 'depth') return b.depthTopNotional - a.depthTopNotional;
        return b.stalenessMs - a.stalenessMs;
    });
    return copy;
}
