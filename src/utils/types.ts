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
    /**
     * Validated ledger index the latest book snapshot came from.
     * Null when upstream does not provide ledger index metadata.
     */
    sourceLedgerIndex?: number | null;
}

/**
 * Result of parsing partial fill from transaction metadata.
 */
export interface PartialFillResult {
    /** Amount of TakerGets actually delivered */
    takerGotAmount: number;
    /** Amount of TakerPays actually delivered */
    takerPaidAmount: number;
    /** Executed base amount (XRP for XRP/* pairs). */
    baseFilled: number;
    /** Executed quote amount (RLUSD for XRP/RLUSD). */
    quoteFilled: number;
    /** Percentage of the original order filled (0-1) */
    fillRatio: number;
    /** Effective quote-per-base execution price. */
    effectivePrice: number;
    /** Alias of effectivePrice for explicit unit semantics. */
    priceQuotePerBase: number;
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
