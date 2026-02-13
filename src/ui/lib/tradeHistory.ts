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

/**
 * Fallback realized PnL estimator when per-trade pnl is not populated.
 * Uses FIFO lot matching per pair and realizes PnL on SELL fills.
 */
export function computeFallbackRealizedPnl(trades: Trade[], todayTimestamp: number): RealizedPnl {
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

        // SELL: realize PnL against FIFO inventory only.
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

const TRADES_FILE = 'trade_history.json';

/**
 * Read-only trade history service for the web API.
 * The actual recording happens in the backend offerExecutor.
 */
class WebTradeHistoryService {
    private cachedFilePath: string | null = null;
    private cachedMtimeMs: number | null = null;
    private cachedTrades: Trade[] = [];

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
                const stat = fs.statSync(filePath);
                if (
                    this.cachedFilePath === filePath
                    && this.cachedMtimeMs != null
                    && stat.mtimeMs === this.cachedMtimeMs
                ) {
                    return this.cachedTrades;
                }

                const data = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    const trades = parsed.map((raw) => ({
                        ...raw,
                        source: raw?.source === 'manual' ? 'manual' : 'bot',
                    }));
                    this.cachedFilePath = filePath;
                    this.cachedMtimeMs = stat.mtimeMs;
                    this.cachedTrades = trades;
                    return trades;
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

        let totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);
        let todayPnl = todayTrades.reduce((sum, t) => sum + t.pnl, 0);
        if (completedTrades.length === 0) {
            const fallback = computeFallbackRealizedPnl(trades, todayTimestamp);
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
            this.cachedFilePath = filePath;
            this.cachedMtimeMs = null;
            this.cachedTrades = [];
        } catch (err) {
            console.error('Failed to clear trade history:', err);
        }
    }
}

export const tradeHistory = new WebTradeHistoryService();
