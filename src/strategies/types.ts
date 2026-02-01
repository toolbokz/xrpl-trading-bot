import { OrderBookState } from '../utils/types';

export interface StrategyContext {
    orderBook: OrderBookState;
    ledgerIndex: number;
}

export interface Strategy {
    name: string;
    tick(ctx: StrategyContext): Promise<void>;
}
