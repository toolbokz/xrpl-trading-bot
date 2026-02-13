import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('edge attribution persistence', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.FEEDBACK_DB_PATH = ':memory:';
    });

    afterEach(async () => {
        const engine = await import('../feedbackEngine');
        engine.feedbackEngine.shutdown();
        const db = await import('../feedbackDb');
        db.closeFeedbackDb();
    });

    it('persists edge attribution rows with canonical pair key fields', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');
        const { queryEdgeAttributionEvents } = await import('../feedbackDb');

        const id = feedbackEngine.recordEdgeAttributionEvent({
            txHash: 'EDGE_HASH_1',
            pairKey: 'XRP/RLUSD',
            side: 'sell',
            strategy: 'scalper',
            source: 'bot',
            midDecision: 1.37,
            bidDecision: 1.3698,
            askDecision: 1.3702,
            fillPrice: 1.371,
            baseFilled: 0.25,
            filledQuote: 0.34275,
            strategyFair: 1.372,
        });

        expect(id).toBeTruthy();
        const rows = queryEdgeAttributionEvents({ pairKey: 'XRP/RLUSD' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.txHash).toBe('EDGE_HASH_1');
        expect(rows[0]?.pairKeyCanonical).toBe('XRP/RLUSD');
        expect(rows[0]?.fillPrice).toBeCloseTo(1.371, 8);
        expect(rows[0]?.baseFilled).toBeCloseTo(0.25, 8);
        expect(rows[0]?.filledQuote).toBeCloseTo(0.34275, 8);
        expect(rows[0]?.executionEdgeBpsVsMid).not.toBeNull();
    });

    it('supports pair-key alias filtering for edge attribution events', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');
        const { queryEdgeAttributionEvents } = await import('../feedbackDb');

        feedbackEngine.recordEdgeAttributionEvent({
            txHash: 'EDGE_HASH_ALIAS',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            midDecision: 1.35,
            bidDecision: 1.3498,
            askDecision: 1.3502,
            fillPrice: 1.3501,
            baseFilled: 0.1,
            filledQuote: 0.13501,
        });

        const human = queryEdgeAttributionEvents({ pairKey: 'XRP/RLUSD' });
        const hex = queryEdgeAttributionEvents({ pairKey: 'XRP/524C555344000000000000000000000000000000' });

        expect(human).toHaveLength(1);
        expect(hex).toHaveLength(1);
        expect(human[0]?.id).toBe(hex[0]?.id);
        expect(human[0]?.txHash).toBe('EDGE_HASH_ALIAS');
    });

    it('dedupes duplicate txHash rows via partial unique index', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');
        const { queryEdgeAttributionEvents } = await import('../feedbackDb');

        feedbackEngine.recordEdgeAttributionEvent({
            txHash: 'EDGE_HASH_DEDUPE',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            midDecision: 1.35,
            bidDecision: 1.3498,
            askDecision: 1.3502,
            fillPrice: 1.3501,
            baseFilled: 0.1,
            filledQuote: 0.13501,
        });

        feedbackEngine.recordEdgeAttributionEvent({
            txHash: 'EDGE_HASH_DEDUPE',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            midDecision: 1.36,
            bidDecision: 1.3598,
            askDecision: 1.3602,
            fillPrice: 1.3601,
            baseFilled: 0.1,
            filledQuote: 0.13601,
        });

        const rows = queryEdgeAttributionEvents({ pairKey: 'XRP/RLUSD' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.txHash).toBe('EDGE_HASH_DEDUPE');
    });
});
