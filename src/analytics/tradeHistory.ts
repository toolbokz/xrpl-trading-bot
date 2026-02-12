import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { canonicalizePairKey } from '../xrpl/currency';

export interface Trade {
    id: string;
    timestamp: number;
    pair: string;
    side: 'BUY' | 'SELL';
    /** Quote-per-base execution price. */
    price: number;
    /** Base amount requested. */
    amount: number;
    /** Base amount filled (legacy field kept for compatibility). */
    filled: number;
    /** Explicit base amount requested (same unit as amount). */
    amountBase?: number;
    /** Explicit base amount filled (same unit as filled). */
    filledBase?: number;
    /** Explicit quote amount filled. */
    filledQuote?: number;
    /** Explicit quote-per-base execution price. */
    priceQuotePerBase?: number;
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

type TradeInput = Omit<Trade, 'id' | 'timestamp'>;

function toFinitePositive(value: unknown): number {
    if (typeof value !== 'number') return 0;
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value;
}

function statusPriority(status: Trade['status']): number {
    switch (status) {
        case 'FILLED': return 4;
        case 'PARTIAL': return 3;
        case 'REJECTED': return 2;
        default: return 1;
    }
}

export function shouldReplaceByHash(existing: Trade, incoming: TradeInput): boolean {
    const existingPriority = statusPriority(existing.status);
    const incomingPriority = statusPriority(incoming.status);
    if (incomingPriority > existingPriority) return true;
    if (incomingPriority < existingPriority) return false;

    const existingBase = toFinitePositive(existing.filledBase ?? existing.filled);
    const incomingBase = toFinitePositive(incoming.filledBase ?? incoming.filled);
    if (existingBase === 0 && incomingBase > 0) return true;

    const existingQuote = toFinitePositive(existing.filledQuote);
    const incomingQuote = toFinitePositive(incoming.filledQuote);
    if (existingQuote === 0 && incomingQuote > 0) return true;

    const existingAmount = toFinitePositive(existing.amountBase ?? existing.amount);
    if (existingAmount > 0 && existingBase > existingAmount * 1.000001 && incomingBase <= existingAmount * 1.000001) {
        return true;
    }

    return false;
}

export function dedupeTradesByHash(trades: Trade[]): Trade[] {
    const deduped: Trade[] = [];
    for (const trade of trades) {
        if (!trade.hash) {
            deduped.push(trade);
            continue;
        }
        const idx = deduped.findIndex((t) => t.hash === trade.hash);
        if (idx === -1) {
            deduped.push(trade);
        } else if (shouldReplaceByHash(deduped[idx]!, trade)) {
            deduped[idx] = { ...deduped[idx]!, ...trade };
        }
    }
    return deduped;
}

export function normalizeTradeUnits(trade: TradeInput): TradeInput {
    const pair = canonicalizePairKey(trade.pair);
    const amountBase = toFinitePositive(trade.amountBase ?? trade.amount);
    const priceQuotePerBase = toFinitePositive(trade.priceQuotePerBase ?? trade.price);
    let filledBase = toFinitePositive(trade.filledBase ?? trade.filled);
    let filledQuote = toFinitePositive(trade.filledQuote);

    // Legacy SELL records sometimes stored quote in `filled` while `amount` is base.
    if (filledQuote === 0 && trade.side === 'SELL' && amountBase > 0 && filledBase > amountBase * 1.000001) {
        filledQuote = filledBase;
        if (priceQuotePerBase > 0) {
            filledBase = filledQuote / priceQuotePerBase;
        }
    }

    if (filledQuote === 0 && priceQuotePerBase > 0 && filledBase > 0) {
        filledQuote = filledBase * priceQuotePerBase;
    }

    if (amountBase > 0 && filledBase > amountBase * 1.000001) {
        filledBase = amountBase;
    }

    const normalized: TradeInput = {
        ...trade,
        pair,
        price: priceQuotePerBase > 0 ? priceQuotePerBase : trade.price,
        amount: amountBase,
        amountBase,
        filled: filledBase,
        filledBase,
    };

    if (priceQuotePerBase > 0) {
        normalized.priceQuotePerBase = priceQuotePerBase;
    }
    if (filledQuote > 0) {
        normalized.filledQuote = filledQuote;
    }
    return normalized;
}

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
                    const normalized = parsed
                        .slice(-MAX_TRADES_IN_MEMORY)
                        .map((raw) => ({
                            ...normalizeTradeUnits({
                                ...raw,
                                pair: typeof raw?.pair === 'string' ? raw.pair : '',
                                side: raw?.side === 'SELL' ? 'SELL' : 'BUY',
                                price: typeof raw?.price === 'number' ? raw.price : 0,
                                amount: typeof raw?.amount === 'number' ? raw.amount : 0,
                                filled: typeof raw?.filled === 'number' ? raw.filled : 0,
                                fee: typeof raw?.fee === 'number' ? raw.fee : 0,
                                pnl: typeof raw?.pnl === 'number' ? raw.pnl : 0,
                                paper: !!raw?.paper,
                                status: raw?.status === 'FILLED' || raw?.status === 'PARTIAL' || raw?.status === 'REJECTED'
                                    ? raw.status
                                    : 'PENDING',
                                hash: typeof raw?.hash === 'string' ? raw.hash : undefined,
                                source: raw?.source === 'manual' ? 'manual' : 'bot',
                                entryPrice: typeof raw?.entryPrice === 'number' ? raw.entryPrice : undefined,
                                exitPrice: typeof raw?.exitPrice === 'number' ? raw.exitPrice : undefined,
                                slippageBps: typeof raw?.slippageBps === 'number' ? raw.slippageBps : undefined,
                                amountBase: typeof raw?.amountBase === 'number' ? raw.amountBase : undefined,
                                filledBase: typeof raw?.filledBase === 'number' ? raw.filledBase : undefined,
                                filledQuote: typeof raw?.filledQuote === 'number' ? raw.filledQuote : undefined,
                                priceQuotePerBase: typeof raw?.priceQuotePerBase === 'number' ? raw.priceQuotePerBase : undefined,
                            }),
                            id: typeof raw?.id === 'string' ? raw.id : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                            timestamp: typeof raw?.timestamp === 'number' ? raw.timestamp : Date.now(),
                            source: raw?.source === 'manual' ? 'manual' : 'bot',
                        })) as Trade[];
                    this.trades = dedupeTradesByHash(normalized);
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
        const normalized = normalizeTradeUnits(trade);
        const source = normalized.source === 'manual' ? 'manual' : 'bot';

        if (normalized.hash) {
            const existingIndex = this.trades.findIndex((t) => t.hash === normalized.hash);
            if (existingIndex !== -1) {
                const existing = this.trades[existingIndex]!;
                if (!shouldReplaceByHash(existing, normalized)) {
                    return existing;
                }
                const replacement: Trade = {
                    ...existing,
                    ...normalized,
                    source,
                };
                this.trades[existingIndex] = replacement;
                this.saveToDisk();
                return replacement;
            }
        }

        const fullTrade: Trade = {
            ...normalized,
            source,
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
        const canonical = canonicalizePairKey(pair);
        return this.trades
            .filter(t => canonicalizePairKey(t.pair) === canonical)
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
