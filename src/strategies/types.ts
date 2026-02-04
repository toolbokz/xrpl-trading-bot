import { OrderBookState } from '../utils/types';
import { Trade, TradeAggression } from '../market/tradeTape';
import { FlowMetrics } from '../market/flowMetrics';

export interface StrategyContext {
    orderBook: OrderBookState;
    ledgerIndex: number;
    /** Recent trades within 60s window (optional, for trade-tape-aware strategies) */
    trades?: Trade[] | undefined;
    /** Trade aggression stats within 10s window (buy/sell volume & count) */
    tradeStats?: TradeAggression | undefined;
    /** Volume-Weighted Average Price over 60s window */
    vwap?: number | null | undefined;
    /** Flow metrics with regime classification (computed from trade tape + order book) */
    flow?: FlowMetrics | undefined;
}

export interface Strategy {
    name: string;
    tick(ctx: StrategyContext): Promise<void>;
    shutdown?(): Promise<void>;
}
