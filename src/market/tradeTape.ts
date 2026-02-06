/**
 * Trade Tape Module
 * 
 * Maintains an in-memory ring buffer of executed trades for the active trading pair.
 * Provides computed helpers for strategies and UI: getRecent, getAggression, getVWAP.
 */

import { TradingPair } from '../config';
import { logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TradeSide = 'buy' | 'sell';

export interface Trade {
    /** Unique identifier (txHash:index for uniqueness across partial fills) */
    id: string;
    /** Unix timestamp in milliseconds */
    ts: number;
    /** Trading pair key, e.g., "XRP/RLUSD" */
    pairKey: string;
    /** Execution price (quote/base) */
    price: number;
    /** Size in base currency */
    sizeBase: number;
    /** Size in quote currency */
    sizeQuote: number;
    /** Trade direction from taker's perspective */
    side: TradeSide;
    /** XRPL transaction hash */
    txHash: string;
    /** Ledger index where trade was validated */
    ledgerIndex: number;
}

export interface TradeAggression {
    buyVolumeBase: number;
    sellVolumeBase: number;
    buyCount: number;
    sellCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum trades per pair in the ring buffer (configurable via env) */
const MAX_TRADES = parseInt(process.env.TRADE_TAPE_MAX_SIZE ?? '500', 10) || 500;

/** Whether to ignore self-trades (trades where taker === maker) */
const IGNORE_SELF_TRADES = process.env.TRADE_TAPE_IGNORE_SELF !== 'false';

// ─────────────────────────────────────────────────────────────────────────────
// TradeTape Class
// ─────────────────────────────────────────────────────────────────────────────

export class TradeTape {
    /** Ring buffer storing trades sorted by ts ascending */
    private trades: Trade[] = [];
    /** Set for O(1) deduplication by trade id */
    private seenIds: Set<string> = new Set();
    /** Current trading pair key */
    private pairKey: string;
    /**
     * Per-tick cache for getRecent() results.
     * Key: `${windowMs}`, Value: { result, epoch (trades.length at cache time), latestTs }.
     * Invalidated automatically when trades are added (length or latestTs change).
     */
    private recentCache: Map<number, { result: Trade[]; epoch: number; latestTs: number }> = new Map();

    constructor(pair: TradingPair) {
        this.pairKey = `${pair.baseCurrency}/${pair.quoteCurrency}`;
        logger.debug({ pairKey: this.pairKey, maxTrades: MAX_TRADES }, 'TradeTape initialized');
    }

    /**
     * Get the current pair key.
     */
    getPairKey(): string {
        return this.pairKey;
    }

    /**
     * Update the active trading pair. Clears the buffer if pair changes.
     */
    setPair(pair: TradingPair): void {
        const newKey = `${pair.baseCurrency}/${pair.quoteCurrency}`;
        if (newKey !== this.pairKey) {
            logger.info({ oldPair: this.pairKey, newPair: newKey }, 'TradeTape pair changed, clearing buffer');
            this.pairKey = newKey;
            this.clear();
        }
    }

    /**
     * Add a trade to the tape. Deduplicates by id and maintains ring buffer size.
     */
    add(trade: Trade): boolean {
        // Filter by pair
        if (trade.pairKey !== this.pairKey) {
            return false;
        }

        // Dedupe
        if (this.seenIds.has(trade.id)) {
            return false;
        }

        // Validate trade data
        if (!this.isValidTrade(trade)) {
            logger.warn({ trade }, 'TradeTape: invalid trade data, skipping');
            return false;
        }

        // Add to buffer maintaining sorted order by ts
        this.insertSorted(trade);
        this.seenIds.add(trade.id);

        // Enforce ring buffer max size
        while (this.trades.length > MAX_TRADES) {
            const removed = this.trades.shift();
            if (removed) {
                this.seenIds.delete(removed.id);
            }
        }

        logger.debug({ id: trade.id, price: trade.price, side: trade.side }, 'TradeTape: trade added');
        return true;
    }

    /**
     * Get recent trades within a time window.
     * Results are cached within a tick — calling with the same windowMs
     * returns the same array until a new trade is added.
     * @param windowMs - Time window in milliseconds (default: 60000 = 1 minute)
     * @returns Trades within the window, sorted by ts ascending
     */
    getRecent(windowMs = 60_000): Trade[] {
        const epoch = this.trades.length;
        const latestTs = epoch > 0 ? this.trades[epoch - 1]!.ts : 0;

        const cached = this.recentCache.get(windowMs);
        if (cached && cached.epoch === epoch && cached.latestTs === latestTs) {
            return cached.result;
        }

        const cutoff = Date.now() - windowMs;

        // Binary search for the first trade >= cutoff (trades are sorted by ts asc)
        let lo = 0;
        let hi = epoch;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.trades[mid]!.ts < cutoff) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        const result = lo < epoch ? this.trades.slice(lo) : [];
        this.recentCache.set(windowMs, { result, epoch, latestTs });
        return result;
    }

    /**
     * Get all trades in the buffer.
     */
    getAll(): Trade[] {
        return [...this.trades];
    }

    /**
     * Get the most recent trade without copying the entire buffer.
     */
    getLast(): Trade | null {
        return this.trades.length > 0 ? this.trades[this.trades.length - 1]! : null;
    }

    /**
     * Get trade aggression stats (buy vs sell volume/count) within a time window.
     * @param windowMs - Time window in milliseconds (default: 10000 = 10 seconds)
     */
    getAggression(windowMs = 10_000): TradeAggression {
        const recent = this.getRecent(windowMs);
        const result: TradeAggression = {
            buyVolumeBase: 0,
            sellVolumeBase: 0,
            buyCount: 0,
            sellCount: 0,
        };

        for (const trade of recent) {
            if (trade.side === 'buy') {
                result.buyVolumeBase += trade.sizeBase;
                result.buyCount++;
            } else {
                result.sellVolumeBase += trade.sizeBase;
                result.sellCount++;
            }
        }

        return result;
    }

    /**
     * Calculate Volume-Weighted Average Price (VWAP) within a time window.
     * @param windowMs - Time window in milliseconds (default: 60000 = 1 minute)
     * @returns VWAP or null if no trades in window
     */
    getVWAP(windowMs = 60_000): number | null {
        const recent = this.getRecent(windowMs);
        if (recent.length === 0) return null;

        let totalValue = 0;
        let totalVolume = 0;

        for (const trade of recent) {
            totalValue += trade.price * trade.sizeBase;
            totalVolume += trade.sizeBase;
        }

        if (totalVolume === 0) return null;
        return totalValue / totalVolume;
    }

    /**
     * Get the number of trades in the buffer.
     */
    size(): number {
        return this.trades.length;
    }

    /**
     * Clear all trades from the buffer.
     */
    clear(): void {
        this.trades = [];
        this.seenIds.clear();
        this.recentCache.clear();
        logger.debug({ pairKey: this.pairKey }, 'TradeTape cleared');
    }

    /**
     * Check if self-trades should be ignored (for filtering in service layer).
     */
    static shouldIgnoreSelfTrades(): boolean {
        return IGNORE_SELF_TRADES;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private isValidTrade(trade: Trade): boolean {
        return (
            typeof trade.id === 'string' && trade.id.length > 0 &&
            typeof trade.ts === 'number' && trade.ts > 0 &&
            typeof trade.pairKey === 'string' && trade.pairKey.length > 0 &&
            typeof trade.price === 'number' && trade.price > 0 &&
            typeof trade.sizeBase === 'number' && trade.sizeBase > 0 &&
            typeof trade.sizeQuote === 'number' && trade.sizeQuote > 0 &&
            (trade.side === 'buy' || trade.side === 'sell') &&
            typeof trade.txHash === 'string' && trade.txHash.length > 0 &&
            typeof trade.ledgerIndex === 'number' && trade.ledgerIndex > 0
        );
    }

    /**
     * Insert trade maintaining sorted order by ts (ascending).
     * Uses binary search for efficiency.
     */
    private insertSorted(trade: Trade): void {
        // Fast path: append if newest
        if (this.trades.length === 0 || trade.ts >= this.trades[this.trades.length - 1]!.ts) {
            this.trades.push(trade);
            return;
        }

        // Binary search for insertion point
        let left = 0;
        let right = this.trades.length;
        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (this.trades[mid]!.ts < trade.ts) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        this.trades.splice(left, 0, trade);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Export (for shared state across API routes)
// ─────────────────────────────────────────────────────────────────────────────

let globalTradeTape: TradeTape | null = null;

/**
 * Get or create the global TradeTape instance.
 * Used by TradingRuntime and API routes.
 */
export function getGlobalTradeTape(): TradeTape | null {
    return globalTradeTape;
}

/**
 * Set the global TradeTape instance (called by TradingRuntime on start).
 */
export function setGlobalTradeTape(tape: TradeTape | null): void {
    globalTradeTape = tape;
}
