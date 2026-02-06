import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradingRuntime } from '../tradingRuntime';

const ORIG_LOCAL_ONLY = process.env.BOT_LOCAL_ONLY;

type PairSwitchableRuntime = TradingRuntime & {
    getActivePair?: () => string;
    setActivePair?: (pairKey: string) => { success: boolean; activePair?: string; error?: string };
};

function getActivePair(runtime: TradingRuntime): string {
    const candidate = runtime as PairSwitchableRuntime;
    if (typeof candidate.getActivePair === 'function') {
        return candidate.getActivePair();
    }

    const tradingPair = (runtime as unknown as { baseConfig?: { tradingPair?: { baseCurrency?: string; quoteCurrency?: string } } })
        .baseConfig?.tradingPair;
    if (!tradingPair?.baseCurrency || !tradingPair?.quoteCurrency) {
        throw new Error('Unable to resolve active pair from runtime');
    }
    return `${tradingPair.baseCurrency}/${tradingPair.quoteCurrency}`;
}

function setActivePair(runtime: TradingRuntime, pairKey: string): { success: boolean; activePair?: string; error?: string } {
    const candidate = runtime as PairSwitchableRuntime;
    if (typeof candidate.setActivePair === 'function') {
        return candidate.setActivePair(pairKey);
    }
    throw new Error('setActivePair is not available on TradingRuntime');
}

describe('TradingRuntime pair switching', () => {
    let runtime: TradingRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.BOT_LOCAL_ONLY = 'true';
        runtime = new TradingRuntime();
    });

    afterEach(async () => {
        await runtime.shutdown();

        if (ORIG_LOCAL_ONLY === undefined) {
            delete process.env.BOT_LOCAL_ONLY;
        } else {
            process.env.BOT_LOCAL_ONLY = ORIG_LOCAL_ONLY;
        }
    });

    it('is idempotent when switching to active pair', () => {
        const active = getActivePair(runtime);

        const result = setActivePair(runtime, active);
        expect(result.success).toBe(true);
        expect(result.activePair ?? getActivePair(runtime)).toBe(active);
        expect(getActivePair(runtime)).toBe(active);
    });

    it('rejects invalid pair key and keeps current active pair', () => {
        const before = getActivePair(runtime);

        const result = setActivePair(runtime, 'XRP/INVALID');

        expect(result.success).toBe(false);
        expect(result.activePair ?? getActivePair(runtime)).toBe(before);
        expect(getActivePair(runtime)).toBe(before);
    });

    it('rolls back active pair if switching fails during apply', () => {
        const before = getActivePair(runtime);

        Reflect.set(runtime as unknown as object, 'tradeTape', {
            setPair: () => {
                throw new Error('boom');
            },
        });

        const result = setActivePair(runtime, 'XRP/USDC');

        expect(result.success).toBe(false);
        expect(result.activePair ?? getActivePair(runtime)).toBe(before);
        expect(getActivePair(runtime)).toBe(before);
    });
});
