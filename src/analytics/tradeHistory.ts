import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { canonicalizePairKey } from '../xrpl/currency';
import { classifyPnl, warnOnPoorClassifiability, type ClassifiabilityReport } from './metricUtils';
import { resolveEffectivePnl } from './resolveEffectivePnl';

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
    /** Execution lifecycle trace (submit → validate → fill → markouts). */
    trace?: TradeTrace;
}

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
    vwap?: number | null;
    worst_price?: number | null;
    limit_price?: number | null;
    has_depth: boolean | null;
    min_fill_ratio: number | null;
    depth_check_levels: number | null;
    order_type: 'IOC' | 'FOK' | null;
    side_used?: 'BUY' | 'SELL' | null;
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

export type TradeTracePatch = Partial<Omit<TradeTrace, 'trade_id'>>;

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

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
}

function toStringOrNull(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseSubmitResult(raw: unknown): TradeSubmitResult | null {
    if (!isObject(raw)) return null;
    return {
        engine_result: typeof raw.engine_result === 'string' ? raw.engine_result : null,
        engine_result_code: typeof raw.engine_result_code === 'number' && Number.isFinite(raw.engine_result_code)
            ? raw.engine_result_code
            : null,
        engine_result_message: typeof raw.engine_result_message === 'string' ? raw.engine_result_message : null,
    };
}

function parseIntentAmount(raw: unknown): TradeIntentAmount | null {
    if (typeof raw === 'string') return raw;
    if (!isObject(raw)) return null;
    const copy: Record<string, unknown> = { ...raw };
    if (typeof copy.issuer === 'string') {
        copy.issuer = '[redacted]';
    }
    return copy;
}

function parseOfferCreateIntent(raw: unknown): TradeOfferCreateIntent | null {
    if (!isObject(raw)) return null;
    const flagsDecodedRaw = Array.isArray(raw.flagsDecoded) ? raw.flagsDecoded : [];
    const flagsDecoded = Array.from(new Set(
        flagsDecodedRaw
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
    ));
    return {
        flags: typeof raw.flags === 'number' && Number.isFinite(raw.flags)
            ? Math.max(0, Math.floor(raw.flags))
            : 0,
        flagsDecoded,
        takerGets: parseIntentAmount(raw.takerGets),
        takerPays: parseIntentAmount(raw.takerPays),
        feeDrops: typeof raw.feeDrops === 'string' ? raw.feeDrops : null,
        sequence: toFiniteNumberOrNull(raw.sequence),
        lastLedgerSequence: toFiniteNumberOrNull(raw.lastLedgerSequence),
    };
}

function parseDepthCheckSnapshot(raw: unknown): TradeDepthCheckSnapshot | null {
    if (!isObject(raw)) return null;
    const side = raw.side === 'BUY' || raw.side === 'SELL' ? raw.side : null;
    if (!side) return null;
    const hasDepth = typeof raw.has_depth === 'boolean' ? raw.has_depth : null;
    const orderType = raw.order_type === 'IOC' || raw.order_type === 'FOK' ? raw.order_type : null;
    const sideUsed = raw.side_used === 'BUY' || raw.side_used === 'SELL' ? raw.side_used : null;
    const ledgerIndexMode = raw.ledger_index_mode === 'validated' || raw.ledger_index_mode === 'current'
        ? raw.ledger_index_mode
        : null;
    return {
        side,
        intended_price: toFiniteNumberOrNull(raw.intended_price),
        required_base: toFiniteNumberOrNull(raw.required_base),
        min_required_base: toFiniteNumberOrNull(raw.min_required_base),
        fillable_base: toFiniteNumberOrNull(raw.fillable_base),
        vwap: toFiniteNumberOrNull(raw.vwap),
        worst_price: toFiniteNumberOrNull(raw.worst_price),
        limit_price: toFiniteNumberOrNull(raw.limit_price),
        has_depth: hasDepth,
        min_fill_ratio: toFiniteNumberOrNull(raw.min_fill_ratio) ?? toFiniteNumberOrNull(raw.ioc_min_fill_ratio),
        depth_check_levels: toFiniteNumberOrNull(raw.depth_check_levels),
        order_type: orderType,
        side_used: sideUsed,
        snapshot_age_ms: toFiniteNumberOrNull(raw.snapshot_age_ms),
        ledger_index: toFiniteNumberOrNull(raw.ledger_index),
        fetched_at: toFiniteNumberOrNull(raw.fetched_at),
        ledger_index_mode: ledgerIndexMode,
        request_taker_gets_currency: toStringOrNull(raw.request_taker_gets_currency),
        request_taker_pays_currency: toStringOrNull(raw.request_taker_pays_currency),
        error: toStringOrNull(raw.error),
    };
}

function parseDepthRepriceSnapshot(raw: unknown): TradeDepthRepriceSnapshot | null {
    if (!isObject(raw)) return null;
    const decision = raw.decision === 'reprice'
        || raw.decision === 'skip_too_far'
        || raw.decision === 'applied'
        || raw.decision === 'skipped_over_budget'
        || raw.decision === 'skipped_no_candidate'
        || raw.decision === 'not_needed'
        ? raw.decision
        : null;
    return {
        enabled: raw.enabled === true,
        intended_price: toFiniteNumberOrNull(raw.intended_price),
        repriced_price: toFiniteNumberOrNull(raw.repriced_price),
        required_reprice_bps: toFiniteNumberOrNull(raw.required_reprice_bps),
        min_required_base: toFiniteNumberOrNull(raw.min_required_base),
        fillable_base_at_intended: toFiniteNumberOrNull(raw.fillable_base_at_intended),
        fillable_base_at_repriced: toFiniteNumberOrNull(raw.fillable_base_at_repriced),
        decision,
        max_reprice_bps: toFiniteNumberOrNull(raw.max_reprice_bps),
    };
}

function parseFillSnapshot(raw: unknown): TradeFillSnapshot | null {
    if (!isObject(raw)) return null;
    return {
        fill_ts_ms: toFiniteNumberOrNull(raw.fill_ts_ms),
        filled_base: toFiniteNumberOrNull(raw.filled_base),
        filled_quote: toFiniteNumberOrNull(raw.filled_quote),
        avg_price: toFiniteNumberOrNull(raw.avg_price),
        fee: toFiniteNumberOrNull(raw.fee),
        partial: raw.partial === true,
        transaction_result: typeof raw.transaction_result === 'string' ? raw.transaction_result : null,
    };
}

function parseMarkouts(raw: unknown): TradeMarkoutRecord[] {
    if (!Array.isArray(raw)) return [];
    const parsed: TradeMarkoutRecord[] = [];
    for (const entry of raw) {
        if (!isObject(entry)) continue;
        const horizonS = toFiniteNumberOrNull(entry.horizon_s);
        const dueTsMs = toFiniteNumberOrNull(entry.due_ts_ms);
        if (horizonS == null || dueTsMs == null) continue;
        parsed.push({
            horizon_s: horizonS,
            due_ts_ms: dueTsMs,
            mark_ts_ms: toFiniteNumberOrNull(entry.mark_ts_ms),
            mark_price: toFiniteNumberOrNull(entry.mark_price),
            markout_bps: toFiniteNumberOrNull(entry.markout_bps),
            source: typeof entry.source === 'string' ? entry.source : null,
            status: entry.status === 'recorded' ? 'recorded' : 'missing',
            missing_reason: entry.missing_reason === 'price_source_down'
                || entry.missing_reason === 'timeout'
                || entry.missing_reason === 'no_liquidity'
                || entry.missing_reason === 'trade_not_filled'
                || entry.missing_reason === 'tx_unvalidated'
                || entry.missing_reason === 'unknown'
                ? entry.missing_reason
                : null,
            attempts: typeof entry.attempts === 'number' && Number.isFinite(entry.attempts)
                ? Math.max(0, Math.floor(entry.attempts))
                : 0,
            last_error: typeof entry.last_error === 'string' ? entry.last_error : null,
        });
    }
    return parsed;
}

function parseRetryAttemptSnapshots(raw: unknown): TradeRetryAttemptSnapshot[] {
    if (!Array.isArray(raw)) return [];
    const parsed: TradeRetryAttemptSnapshot[] = [];
    for (const entry of raw) {
        if (!isObject(entry)) continue;
        const attempt = toFiniteNumberOrNull(entry.attempt_n);
        if (attempt == null) continue;
        parsed.push({
            attempt_n: Math.max(1, Math.floor(attempt)),
            slippage_bps: toFiniteNumberOrNull(entry.slippage_bps),
            limit_price: toFiniteNumberOrNull(entry.limit_price),
            fillable_base: toFiniteNumberOrNull(entry.fillable_base),
            snapshot_age_ms: toFiniteNumberOrNull(entry.snapshot_age_ms),
            engine_result: typeof entry.engine_result === 'string' ? entry.engine_result : null,
            classified_outcome: typeof entry.classified_outcome === 'string' ? entry.classified_outcome : null,
        });
    }
    parsed.sort((a, b) => a.attempt_n - b.attempt_n);
    return parsed;
}

function outcomeFromStatus(status: Trade['status']): TradeOutcome {
    if (status === 'FILLED') return 'filled';
    if (status === 'PARTIAL') return 'partial';
    if (status === 'REJECTED') return 'rejected';
    return 'abandoned';
}

interface TraceFallback {
    id: string;
    timestamp: number;
    status: Trade['status'];
    hash: string | undefined;
}

function defaultTrace(trade: TraceFallback): TradeTrace {
    return {
        trade_id: trade.id,
        decision_ts_ms: trade.timestamp,
        baseline_ts_ms: null,
        baseline_best_bid: null,
        baseline_best_ask: null,
        baseline_mid: null,
        baseline_spread_bps: null,
        baseline_source: null,
        expected_price: null,
        expected_rule: null,
        price_convention: null,
        baseline_book_age_ms: null,
        submit_ts_ms: null,
        submit_response_ts_ms: null,
        ack_ts_ms: null,
        validated_ts_ms: null,
        validated_ledger_index: null,
        validated_ledger_time: null,
        tx_hash: trade.hash ?? null,
        tx_type: null,
        node_endpoint: null,
        fee_drops: null,
        sequence: null,
        offer_create: null,
        depth_check: null,
        depth_reprice: null,
        submit_result: null,
        ack_status: 'unknown',
        outcome: outcomeFromStatus(trade.status),
        outcome_reason: null,
        retry_attempts: [],
        fill_snapshot: null,
        markouts: [],
    };
}

function parseTrace(raw: unknown, fallback: TraceFallback): TradeTrace | undefined {
    if (!isObject(raw)) return undefined;
    const submitResponseTsMs = toFiniteNumberOrNull(raw.submit_response_ts_ms);
    const ackTsMs = toFiniteNumberOrNull(raw.ack_ts_ms);
    const baselineSource = raw.baseline_source;
    const expectedRule = raw.expected_rule;
    const priceConvention = raw.price_convention;
    const parsed: TradeTrace = {
        ...defaultTrace(fallback),
        trade_id: typeof raw.trade_id === 'string' && raw.trade_id.length > 0 ? raw.trade_id : fallback.id,
        decision_ts_ms: toFiniteNumberOrNull(raw.decision_ts_ms) ?? fallback.timestamp,
        baseline_ts_ms: toFiniteNumberOrNull(raw.baseline_ts_ms),
        baseline_best_bid: toFiniteNumberOrNull(raw.baseline_best_bid),
        baseline_best_ask: toFiniteNumberOrNull(raw.baseline_best_ask),
        baseline_mid: toFiniteNumberOrNull(raw.baseline_mid),
        baseline_spread_bps: toFiniteNumberOrNull(raw.baseline_spread_bps),
        baseline_source: baselineSource === 'orderbook_snapshot'
            || baselineSource === 'fair_value'
            || baselineSource === 'intent_fallback'
            || baselineSource === 'market_data_missing'
            || baselineSource === 'invalid'
            || baselineSource === 'missing'
            ? baselineSource
            : null,
        expected_price: toFiniteNumberOrNull(raw.expected_price),
        expected_rule: expectedRule === 'BUY->best_ask'
            || expectedRule === 'SELL->best_bid'
            || expectedRule === 'BUY->mid'
            || expectedRule === 'SELL->mid'
            || expectedRule === 'BUY->intent_price'
            || expectedRule === 'SELL->intent_price'
            || expectedRule === 'BUY->fallback_intent'
            || expectedRule === 'SELL->fallback_intent'
            || expectedRule === 'UNKNOWN'
            ? expectedRule
            : null,
        price_convention: priceConvention === 'quote_per_base' || priceConvention === 'base_per_quote'
            ? priceConvention
            : null,
        baseline_book_age_ms: toFiniteNumberOrNull(raw.baseline_book_age_ms),
        submit_ts_ms: toFiniteNumberOrNull(raw.submit_ts_ms),
        submit_response_ts_ms: submitResponseTsMs,
        ack_ts_ms: ackTsMs ?? submitResponseTsMs,
        validated_ts_ms: toFiniteNumberOrNull(raw.validated_ts_ms),
        validated_ledger_index: toFiniteNumberOrNull(raw.validated_ledger_index),
        validated_ledger_time: toFiniteNumberOrNull(raw.validated_ledger_time),
        tx_hash: typeof raw.tx_hash === 'string' ? raw.tx_hash : (fallback.hash ?? null),
        tx_type: typeof raw.tx_type === 'string' && raw.tx_type.trim().length > 0 ? raw.tx_type : null,
        node_endpoint: typeof raw.node_endpoint === 'string' ? raw.node_endpoint : null,
        fee_drops: typeof raw.fee_drops === 'string' ? raw.fee_drops : null,
        sequence: toFiniteNumberOrNull(raw.sequence),
        offer_create: parseOfferCreateIntent(raw.offer_create),
        depth_check: parseDepthCheckSnapshot(raw.depth_check),
        depth_reprice: parseDepthRepriceSnapshot(raw.depth_reprice),
        submit_result: parseSubmitResult(raw.submit_result),
        ack_status: raw.ack_status === 'accepted'
            || raw.ack_status === 'queued'
            || raw.ack_status === 'rejected'
            || raw.ack_status === 'unknown'
            ? raw.ack_status
            : 'unknown',
        outcome: raw.outcome === 'filled'
            || raw.outcome === 'partial'
            || raw.outcome === 'rejected'
            || raw.outcome === 'abandoned'
            || raw.outcome === 'skipped'
            || raw.outcome === 'timeout'
            ? raw.outcome
            : outcomeFromStatus(fallback.status),
        outcome_reason: typeof raw.outcome_reason === 'string' ? raw.outcome_reason : null,
        retry_attempts: parseRetryAttemptSnapshots(raw.retry_attempts),
        fill_snapshot: parseFillSnapshot(raw.fill_snapshot),
        markouts: parseMarkouts(raw.markouts),
    };
    return parsed;
}

function mergeTrace(
    existing: TradeTrace | undefined,
    patch: TradeTracePatch,
    fallback: TraceFallback,
): TradeTrace {
    const base = existing ?? defaultTrace(fallback);
    const nextSubmitResponseTs = patch.submit_response_ts_ms !== undefined
        ? patch.submit_response_ts_ms
        : (patch.ack_ts_ms !== undefined ? patch.ack_ts_ms : base.submit_response_ts_ms);
    const nextAckTs = patch.ack_ts_ms !== undefined
        ? patch.ack_ts_ms
        : (patch.submit_response_ts_ms !== undefined ? patch.submit_response_ts_ms : base.ack_ts_ms);
    const merged: TradeTrace = {
        ...base,
        ...patch,
        trade_id: base.trade_id || fallback.id,
        tx_hash: patch.tx_hash !== undefined
            ? patch.tx_hash
            : (base.tx_hash ?? fallback.hash ?? null),
        decision_ts_ms: patch.decision_ts_ms !== undefined ? patch.decision_ts_ms : base.decision_ts_ms,
        submit_response_ts_ms: nextSubmitResponseTs ?? null,
        ack_ts_ms: nextAckTs ?? nextSubmitResponseTs ?? null,
        retry_attempts: patch.retry_attempts !== undefined
            ? [...patch.retry_attempts]
            : base.retry_attempts,
        markouts: patch.markouts !== undefined ? [...patch.markouts] : base.markouts,
    };

    if (patch.submit_result !== undefined) {
        merged.submit_result = patch.submit_result
            ? {
                ...(base.submit_result ?? {
                    engine_result: null,
                    engine_result_code: null,
                    engine_result_message: null,
                }),
                ...patch.submit_result,
            }
            : null;
    }
    if (patch.fill_snapshot !== undefined) {
        merged.fill_snapshot = patch.fill_snapshot
            ? {
                ...(base.fill_snapshot ?? {
                    fill_ts_ms: null,
                    filled_base: null,
                    filled_quote: null,
                    avg_price: null,
                    fee: null,
                    partial: false,
                    transaction_result: null,
                }),
                ...patch.fill_snapshot,
            }
            : null;
    }
    if (!Array.isArray(merged.markouts)) {
        merged.markouts = [];
    }
    if (!Array.isArray(merged.retry_attempts)) {
        merged.retry_attempts = [];
    }
    return merged;
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

// Re-export resolveEffectivePnl from the shared module so existing callers
// (tests, etc.) that import from tradeHistory continue to work.
export { resolveEffectivePnl } from './resolveEffectivePnl';

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
                        .map((raw) => {
                            const id = typeof raw?.id === 'string' ? raw.id : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                            const timestamp = typeof raw?.timestamp === 'number' ? raw.timestamp : Date.now();
                            const status = raw?.status === 'FILLED' || raw?.status === 'PARTIAL' || raw?.status === 'REJECTED'
                                ? raw.status
                                : 'PENDING';
                            const hash = typeof raw?.hash === 'string' ? raw.hash : undefined;
                            const tradeCore = normalizeTradeUnits({
                                ...raw,
                                pair: typeof raw?.pair === 'string' ? raw.pair : '',
                                side: raw?.side === 'SELL' ? 'SELL' : 'BUY',
                                price: typeof raw?.price === 'number' ? raw.price : 0,
                                amount: typeof raw?.amount === 'number' ? raw.amount : 0,
                                filled: typeof raw?.filled === 'number' ? raw.filled : 0,
                                fee: typeof raw?.fee === 'number' ? raw.fee : 0,
                                pnl: typeof raw?.pnl === 'number' ? raw.pnl : 0,
                                paper: !!raw?.paper,
                                status,
                                hash,
                                source: raw?.source === 'manual' ? 'manual' : 'bot',
                                entryPrice: typeof raw?.entryPrice === 'number' ? raw.entryPrice : undefined,
                                exitPrice: typeof raw?.exitPrice === 'number' ? raw.exitPrice : undefined,
                                slippageBps: typeof raw?.slippageBps === 'number' ? raw.slippageBps : undefined,
                                amountBase: typeof raw?.amountBase === 'number' ? raw.amountBase : undefined,
                                filledBase: typeof raw?.filledBase === 'number' ? raw.filledBase : undefined,
                                filledQuote: typeof raw?.filledQuote === 'number' ? raw.filledQuote : undefined,
                                priceQuotePerBase: typeof raw?.priceQuotePerBase === 'number' ? raw.priceQuotePerBase : undefined,
                            });

                            const parsedTrace = parseTrace(raw?.trace, {
                                id,
                                timestamp,
                                status,
                                hash,
                            });

                            return {
                                ...tradeCore,
                                id,
                                timestamp,
                                source: raw?.source === 'manual' ? 'manual' : 'bot',
                                ...(parsedTrace ? { trace: parsedTrace } : {}),
                            };
                        }) as Trade[];
                    this.trades = dedupeTradesByHash(normalized);

                    // ── Backfill PnL for trades loaded with pnl:0 ───────────
                    // Older records may have been saved before PnL persistence
                    // was implemented.  Recompute from trace data if available.
                    let backfilled = 0;
                    for (const t of this.trades) {
                        if (
                            (t.status === 'FILLED' || t.status === 'PARTIAL') &&
                            Math.abs(t.pnl) < 1e-12 &&
                            t.trace
                        ) {
                            const computedPnl = resolveEffectivePnl(t);
                            if (computedPnl !== null && Number.isFinite(computedPnl)) {
                                t.pnl = computedPnl;
                                backfilled++;
                            }
                        }
                    }
                    if (backfilled > 0) {
                        logger.info(
                            { backfilled },
                            '[tradeHistory] Backfilled PnL for trades loaded with pnl=0',
                        );
                        // Persist the backfilled values immediately
                        try {
                            fs.writeFileSync(this.filePath, JSON.stringify(this.trades, null, 2), 'utf8');
                        } catch { /* saveToDisk will retry later */ }
                    }

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

    private findTradeIndexByHash(hash: string): number {
        if (!hash) return -1;
        return this.trades.findIndex((t) => t.hash === hash);
    }

    private findTradeIndexById(tradeId: string): number {
        if (!tradeId) return -1;
        return this.trades.findIndex((t) => t.id === tradeId);
    }

    upsertTradeTrace(input: {
        hash?: string | null;
        tradeId?: string | null;
        patch: TradeTracePatch;
    }): Trade | null {
        this.init();
        const hash = typeof input.hash === 'string' ? input.hash : '';
        const tradeId = typeof input.tradeId === 'string' ? input.tradeId : '';
        let index = hash ? this.findTradeIndexByHash(hash) : -1;
        if (index === -1 && tradeId) {
            index = this.findTradeIndexById(tradeId);
        }
        if (index === -1) return null;

        const current = this.trades[index]!;
        const mergedTrace = mergeTrace(current.trace, input.patch, {
            id: current.id,
            timestamp: current.timestamp,
            status: current.status,
            hash: current.hash,
        });
        const updated: Trade = {
            ...current,
            ...(current.hash ? {} : (mergedTrace.tx_hash ? { hash: mergedTrace.tx_hash } : {})),
            trace: mergedTrace,
        };

        // ── Persist computed PnL ────────────────────────────────────────
        // OfferExecutor records pnl:0 at fill time because trace data is
        // not yet available.  Now that the trace (with fill_snapshot and
        // baseline_mid) has been merged, we can derive the real PnL and
        // write it back so downstream consumers (adaptive learner, capital
        // protection, JSON on disk) see an accurate number.
        if (
            (updated.status === 'FILLED' || updated.status === 'PARTIAL') &&
            Math.abs(updated.pnl) < 1e-12
        ) {
            const computedPnl = resolveEffectivePnl(updated);
            if (computedPnl !== null && Number.isFinite(computedPnl)) {
                updated.pnl = computedPnl;
                logger.debug(
                    { hash: updated.hash, pnl: computedPnl },
                    '[tradeHistory] Persisted computed PnL on trace upsert',
                );
            }
        }

        this.trades[index] = updated;
        this.saveToDisk();
        return updated;
    }

    appendTradeMarkout(input: {
        hash?: string | null;
        tradeId?: string | null;
        markout: TradeMarkoutRecord;
    }): Trade | null {
        this.init();
        const hash = typeof input.hash === 'string' ? input.hash : '';
        const tradeId = typeof input.tradeId === 'string' ? input.tradeId : '';
        let index = hash ? this.findTradeIndexByHash(hash) : -1;
        if (index === -1 && tradeId) {
            index = this.findTradeIndexById(tradeId);
        }
        if (index === -1) return null;

        const current = this.trades[index]!;
        const trace = mergeTrace(current.trace, {}, {
            id: current.id,
            timestamp: current.timestamp,
            status: current.status,
            hash: current.hash,
        });

        const markouts = [...trace.markouts];
        const existingIdx = markouts.findIndex((m) => m.horizon_s === input.markout.horizon_s);
        if (existingIdx >= 0) {
            markouts[existingIdx] = input.markout;
        } else {
            markouts.push(input.markout);
        }
        markouts.sort((a, b) => a.horizon_s - b.horizon_s);

        const updatedTrace: TradeTrace = {
            ...trace,
            markouts,
        };
        const updated: Trade = {
            ...current,
            trace: updatedTrace,
        };
        this.trades[index] = updated;
        this.saveToDisk();
        return updated;
    }

    getTradeByHash(hash: string): Trade | null {
        this.init();
        const index = this.findTradeIndexByHash(hash);
        return index >= 0 ? this.trades[index]! : null;
    }

    getTradeById(tradeId: string): Trade | null {
        this.init();
        const index = this.findTradeIndexById(tradeId);
        return index >= 0 ? this.trades[index]! : null;
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

        // Include both FILLED and PARTIAL executions (Fix A).
        // Exclude REJECTED/PENDING — those are non-executions.
        const executed = this.trades.filter(
            (t) => t.status === 'FILLED' || t.status === 'PARTIAL',
        );

        // Resolve effective PnL for each executed trade.
        // When trade.pnl is zero/missing (OfferExecutor emits pnl:0),
        // compute a fallback from trace/fill data.
        const withPnl = executed.map((t) => ({
            trade: t,
            effectivePnl: resolveEffectivePnl(t),
        }));

        // Epsilon-aware classification
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
            warnOnPoorClassifiability('tradeHistory.getStats', report);
        }

        // PnL totals — use execute-aware fallback when no pnl field is usable
        const todayExecuted = withPnl.filter((e) => e.trade.timestamp >= todayTimestamp);
        const pnlSum = (items: typeof withPnl) =>
            items.reduce((sum, e) => sum + (e.effectivePnl ?? 0), 0);

        let totalPnl = pnlSum(withPnl);
        let todayPnl = pnlSum(todayExecuted);

        // If no trade has a non-zero effective PnL, use the lot-based fallback
        if (classifiable === 0 && breakeven === 0 && unclassifiable === executed.length) {
            const fallback = computeFallbackRealizedPnl(this.trades, todayTimestamp);
            totalPnl = fallback.total;
            todayPnl = fallback.today;
        }

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
            totalTrades: this.trades.length,
            winningTrades: wins.length,
            losingTrades: losses.length,
            winRate: classifiable > 0
                ? (wins.length / classifiable) * 100
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
