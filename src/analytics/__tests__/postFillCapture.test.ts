import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function loadDb() {
    vi.resetModules();
    process.env.FEEDBACK_DB_PATH = ':memory:';
    const mod = await import('../feedbackDb');
    return mod;
}

describe('feedbackDb post-fill updates', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(async () => {
        const mod = await import('../feedbackDb');
        mod.closeFeedbackDb();
    });

    it('updates post-fill fields on trade_events', async () => {
        const mod = await loadDb();
        const {
            insertTradeEvent,
            updateTradeEventPostFill1s,
            updateTradeEventPostFill3s,
            queryTradeEvents,
        } = mod;

        insertTradeEvent({
            id: 'test-1',
            ts: Date.now(),
            pairKey: 'XRP/RLUSD',
            strategy: 'test',
            action: 'fill',
            side: 'buy',
            intentPrice: 1,
            intentSizeBase: 1,
            intentSizeQuote: null,
            fillPrice: 1,
            fillSizeBase: 1,
            fillSizeQuote: null,
            txHash: null,
            ledgerIndex: null,
            resultCode: null,
            error: null,
            isBotTrade: 1,
            midPriceAtDecision: 1,
            slippageBpsVsIntent: null,
            slippageBpsVsMid: null,
            spreadPaidBps: null,
            edgeBpsVsMid: null,
            netEdgeBpsVsMid: null,
            txFeeXrp: null,
            ammFeeBps: null,
            fillRatio: 1,
            isPartial: 0,
            entrySpreadBps: 12,
            entryFlowCombined: 0.1,
            entryFlowStrength: 0.2,
            entryFlowRegime: 'normal',
            postMid1s: null,
            postSpread1s: null,
            postFlowCombined1s: null,
            postFlowStrength1s: null,
            postFlowRegime1s: null,
            postMid3s: null,
            postSpread3s: null,
            postFlowCombined3s: null,
            postFlowStrength3s: null,
            postFlowRegime3s: null,
        });

        updateTradeEventPostFill1s({
            id: 'test-1',
            postMid1s: 1.01,
            postSpread1s: 11,
            postFlowCombined1s: 0.15,
            postFlowStrength1s: 0.25,
            postFlowRegime1s: 'normal',
        });

        updateTradeEventPostFill3s({
            id: 'test-1',
            postMid3s: 1.02,
            postSpread3s: 10,
            postFlowCombined3s: 0.18,
            postFlowStrength3s: 0.3,
            postFlowRegime3s: 'normal',
        });

        const events = queryTradeEvents();
        const event = events.find((e) => e.id === 'test-1');
        expect(event?.postMid1s).toBeCloseTo(1.01);
        expect(event?.postSpread1s).toBe(11);
        expect(event?.postFlowCombined1s).toBeCloseTo(0.15);
        expect(event?.postFlowStrength1s).toBeCloseTo(0.25);
        expect(event?.postMid3s).toBeCloseTo(1.02);
        expect(event?.postSpread3s).toBe(10);
        expect(event?.postFlowCombined3s).toBeCloseTo(0.18);
        expect(event?.postFlowStrength3s).toBeCloseTo(0.3);
    });
});
