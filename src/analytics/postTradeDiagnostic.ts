/**
 * Post-Trade Diagnostic Builder
 *
 * Pure function that computes a compact diagnostic summary for each trade event.
 * Operates per-trade (independent — no cross-trade PnL assumptions).
 *
 * Diagnostics are derived on read from the Trade object + its embedded TradeTrace.
 *
 * Classification:
 * - eventBucket categorises the lifecycle stage (PRE_SUBMIT_REJECT, XRPL_NO_FILL, etc.)
 * - primaryCause identifies the root cause within that bucket
 * - spreadRegime tags market conditions at decision time
 *
 * All formulas are side-aware (BUY vs SELL) to correctly attribute price improvement.
 */

/* ────── shared types (re-used from the web mirror to avoid backend-only import) ──── */

export type EventBucket =
    | 'PRE_SUBMIT_REJECT'
    | 'XRPL_NO_FILL'
    | 'XRPL_PARTIAL'
    | 'XRPL_FILLED'
    | 'OTHER';

export type PrimaryCause =
    | 'BOT_MIN_SIZE'
    | 'IOC_NO_MATCH_AT_LIMIT'
    | 'PARTIAL_LIQUIDITY'
    | 'CLEAN_SPREAD_CROSS'
    | 'OTHER';

export type SpreadRegime = 'TIGHT' | 'NORMAL' | 'WIDE';

export interface PostTradeDiagnostic {
    /* identity */
    tradeId: string;
    pair: string;
    side: string; // 'BUY' | 'SELL'
    status: string; // 'FILLED' | 'PARTIAL' | 'REJECTED' | 'PENDING'
    timestamp: number;

    /* classification */
    eventBucket: EventBucket;
    primaryCause: PrimaryCause;
    spreadRegime: SpreadRegime | null;

    /* snapshot */
    baselineBestBid: number | null;
    baselineBestAsk: number | null;
    baselineMid: number | null;
    baselineSpreadBps: number | null;

    /* precheck */
    requiredBase: number | null;
    minRequiredBase: number | null;
    predFillableBase: number | null;
    predFillRatio: number | null;
    predictedVwap: number | null;
    predictedWorstPrice: number | null;
    precheckHasDepth: boolean | null;

    /* execution */
    filledBase: number | null;
    filledQuote: number | null;
    actualFillRatio: number | null;
    avgFillPriceQpb: number | null;
    fee: number | null;
    slippageBpsLogged: number | null;

    /* execution quality (null if no fill) */
    priceVsArrivalBps: number | null;
    distanceFromMidBps: number | null;
    fillVsPredVwapBps: number | null;
    predictedVsActualFillRatioGap: number | null;

    /* xrpl / result */
    engineResult: string | null;
    engineResultCode: number | null;
    engineResultMessage: string | null;
    ackStatus: string | null;
    outcome: string | null;
    outcomeReason: string | null;
    txHash: string | null;
    sequence: number | null;

    /* retry / reprice */
    retryCount: number;
    repriceDecision: string | null;
    repricedPrice: number | null;
    requiredRepriceBps: number | null;

    /* timing (ms, null if timestamps missing) */
    decisionToSubmitMs: number | null;
    submitToAckMs: number | null;
    ackToValidatedMs: number | null;
    decisionToValidatedMs: number | null;

    /* markouts */
    markout60sStatus: string | null;
    markout60sBps: number | null;
    markout300sStatus: string | null;
    markout300sBps: number | null;

    /* notes */
    notes: string[];
}

/* ────── minimal trade shape expected (duck-typed for both backend & frontend Trade) ──── */

export interface DiagnosticTradeInput {
    id: string;
    pair?: string;
    side: string;
    status: string;
    timestamp: number;
    amount?: number;
    amountBase?: number;
    filled?: number;
    filledBase?: number;
    filledQuote?: number;
    priceQuotePerBase?: number;
    price?: number;
    fee?: number;
    hash?: string;
    slippageBps?: number;
    trace?: DiagnosticTraceInput | null;
}

export interface DiagnosticTraceInput {
    trade_id?: string;
    decision_ts_ms?: number | null;
    baseline_ts_ms?: number | null;
    baseline_best_bid?: number | null;
    baseline_best_ask?: number | null;
    baseline_mid?: number | null;
    baseline_spread_bps?: number | null;
    baseline_source?: string | null;
    expected_price?: number | null;
    expected_rule?: string | null;
    submit_ts_ms?: number | null;
    submit_response_ts_ms?: number | null;
    ack_ts_ms?: number | null;
    validated_ts_ms?: number | null;
    validated_ledger_index?: number | null;
    tx_hash?: string | null;
    fee_drops?: string | null;
    sequence?: number | null;
    depth_check?: {
        side?: string;
        required_base?: number | null;
        min_required_base?: number | null;
        fillable_base?: number | null;
        vwap?: number | null;
        worst_price?: number | null;
        limit_price?: number | null;
        has_depth?: boolean | null;
        order_type?: string | null;
        [k: string]: unknown;
    } | null;
    depth_reprice?: {
        decision?: string | null;
        repriced_price?: number | null;
        required_reprice_bps?: number | null;
        [k: string]: unknown;
    } | null;
    submit_result?: {
        engine_result?: string | null;
        engine_result_code?: number | null;
        engine_result_message?: string | null;
    } | null;
    ack_status?: string | null;
    outcome?: string | null;
    outcome_reason?: string | null;
    retry_attempts?: Array<{
        attempt_n?: number;
        engine_result?: string | null;
        classified_outcome?: string | null;
        [k: string]: unknown;
    }>;
    fill_snapshot?: {
        filled_base?: number | null;
        filled_quote?: number | null;
        avg_price?: number | null;
        fee?: number | null;
        partial?: boolean;
        [k: string]: unknown;
    } | null;
    markouts?: Array<{
        horizon_s?: number;
        markout_bps?: number | null;
        status?: string;
        [k: string]: unknown;
    }>;
    [k: string]: unknown;
}

/* ────── helpers ──── */

function num(v: unknown): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function diffMs(a: number | null | undefined, b: number | null | undefined): number | null {
    const na = num(a);
    const nb = num(b);
    if (na == null || nb == null) return null;
    return nb - na;
}

function bpsDiff(actual: number | null, reference: number | null): number | null {
    if (actual == null || reference == null || reference === 0) return null;
    return ((actual - reference) / reference) * 10_000;
}

function classifySpreadRegime(spreadBps: number | null): SpreadRegime | null {
    if (spreadBps == null) return null;
    if (spreadBps <= 3) return 'TIGHT';
    if (spreadBps <= 10) return 'NORMAL';
    return 'WIDE';
}

/* ────── main builder ──── */

export function buildPostTradeDiagnostic(trade: DiagnosticTradeInput): PostTradeDiagnostic {
    const t = trade.trace ?? ({} as DiagnosticTraceInput);
    const dc = t.depth_check ?? null;
    const dr = t.depth_reprice ?? null;
    const sr = t.submit_result ?? null;
    const fs = t.fill_snapshot ?? null;

    const notes: string[] = [];

    /* ── identity ── */
    const side = (trade.side ?? 'BUY').toUpperCase();
    const isBuy = side === 'BUY';
    const status = (trade.status ?? 'REJECTED').toUpperCase();

    /* ── snapshot ── */
    const baselineBestBid = num(t.baseline_best_bid);
    const baselineBestAsk = num(t.baseline_best_ask);
    const baselineMid = num(t.baseline_mid);
    const baselineSpreadBps = num(t.baseline_spread_bps);
    const spreadRegime = classifySpreadRegime(baselineSpreadBps);

    /* ── precheck ── */
    const requiredBase = num(dc?.required_base);
    const minRequiredBase = num(dc?.min_required_base);
    const predFillableBase = num(dc?.fillable_base);
    const predictedVwap = num(dc?.vwap);
    const predictedWorstPrice = num(dc?.worst_price);
    const precheckHasDepth = dc?.has_depth ?? null;
    const predFillRatio = (requiredBase != null && requiredBase > 0 && predFillableBase != null)
        ? predFillableBase / requiredBase
        : null;

    /* ── execution ── */
    const amountBase = num(trade.amountBase) ?? num(trade.amount) ?? 0;
    const filledBase = num(trade.filledBase) ?? num(fs?.filled_base) ?? num(trade.filled) ?? 0;
    const filledQuote = num(trade.filledQuote) ?? num(fs?.filled_quote) ?? 0;
    const fee = num(trade.fee) ?? num(fs?.fee) ?? null;
    const slippageBpsLogged = num(trade.slippageBps) ?? null;
    const hasFill = filledBase > 0;
    const avgFillPriceQpb = hasFill && filledQuote > 0 ? filledQuote / filledBase : null;
    const actualFillRatio = amountBase > 0 ? filledBase / amountBase : 0;

    /* ── execution quality (side-aware) ── */
    let priceVsArrivalBps: number | null = null;
    let distanceFromMidBps: number | null = null;
    let fillVsPredVwapBps: number | null = null;

    if (hasFill && avgFillPriceQpb != null) {
        if (isBuy) {
            priceVsArrivalBps = bpsDiff(avgFillPriceQpb, baselineBestAsk);
            distanceFromMidBps = bpsDiff(avgFillPriceQpb, baselineMid);
            fillVsPredVwapBps = bpsDiff(avgFillPriceQpb, predictedVwap);
        } else {
            // SELL: negative = good (sold higher than arrival)
            priceVsArrivalBps = baselineBestBid != null && baselineBestBid > 0
                ? ((baselineBestBid - avgFillPriceQpb) / baselineBestBid) * 10_000
                : null;
            distanceFromMidBps = baselineMid != null && baselineMid > 0
                ? ((baselineMid - avgFillPriceQpb) / baselineMid) * 10_000
                : null;
            fillVsPredVwapBps = predictedVwap != null && predictedVwap > 0
                ? ((predictedVwap - avgFillPriceQpb) / predictedVwap) * 10_000
                : null;
        }
    }

    const predictedVsActualFillRatioGap = (predFillRatio != null)
        ? actualFillRatio - predFillRatio
        : null;

    /* ── xrpl / result ── */
    const engineResult = sr?.engine_result ?? null;
    const engineResultCode = num(sr?.engine_result_code);
    const engineResultMessage = sr?.engine_result_message ?? null;
    const ackStatus = t.ack_status ?? null;
    const outcome = t.outcome ?? null;
    const outcomeReason = t.outcome_reason ?? null;
    const txHash = t.tx_hash ?? trade.hash ?? null;
    const sequence = num(t.sequence);

    /* ── retry / reprice ── */
    const retryAttempts = t.retry_attempts ?? [];
    const retryCount = retryAttempts.length;
    const repriceDecision = dr?.decision ?? null;
    const repricedPrice = num(dr?.repriced_price);
    const requiredRepriceBps = num(dr?.required_reprice_bps);

    /* ── timing ── */
    const decisionToSubmitMs = diffMs(t.decision_ts_ms, t.submit_ts_ms);
    const submitToAckMs = diffMs(t.submit_ts_ms, t.ack_ts_ms);
    const ackToValidatedMs = diffMs(t.ack_ts_ms, t.validated_ts_ms);
    const decisionToValidatedMs = diffMs(t.decision_ts_ms, t.validated_ts_ms);

    /* ── markouts ── */
    const markouts = t.markouts ?? [];
    const m60 = markouts.find(m => m.horizon_s === 60);
    const m300 = markouts.find(m => m.horizon_s === 300);
    const markout60sStatus = m60?.status ?? null;
    const markout60sBps = num(m60?.markout_bps);
    const markout300sStatus = m300?.status ?? null;
    const markout300sBps = num(m300?.markout_bps);

    /* ── classification ── */
    const hasSubmit = t.submit_ts_ms != null;
    let eventBucket: EventBucket;
    let primaryCause: PrimaryCause;

    if (!hasSubmit) {
        // No submit timestamp → pre-submit reject (bot-side abort)
        eventBucket = 'PRE_SUBMIT_REJECT';
        primaryCause = classifyPreSubmitCause(trade, t, notes);
    } else if (status === 'FILLED') {
        eventBucket = 'XRPL_FILLED';
        primaryCause = classifyFilledCause(priceVsArrivalBps, notes);
    } else if (status === 'PARTIAL') {
        eventBucket = 'XRPL_PARTIAL';
        primaryCause = 'PARTIAL_LIQUIDITY';
        notes.push(`Partial fill: ${(actualFillRatio * 100).toFixed(1)}% of requested`);
    } else if (engineResult === 'tecKILLED' || outcome === 'rejected') {
        eventBucket = 'XRPL_NO_FILL';
        primaryCause = classifyNoFillCause(dc, engineResult, notes);
    } else {
        eventBucket = 'OTHER';
        primaryCause = 'OTHER';
        notes.push(`Unclassified: status=${status} outcome=${outcome}`);
    }

    // Context notes
    if (retryCount > 0) {
        notes.push(`${retryCount} retry attempt(s)`);
    }
    if (repriceDecision && repriceDecision !== 'not_needed') {
        notes.push(`Reprice: ${repriceDecision}`);
    }
    if (spreadRegime === 'WIDE') {
        notes.push(`Wide spread at entry (${baselineSpreadBps?.toFixed(1)} bps)`);
    }

    return {
        tradeId: trade.id,
        pair: trade.pair ?? '',
        side,
        status,
        timestamp: trade.timestamp,

        eventBucket,
        primaryCause,
        spreadRegime,

        baselineBestBid,
        baselineBestAsk,
        baselineMid,
        baselineSpreadBps,

        requiredBase,
        minRequiredBase,
        predFillableBase,
        predFillRatio,
        predictedVwap,
        predictedWorstPrice,
        precheckHasDepth,

        filledBase: hasFill ? filledBase : 0,
        filledQuote: hasFill ? filledQuote : 0,
        actualFillRatio,
        avgFillPriceQpb,
        fee,
        slippageBpsLogged,

        priceVsArrivalBps,
        distanceFromMidBps,
        fillVsPredVwapBps,
        predictedVsActualFillRatioGap,

        engineResult,
        engineResultCode,
        engineResultMessage,
        ackStatus,
        outcome,
        outcomeReason,
        txHash,
        sequence,

        retryCount,
        repriceDecision,
        repricedPrice,
        requiredRepriceBps,

        decisionToSubmitMs,
        submitToAckMs,
        ackToValidatedMs,
        decisionToValidatedMs,

        markout60sStatus,
        markout60sBps,
        markout300sStatus,
        markout300sBps,

        notes,
    };
}

/* ── sub-classifiers ── */

function classifyPreSubmitCause(
    _trade: DiagnosticTradeInput,
    trace: DiagnosticTraceInput,
    notes: string[],
): PrimaryCause {
    const msg = trace.submit_result?.engine_result_message ?? '';
    const reason = trace.outcome_reason ?? '';
    const combined = `${msg} ${reason}`.toLowerCase();

    if (combined.includes('abort_below_min') || combined.includes('min_size') || combined.includes('below minimum')) {
        notes.push('Bot rejected: below minimum order size');
        return 'BOT_MIN_SIZE';
    }
    if (combined.includes('abort') || combined.includes('gate') || combined.includes('blocked')) {
        notes.push(`Bot rejected: ${reason || msg || 'pre-submit gate'}`);
        return 'OTHER';
    }
    notes.push('Pre-submit rejection (no XRPL submission)');
    return 'OTHER';
}

function classifyFilledCause(
    priceVsArrivalBps: number | null,
    notes: string[],
): PrimaryCause {
    if (priceVsArrivalBps != null && Math.abs(priceVsArrivalBps) <= 1) {
        notes.push('Clean spread cross — fill near arrival price');
        return 'CLEAN_SPREAD_CROSS';
    }
    if (priceVsArrivalBps != null) {
        notes.push(`Fill ${priceVsArrivalBps > 0 ? 'worse' : 'better'} than arrival by ${Math.abs(priceVsArrivalBps).toFixed(1)} bps`);
    }
    return 'OTHER';
}

function classifyNoFillCause(
    depthCheck: DiagnosticTraceInput['depth_check'],
    engineResult: string | null,
    notes: string[],
): PrimaryCause {
    const orderType = depthCheck?.order_type ?? '';
    if (engineResult === 'tecKILLED' && (orderType === 'IOC' || orderType === 'FOK')) {
        notes.push(`${orderType} order killed — no match at limit price`);
        return 'IOC_NO_MATCH_AT_LIMIT';
    }
    if (engineResult === 'tecKILLED') {
        notes.push('XRPL tecKILLED — no funds transferred');
        return 'IOC_NO_MATCH_AT_LIMIT';
    }
    notes.push(`XRPL no-fill: ${engineResult ?? 'unknown engine result'}`);
    return 'OTHER';
}

/**
 * Batch-build diagnostics for an array of trades (most recent first).
 * Caps output at `limit` items.
 */
export function buildDiagnosticsForTrades(
    trades: DiagnosticTradeInput[],
    limit = 10,
): PostTradeDiagnostic[] {
    // Sort newest first, take limit, then build diagnostics
    const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp);
    const capped = sorted.slice(0, limit);
    return capped.map(buildPostTradeDiagnostic);
}
