import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface Trade {
    id: string;
    timestamp: number;
    pair: string;
    side: 'BUY' | 'SELL';
    price: number;
    amount: number;
    filled: number;
    fee: number;
    pnl: number;
    entryPrice?: number;
    exitPrice?: number;
    hash?: string;
    paper: boolean;
    status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'PENDING';
    /** Slippage from expected price in basis points (negative = better execution) */
    slippageBps?: number;
    /** Origin of fill ingestion path. */
    source?: 'bot' | 'manual';
}

export interface TradeStats {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    todayPnl: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
}

interface RealizedPnl {
    total: number;
    today: number;
}

interface PositionLot {
    qty: number;
    unitCost: number;
}

function executedQty(trade: Trade): number {
    const qty = trade.filled > 0 ? trade.filled : trade.amount;
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function computeFallbackRealizedPnl(trades: Trade[], todayTimestamp: number): RealizedPnl {
    const fills = trades
        .filter((t) => (t.status === 'FILLED' || t.status === 'PARTIAL') && executedQty(t) > 0)
        .sort((a, b) => a.timestamp - b.timestamp);

    const lotsByPair = new Map<string, PositionLot[]>();
    let total = 0;
    let today = 0;

    for (const trade of fills) {
        const qty = executedQty(trade);
        const grossQuote = trade.price * qty;
        const fee = Number.isFinite(trade.fee) && trade.fee > 0 ? trade.fee : 0;
        const pairLots = lotsByPair.get(trade.pair) ?? [];

        if (trade.side === 'BUY') {
            pairLots.push({ qty, unitCost: (grossQuote + fee) / qty });
            lotsByPair.set(trade.pair, pairLots);
            continue;
        }

        let remaining = qty;
        let realized = 0;
        while (remaining > 1e-12 && pairLots.length > 0) {
            const lot = pairLots[0]!;
            const matchQty = Math.min(remaining, lot.qty);
            const feePart = fee * (matchQty / qty);
            const proceeds = (trade.price * matchQty) - feePart;
            const cost = lot.unitCost * matchQty;
            realized += (proceeds - cost);

            lot.qty -= matchQty;
            remaining -= matchQty;
            if (lot.qty <= 1e-12) pairLots.shift();
        }

        lotsByPair.set(trade.pair, pairLots);
        total += realized;
        if (trade.timestamp >= todayTimestamp) {
            today += realized;
        }
    }

    return { total, today };
}

const MAX_TRADES_IN_MEMORY = 1000;
const TRADES_FILE = 'trade_history.json';

class TradeHistoryService {
    private trades: Trade[] = [];
    private filePath: string;
    private initialized = false;

    constructor() {
        this.filePath = path.resolve(process.cwd(), TRADES_FILE);
    }

    private init(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.loadFromDisk();
    }

    private loadFromDisk(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    this.trades = parsed
                        .slice(-MAX_TRADES_IN_MEMORY)
                        .map((raw) => ({
                            ...raw,
                            source: raw?.source === 'manual' ? 'manual' : 'bot',
                        }));
                    logger.info({ count: this.trades.length }, 'Loaded trade history from disk');
                }
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to load trade history from disk, starting fresh');
            this.trades = [];
        }
    }

    private saveToDisk(): void {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.trades, null, 2), 'utf8');
        } catch (err) {
            logger.error({ err }, 'Failed to save trade history to disk');
        }
    }

    recordTrade(trade: Omit<Trade, 'id' | 'timestamp'>): Trade {
        this.init();
        const fullTrade: Trade = {
            ...trade,
            source: trade.source === 'manual' ? 'manual' : 'bot',
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            timestamp: Date.now(),
        };

        this.trades.push(fullTrade);

        // Keep only recent trades in memory
        if (this.trades.length > MAX_TRADES_IN_MEMORY) {
            this.trades = this.trades.slice(-MAX_TRADES_IN_MEMORY);
        }

        // Persist to disk
        this.saveToDisk();

        logger.info({
            id: fullTrade.id,
            pair: fullTrade.pair,
            side: fullTrade.side,
            price: fullTrade.price,
            amount: fullTrade.amount,
            pnl: fullTrade.pnl,
            paper: fullTrade.paper,
            source: fullTrade.source,
        }, 'Trade recorded');

        return fullTrade;
    }

    getRecentTrades(limit = 50): Trade[] {
        this.init();
        return this.trades.slice(-limit).reverse();
    }

    getAllTrades(): Trade[] {
        this.init();
        return [...this.trades];
    }

    hasTradeHash(hash: string): boolean {
        this.init();
        if (!hash) return false;
        return this.trades.some((t) => t.hash === hash);
    }

    getTradesByPair(pair: string, limit = 50): Trade[] {
        this.init();
        return this.trades
            .filter(t => t.pair === pair)
            .slice(-limit)
            .reverse();
    }

    getStats(): TradeStats {
        this.init();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayTimestamp = todayStart.getTime();

        const completedTrades = this.trades.filter(t => t.status === 'FILLED' && t.pnl !== 0);
        const winningTrades = completedTrades.filter(t => t.pnl > 0);
        const losingTrades = completedTrades.filter(t => t.pnl < 0);
        const todayTrades = completedTrades.filter(t => t.timestamp >= todayTimestamp);

        let totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);
        let todayPnl = todayTrades.reduce((sum, t) => sum + t.pnl, 0);
        if (completedTrades.length === 0) {
            const fallback = computeFallbackRealizedPnl(this.trades, todayTimestamp);
            totalPnl = fallback.total;
            todayPnl = fallback.today;
        }

        const avgWin = winningTrades.length > 0
            ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length
            : 0;
        const avgLoss = losingTrades.length > 0
            ? losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length
            : 0;

        const largestWin = winningTrades.length > 0
            ? Math.max(...winningTrades.map(t => t.pnl))
            : 0;
        const largestLoss = losingTrades.length > 0
            ? Math.min(...losingTrades.map(t => t.pnl))
            : 0;

        return {
            totalTrades: this.trades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: completedTrades.length > 0
                ? (winningTrades.length / completedTrades.length) * 100
                : 0,
            totalPnl,
            todayPnl,
            avgWin,
            avgLoss,
            largestWin,
            largestLoss,
        };
    }

    clearHistory(): void {
        this.trades = [];
        this.saveToDisk();
        logger.info('Trade history cleared');
    }
}

// Singleton instance
export const tradeHistory = new TradeHistoryService();
