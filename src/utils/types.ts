import { Amount, RippledError } from 'xrpl';

export interface OrderBookPair {
    baseCurrency: string;
    quoteCurrency: string;
    issuer: string;
}

export interface BookOffer {
    price: number;
    quantity: number;
    quality: number;
    isBuy: boolean;
    raw: unknown;
}

export interface OrderBookState {
    bids: BookOffer[];
    asks: BookOffer[];
    spread: number;
    lastUpdated: number;
}

/**
 * Result of parsing partial fill from transaction metadata.
 */
export interface PartialFillResult {
    /** Amount of TakerGets actually delivered */
    takerGotAmount: number;
    /** Amount of TakerPays actually delivered */
    takerPaidAmount: number;
    /** Percentage of the original order filled (0-1) */
    fillRatio: number;
    /** Effective price achieved (takerPaidAmount / takerGotAmount) */
    effectivePrice: number;
    /** Slippage from expected price in basis points (can be negative for better execution) */
    slippageBps: number;
}

export interface ExecutionResult {
    hash?: string | undefined;
    accepted: boolean;
    reason?: string | undefined;
    txJSON?: Record<string, unknown> | undefined;
    /** Partial fill details when transaction succeeded */
    fillResult?: PartialFillResult | undefined;
}

export interface XRPLError extends RippledError {
    forwarded?: boolean;
}

export interface AMMInfo {
    tradingFee: number;
    poolContributions: Amount[];
    price?: number;
}
