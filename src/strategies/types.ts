import { OrderBookState } from '../utils/types';
import { Trade, TradeAggression } from '../market/tradeTape';
import { FlowMetrics, FlowRegime } from '../market/flowMetrics';
import { CapitalProtectionDecision } from '../risk/capitalProtection';
import { RegimePolicy, RegimeSizePolicy } from '../analytics/regimePolicy';

/**
 * Regime policy context for a specific strategy
 */
export interface StrategyRegimePolicyContext {
    /** Current regime (from flow metrics) */
    currentRegime: FlowRegime;
    /** Whether the current regime is disabled globally */
    isRegimeDisabledGlobal: boolean;
    /** Whether the current regime is disabled for this strategy */
    isRegimeDisabledStrategy: boolean;
    /** Combined: whether regime is disabled (global OR strategy) */
    isRegimeDisabled: boolean;
    /** Size multiplier from regime policy (for this strategy + regime) */
    regimeSizeMultiplier: number;
    /** Full regime policy (for advanced strategies that want to inspect) */
    policy: RegimePolicy | null;
    /** Size policy details for current regime */
    currentRegimeSizePolicy: RegimeSizePolicy | null;
}

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
    /** Capital protection governance decision (if capital protection is enabled) */
    governance?: CapitalProtectionDecision | undefined;
    /** Global size multiplier from governance (1.0 = no reduction) */
    globalSizeMultiplier?: number | undefined;
    /** Global cooldown in ms from governance (0 = no cooldown) */
    globalCooldownMs?: number | undefined;
    /** Regime policy context for this strategy (if regime policy is enabled) */
    regimePolicy?: StrategyRegimePolicyContext | undefined;
}

import { TradingPair } from '../config';

export interface Strategy {
    name: string;
    tick(ctx: StrategyContext): Promise<void>;
    shutdown?(): Promise<void>;
    /** Update the trading pair (called by TradingRuntime on pair switch). */
    setPair?(pair: TradingPair): void;
}
