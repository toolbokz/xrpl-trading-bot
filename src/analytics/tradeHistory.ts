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
                    this.trades = parsed.slice(-MAX_TRADES_IN_MEMORY);
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

        const totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);
        const todayPnl = todayTrades.reduce((sum, t) => sum + t.pnl, 0);

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
