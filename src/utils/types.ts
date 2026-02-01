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

export interface ExecutionResult {
    hash?: string;
    accepted: boolean;
    reason?: string;
    txJSON?: Record<string, unknown>;
}

export interface XRPLError extends RippledError {
    forwarded?: boolean;
}

export interface AMMInfo {
    tradingFee: number;
    poolContributions: Amount[];
    price?: number;
}
