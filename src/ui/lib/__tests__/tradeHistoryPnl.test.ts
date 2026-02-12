import { describe, expect, it } from 'vitest';
import { computeFallbackRealizedPnl, type Trade } from '../tradeHistory';

function mkTrade(input: Partial<Trade> & Pick<Trade, 'side' | 'price' | 'amount' | 'status' | 'pair' | 'timestamp'>): Trade {
    return {
        id: input.id ?? `${input.timestamp}-${input.side}`,
        timestamp: input.timestamp,
        pair: input.pair,
        side: input.side,
        price: input.price,
        amount: input.amount,
        filled: input.filled ?? input.amount,
        fee: input.fee ?? 0,
        pnl: input.pnl ?? 0,
        hash: input.hash,
        paper: input.paper ?? true,
        status: input.status,
    };
}

describe('computeFallbackRealizedPnl', () => {
    it('computes realized PnL from FIFO buy/sell matching', () => {
        const trades: Trade[] = [
            mkTrade({ pair: 'XRP/RLUSD', side: 'BUY', price: 0.5, amount: 100, status: 'FILLED', timestamp: 1_000 }),
            mkTrade({ pair: 'XRP/RLUSD', side: 'SELL', price: 0.6, amount: 100, status: 'FILLED', timestamp: 2_000 }),
        ];

        const result = computeFallbackRealizedPnl(trades, 0);
        expect(result.total).toBeCloseTo(10, 8);
        expect(result.today).toBeCloseTo(10, 8);
    });

    it('realizes PnL only on matched sell quantity and respects today cutoff', () => {
        const trades: Trade[] = [
            mkTrade({ pair: 'XRP/RLUSD', side: 'BUY', price: 0.5, amount: 100, status: 'FILLED', timestamp: 1_000 }),
            mkTrade({ pair: 'XRP/RLUSD', side: 'SELL', price: 0.6, amount: 50, status: 'PARTIAL', timestamp: 2_000 }),
            mkTrade({ pair: 'XRP/RLUSD', side: 'SELL', price: 0.4, amount: 50, status: 'FILLED', timestamp: 3_000 }),
        ];

        const result = computeFallbackRealizedPnl(trades, 2_500);
        expect(result.total).toBeCloseTo(0, 8); // +5 then -5
        expect(result.today).toBeCloseTo(-5, 8); // only last sell in "today" window
    });
});
