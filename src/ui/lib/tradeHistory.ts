import fs from 'fs';
import path from 'path';
import { classifyPnl, warnOnPoorClassifiability, type ClassifiabilityReport } from '../../analytics/metricUtils';
import { resolveEffectivePnl } from '../../analytics/resolveEffectivePnl';

export type TradeAckStatus = 'accepted' | 'queued' | 'rejected' | 'unknown';
export type TradeOutcome = 'filled' | 'partial' | 'rejected' | 'abandoned' | 'timeout' | 'skipped';
export type TradePriceConvention = 'quote_per_base' | 'base_per_quote';
export type TradeBaselineSource =
    | 'orderbook_snapshot'
    | 'fair_value'
    | 'intent_fallback'
    | 'market_data_missing'
    | 'invalid'
    | 'missing';
export type TradeExpectedRule =
    | 'BUY->best_ask'
    | 'SELL->best_bid'
    | 'BUY->mid'
    | 'SELL->mid'
    | 'BUY->intent_price'
    | 'SELL->intent_price'
    | 'BUY->fallback_intent'
    | 'SELL->fallback_intent'
    | 'UNKNOWN';
export type TradeMarkoutMissingReason =
    | 'price_source_down'
    | 'timeout'
    | 'no_liquidity'
    | 'trade_not_filled'
    | 'tx_unvalidated'
    | 'unknown';

export interface TradeSubmitResult {
    engine_result: string | null;
    engine_result_code: number | null;
    engine_result_message: string | null;
}

export type TradeIntentAmount = string | Record<string, unknown>;

export interface TradeOfferCreateIntent {
    flags: number;
    flagsDecoded: string[];
    takerGets: TradeIntentAmount | null;
    takerPays: TradeIntentAmount | null;
    feeDrops: string | null;
    sequence: number | null;
    lastLedgerSequence: number | null;
}

export interface TradeDepthCheckSnapshot {
    side: 'BUY' | 'SELL';
    intended_price: number | null;
    required_base: number | null;
    min_required_base: number | null;
    fillable_base: number | null;
    has_depth: boolean | null;
    min_fill_ratio: number | null;
    depth_check_levels: number | null;
    order_type: 'IOC' | 'FOK' | null;
    snapshot_age_ms?: number | null;
    ledger_index?: number | null;
    fetched_at?: number | null;
    ledger_index_mode?: 'validated' | 'current' | null;
    request_taker_gets_currency?: string | null;
    request_taker_pays_currency?: string | null;
    error?: string | null;
}

export interface TradeDepthRepriceSnapshot {
    enabled: boolean;
    intended_price: number | null;
    repriced_price: number | null;
    required_reprice_bps: number | null;
    min_required_base: number | null;
    fillable_base_at_intended: number | null;
    fillable_base_at_repriced: number | null;
    decision: 'reprice' | 'skip_too_far' | 'skipped_no_candidate' | 'not_needed' | 'applied' | 'skipped_over_budget' | null;
    max_reprice_bps: number | null;
}

export interface TradeFillSnapshot {
    fill_ts_ms: number | null;
    filled_base: number | null;
    filled_quote: number | null;
    avg_price: number | null;
    fee: number | null;
    partial: boolean;
    transaction_result: string | null;
}

export interface TradeMarkoutRecord {
    horizon_s: number;
    due_ts_ms: number;
    mark_ts_ms: number | null;
    mark_price: number | null;
    markout_bps: number | null;
    source: string | null;
    status: 'recorded' | 'missing';
    missing_reason: TradeMarkoutMissingReason | null;
    attempts: number;
    last_error: string | null;
}

export interface TradeRetryAttemptSnapshot {
    attempt_n: number;
    slippage_bps: number | null;
    limit_price: number | null;
    fillable_base: number | null;
    snapshot_age_ms: number | null;
    engine_result: string | null;
    classified_outcome: string | null;
}

export interface TradeTrace {
    trade_id: string;
    decision_ts_ms: number | null;
    baseline_ts_ms: number | null;
    baseline_best_bid: number | null;
    baseline_best_ask: number | null;
    baseline_mid: number | null;
    baseline_spread_bps: number | null;
    baseline_source: TradeBaselineSource | null;
    expected_price: number | null;
    expected_rule: TradeExpectedRule | null;
    price_convention: TradePriceConvention | null;
    baseline_book_age_ms: number | null;
    submit_ts_ms: number | null;
    submit_response_ts_ms: number | null;
    ack_ts_ms: number | null;
    validated_ts_ms: number | null;
    validated_ledger_index: number | null;
    validated_ledger_time: number | null;
    tx_hash: string | null;
    tx_type: string | null;
    node_endpoint: string | null;
    fee_drops: string | null;
    sequence: number | null;
    offer_create: TradeOfferCreateIntent | null;
    depth_check: TradeDepthCheckSnapshot | null;
    depth_reprice: TradeDepthRepriceSnapshot | null;
    submit_result: TradeSubmitResult | null;
    ack_status: TradeAckStatus;
    outcome: TradeOutcome;
    outcome_reason: string | null;
    retry_attempts: TradeRetryAttemptSnapshot[];
    fill_snapshot: TradeFillSnapshot | null;
    markouts: TradeMarkoutRecord[];
}

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
    trace?: TradeTrace;
}

export interface TradeStats {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    todayPnl: number;
    /** FIFO round-trip realized PnL using actual fill prices (entry→exit). */
    roundTripPnl: number;
    /** FIFO round-trip realized PnL for today only. */
    roundTripPnlToday: number;
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

/** Actual fill price from trace data, falling back to submitted price. */
function effectiveFillPrice(trade: Trade): number {
    return trade.trace?.fill_snapshot?.avg_price ?? trade.price;
}

// resolveEffectivePnl is imported from the shared analytics module above.
// Re-export for backward compatibility with tests or other UI-side consumers.
export { resolveEffectivePnl } from '../../analytics/resolveEffectivePnl';

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
        // Use actual fill price (from trace data) instead of submitted intent price.
        const fillPrice = effectiveFillPrice(trade);
        const grossQuote = fillPrice * qty;
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
            const proceeds = (fillPrice * matchQty) - feePart;
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

        // Fix A: Include FILLED and PARTIAL executions (not just FILLED).
        // Exclude REJECTED/PENDING — those are non-executions.
        const executed = trades.filter(
            (t) => t.status === 'FILLED' || t.status === 'PARTIAL',
        );

        // Resolve effective PnL for each executed trade.
        // When trade.pnl is zero/missing (OfferExecutor emits pnl:0),
        // compute a fallback from trace/fill data.
        const withPnl = executed.map((t) => ({
            trade: t,
            effectivePnl: resolveEffectivePnl(t),
        }));

        // Epsilon-aware classification (Fix D)
        const wins: typeof withPnl = [];
        const losses: typeof withPnl = [];
        let breakeven = 0;
        let unclassifiable = 0;

        for (const entry of withPnl) {
            if (entry.effectivePnl === null) {
                unclassifiable++;
                continue;
            }
            const cls = classifyPnl(entry.effectivePnl);
            if (cls === 'win') wins.push(entry);
            else if (cls === 'loss') losses.push(entry);
            else breakeven++;
        }

        const classifiable = wins.length + losses.length;

        // Diagnostics (Fix E)
        if (executed.length > 0) {
            const report: ClassifiabilityReport = {
                total: executed.length,
                classifiable,
                breakeven,
                unclassifiableReasons: {
                    missingMidPrice: 0,
                    zeroFillSize: 0,
                    missingFeeConversion: 0,
                    breakeven,
                    nonFillEvent: 0,
                },
                ratio: executed.length > 0 ? classifiable / executed.length : 0,
            };
            warnOnPoorClassifiability('webTradeHistory.getStats', report);
        }

        // PnL totals — use effective PnL when available
        const todayExecuted = withPnl.filter((e) => e.trade.timestamp >= todayTimestamp);
        const pnlSum = (items: typeof withPnl) =>
            items.reduce((sum, e) => sum + (e.effectivePnl ?? 0), 0);

        let totalPnl = pnlSum(withPnl);
        let todayPnl = pnlSum(todayExecuted);

        // If no trade has a non-zero effective PnL, use the lot-based fallback
        if (classifiable === 0 && breakeven === 0 && unclassifiable === executed.length) {
            const fallback = computeFallbackRealizedPnl(trades, todayTimestamp);
            totalPnl = fallback.total;
            todayPnl = fallback.today;
        }

        // Always compute FIFO round-trip PnL using actual fill prices.
        // This gives true position-based realized P&L (entry→exit).
        const roundTrip = computeFallbackRealizedPnl(trades, todayTimestamp);

        const winPnls = wins.map((w) => w.effectivePnl!);
        const lossPnls = losses.map((l) => l.effectivePnl!);

        const avgWin = winPnls.length > 0
            ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length
            : 0;
        const avgLoss = lossPnls.length > 0
            ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length
            : 0;

        const largestWin = winPnls.length > 0 ? Math.max(...winPnls) : 0;
        const largestLoss = lossPnls.length > 0 ? Math.min(...lossPnls) : 0;

        return {
            totalTrades: trades.length,
            winningTrades: wins.length,
            losingTrades: losses.length,
            winRate: classifiable > 0
                ? (wins.length / classifiable) * 100
                : 0,
            totalPnl,
            todayPnl,
            roundTripPnl: roundTrip.total,
            roundTripPnlToday: roundTrip.today,
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
