import { describe, expect, it } from 'vitest';
import { canonicalizePairKey, getPairKeyAliases } from '../../xrpl/currency';
import { dedupeTradesByHash, normalizeTradeUnits, Trade } from '../tradeHistory';

describe('pair normalization and tx-hash dedupe', () => {
    it('treats XRP/RLUSD and XRP/<hex> as the same canonical pair', () => {
        const human = canonicalizePairKey('XRP/RLUSD');
        const hex = canonicalizePairKey('XRP/524C555344000000000000000000000000000000');
        const aliases = getPairKeyAliases('XRP/524C555344000000000000000000000000000000');

        expect(human).toBe('XRP/RLUSD');
        expect(hex).toBe('XRP/RLUSD');
        expect(aliases).toContain('XRP/RLUSD');
        expect(aliases).toContain('XRP/524C555344000000000000000000000000000000');
    });

    it('keeps one final record per tx hash across pair-key variants', () => {
        const trades: Trade[] = [
            {
                id: 'bad-fb3e',
                timestamp: 1,
                ...normalizeTradeUnits({
                    pair: 'XRP/524C555344000000000000000000000000000000',
                    side: 'SELL',
                    price: 0.7245064299917702,
                    amount: 0.07500000000000001,
                    filled: 0.10351875000014843,
                    fee: 0.000012,
                    pnl: 0,
                    hash: 'FB3E6D9B10FDF1E8542A5506A1B815CBDFD25192B9F245E619456C62333212F3',
                    paper: false,
                    status: 'FILLED',
                    source: 'bot',
                }),
            },
            {
                id: 'good-fb3e',
                timestamp: 2,
                ...normalizeTradeUnits({
                    pair: 'XRP/RLUSD',
                    side: 'SELL',
                    price: 1.380250000001979,
                    amount: 0.075,
                    filled: 0.075,
                    filledBase: 0.075,
                    filledQuote: 0.10351875,
                    fee: 0,
                    pnl: 0,
                    hash: 'FB3E6D9B10FDF1E8542A5506A1B815CBDFD25192B9F245E619456C62333212F3',
                    paper: false,
                    status: 'FILLED',
                    source: 'bot',
                }),
            },
            {
                id: 'partial-f3b9',
                timestamp: 3,
                ...normalizeTradeUnits({
                    pair: 'XRP/524C555344000000000000000000000000000000',
                    side: 'BUY',
                    price: 1.39758891300718,
                    amount: 0.15000000000000002,
                    filled: 0.149725,
                    fee: 0.000012,
                    pnl: 0,
                    hash: 'F3B9785609845CF700B5443335B1EE056B27071BD48CE4CE7F672C0373F72C87',
                    paper: false,
                    status: 'PARTIAL',
                    source: 'bot',
                }),
            },
            {
                id: 'filled-f3b9',
                timestamp: 4,
                ...normalizeTradeUnits({
                    pair: 'XRP/RLUSD',
                    side: 'BUY',
                    price: 1.39758891300718,
                    amount: 0.149725,
                    filled: 0.149725,
                    fee: 0,
                    pnl: 0,
                    hash: 'F3B9785609845CF700B5443335B1EE056B27071BD48CE4CE7F672C0373F72C87',
                    paper: false,
                    status: 'FILLED',
                    source: 'bot',
                }),
            },
        ];

        const deduped = dedupeTradesByHash(trades);

        const fb3e = deduped.find((t) => t.hash === 'FB3E6D9B10FDF1E8542A5506A1B815CBDFD25192B9F245E619456C62333212F3');
        const f3b9 = deduped.find((t) => t.hash === 'F3B9785609845CF700B5443335B1EE056B27071BD48CE4CE7F672C0373F72C87');

        expect(deduped.length).toBe(2);
        expect(fb3e?.pair).toBe('XRP/RLUSD');
        expect(fb3e?.status).toBe('FILLED');
        expect(fb3e?.filledBase).toBeLessThanOrEqual((fb3e?.amountBase ?? 0) + 1e-9);
        expect(f3b9?.status).toBe('FILLED');
    });
});
