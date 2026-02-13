import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('execution quality persistence', () => {
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

    it('persists normalized execution quality event rows', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');
        const { queryExecutionQualityEvents } = await import('../feedbackDb');

        const id = feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_HASH_1',
            pairKey: 'XRP/RLUSD',
            side: 'sell',
            strategy: 'scalper',
            source: 'bot',
            intentPrice: 1.37,
            expectedPrice: 1.37,
            expectedPriceSource: 'intent',
            decisionMid: 1.37,
            decisionBid: 1.3698,
            decisionAsk: 1.3702,
            fillPrice: 1.371,
            amountBase: 0.25,
            filledBase: 0.25,
            filledQuote: 0.34275,
            status: 'FILLED',
        });

        expect(id).toBeTruthy();
        const rows = queryExecutionQualityEvents({ pairKey: 'XRP/RLUSD' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.txHash).toBe('EQ_HASH_1');
        expect(rows[0]?.pairKeyCanonical).toBe('XRP/RLUSD');
        expect(rows[0]?.filledBase).toBeCloseTo(0.25, 8);
        expect(rows[0]?.filledQuote).toBeCloseTo(0.34275, 8);
        expect(rows[0]?.fillPrice).toBeCloseTo(1.371, 8);
    });

    it('supports pair-key alias filtering for execution quality events', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');
        const { queryExecutionQualityEvents } = await import('../feedbackDb');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_HASH_ALIAS',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            fillPrice: 1.35,
            amountBase: 0.1,
            filledBase: 0.1,
            filledQuote: 0.135,
            status: 'FILLED',
        });

        const human = queryExecutionQualityEvents({ pairKey: 'XRP/RLUSD' });
        const hex = queryExecutionQualityEvents({ pairKey: 'XRP/524C555344000000000000000000000000000000' });

        expect(human).toHaveLength(1);
        expect(hex).toHaveLength(1);
        expect(human[0]?.id).toBe(hex[0]?.id);
        expect(human[0]?.txHash).toBe('EQ_HASH_ALIAS');
    });

    it('dedupes duplicate txHash rows via partial unique index', async () => {
        const { feedbackEngine } = await import('../feedbackEngine');
        const { queryExecutionQualityEvents } = await import('../feedbackDb');

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_HASH_DEDUPE',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            fillPrice: 1.3,
            amountBase: 0.2,
            filledBase: 0.2,
            filledQuote: 0.26,
            status: 'FILLED',
        });

        feedbackEngine.recordExecutionQualityEvent({
            txHash: 'EQ_HASH_DEDUPE',
            pairKey: 'XRP/RLUSD',
            side: 'buy',
            strategy: 'scalper',
            source: 'bot',
            fillPrice: 1.31,
            amountBase: 0.2,
            filledBase: 0.2,
            filledQuote: 0.262,
            status: 'FILLED',
        });

        const rows = queryExecutionQualityEvents({ pairKey: 'XRP/RLUSD' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.txHash).toBe('EQ_HASH_DEDUPE');
    });
});
