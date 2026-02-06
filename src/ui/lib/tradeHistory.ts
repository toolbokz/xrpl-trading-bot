import fs from 'fs';
import path from 'path';

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

const TRADES_FILE = 'trade_history.json';

/**
 * Read-only trade history service for the web API.
 * The actual recording happens in the backend offerExecutor.
 */
class WebTradeHistoryService {
    private getFilePath(): string {
        // Try multiple locations
        const locations = [
            path.resolve(process.cwd(), TRADES_FILE),
            path.resolve(process.cwd(), '..', TRADES_FILE),
            path.resolve(__dirname, '..', '..', TRADES_FILE),
        ];

        for (const loc of locations) {
            if (fs.existsSync(loc)) {
                return loc;
            }
        }
        return locations[0] ?? path.resolve(process.cwd(), TRADES_FILE); // Default to first location
    }

    private loadTrades(): Trade[] {
        try {
            const filePath = this.getFilePath();
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    return parsed;
                }
            }
        } catch (err) {
            console.error('Failed to load trade history:', err);
        }
        return [];
    }

    getRecentTrades(limit = 50): Trade[] {
        const trades = this.loadTrades();
        return trades.slice(-limit).reverse();
    }

    getTradesByPair(pair: string, limit = 50): Trade[] {
        const trades = this.loadTrades();
        return trades
            .filter(t => t.pair === pair)
            .slice(-limit)
            .reverse();
    }

    getStats(): TradeStats {
        const trades = this.loadTrades();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayTimestamp = todayStart.getTime();

        const completedTrades = trades.filter(t => t.status === 'FILLED' && t.pnl !== 0);
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
            totalTrades: trades.length,
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
        try {
            const filePath = this.getFilePath();
            fs.writeFileSync(filePath, '[]', 'utf8');
        } catch (err) {
            console.error('Failed to clear trade history:', err);
        }
    }
}

export const tradeHistory = new WebTradeHistoryService();
