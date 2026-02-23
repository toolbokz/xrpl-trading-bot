import {
    TradeDepthCheckSnapshot,
    TradeIntentAmount,
    TradeOfferCreateIntent,
    TradeTrace,
} from './tradeHistory';

export type OfferOutcomeCategory =
    | 'INSUFFICIENT_LIQUIDITY_AT_PRICE'
    | 'MISSING_DEPTH_EVIDENCE'
    | 'ROUNDING_OR_MINIMUM_AMOUNT'
    | 'MIN_ORDER_SANITY'
    | 'MISSING_INTENT_TRACE'
    | 'BALANCE_OR_TRUSTLINE'
    | 'EXPIRED_LAST_LEDGER'
    | 'FEE_OR_RESERVE'
    | 'UNKNOWN';

export interface OfferOutcomeEvidence {
    txType: string | null;
    txResult: string | null;
    engineResult: string | null;
    outcome: string | null;
    outcomeReason: string | null;
    expectedPrice: number | null;
    baselineBestBid: number | null;
    baselineBestAsk: number | null;
    baselineSpreadBps: number | null;
    side: 'buy' | 'sell' | null;
    impliedLimitPrice: number | null;
    diffVsExpectedBps: number | null;
    diffVsIntendedBps: number | null;
    intendedPrice: number | null;
    requiredBase: number | null;
    minRequiredBase: number | null;
    fillableBase: number | null;
    hasDepth: boolean | null;
    iocMinFillRatio: number | null;
    depthCheckLevels: number | null;
    orderType: 'IOC' | 'FOK' | null;
    offerCreateMissing: boolean;
    takerAmountsMissing: boolean;
    minUnitUnderflowShown: boolean;
}

export interface OfferOutcomeExplanation {
    outcomeCategory: OfferOutcomeCategory;
    rootCause: string | null;
    evidence: OfferOutcomeEvidence;
    recommendedFix: string;
}

interface ComputeImpliedOfferPriceArgs {
    offerCreateIntent: TradeOfferCreateIntent | null;
    side: 'BUY' | 'SELL' | 'buy' | 'sell' | null | undefined;
}

const DROPS_PER_XRP = 1_000_000;
const SANITY_DEVIATION_THRESHOLD_BPS = 2;
const MIN_ISSUED_CURRENCY_UNDERFLOW_UNIT = 1e-15;

function normalizeSide(side: ComputeImpliedOfferPriceArgs['side']): 'buy' | 'sell' | null {
    if (side === 'BUY' || side === 'buy') return 'buy';
    if (side === 'SELL' || side === 'sell') return 'sell';
    return null;
}

function toFinitePositive(value: number | null): number | null {
    if (value == null || !Number.isFinite(value) || value <= 0) return null;
    return value;
}

function toFiniteNonNegative(value: number | null): number | null {
    if (value == null || !Number.isFinite(value) || value < 0) return null;
    return value;
}

function parseIntentAmountValue(amount: TradeIntentAmount | null): number | null {
    if (amount == null) return null;
    if (typeof amount === 'string') {
        const parsedDrops = Number(amount);
        if (!Number.isFinite(parsedDrops) || parsedDrops <= 0) return null;
        return parsedDrops / DROPS_PER_XRP;
    }
    const rawValue = amount.value;
    const parsed = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function hasOfferCreateTakerAmounts(intent: TradeOfferCreateIntent | null): boolean {
    if (!intent) return false;
    return intent.takerGets != null && intent.takerPays != null;
}

function parseFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function amountShowsMinUnitUnderflow(amount: TradeIntentAmount | null): boolean {
    if (amount == null) return false;
    if (typeof amount === 'string') {
        const drops = parseFiniteNumber(amount);
        return drops != null && drops > 0 && drops < 1;
    }

    const maybeValue = parseFiniteNumber(amount.value);
    return maybeValue != null && maybeValue > 0 && maybeValue < MIN_ISSUED_CURRENCY_UNDERFLOW_UNIT;
}

function canShowMinUnitUnderflow(intent: TradeOfferCreateIntent | null): boolean {
    if (!intent) return false;
    return amountShowsMinUnitUnderflow(intent.takerGets) || amountShowsMinUnitUnderflow(intent.takerPays);
}

function computeAbsoluteDiffBps(reference: number | null, observed: number | null): number | null {
    if (reference == null || observed == null || !Number.isFinite(reference) || !Number.isFinite(observed) || reference <= 0) {
        return null;
    }
    return Math.abs(((observed - reference) / reference) * 10_000);
}

function inferTxResult(trace: TradeTrace): string | null {
    if (typeof trace.fill_snapshot?.transaction_result === 'string' && trace.fill_snapshot.transaction_result.length > 0) {
        return trace.fill_snapshot.transaction_result;
    }
    if (typeof trace.submit_result?.engine_result === 'string' && trace.submit_result.engine_result.length > 0) {
        return trace.submit_result.engine_result;
    }
    if (typeof trace.outcome_reason === 'string' && trace.outcome_reason.length > 0) {
        return trace.outcome_reason;
    }
    return null;
}

function hasInsufficientDepth(depth: TradeDepthCheckSnapshot | null): boolean {
    if (!depth) return false;
    if (depth.has_depth === false) return true;
    const fillable = toFiniteNonNegative(depth.fillable_base);
    const minRequired = toFiniteNonNegative(depth.min_required_base);
    if (fillable == null || minRequired == null) return false;
    return fillable + 1e-12 < minRequired;
}

function hasDepthEvidence(depth: TradeDepthCheckSnapshot | null): boolean {
    if (!depth) return false;
    if (typeof depth.has_depth === 'boolean') return true;
    if (toFiniteNonNegative(depth.required_base) != null) return true;
    if (toFiniteNonNegative(depth.min_required_base) != null) return true;
    if (toFiniteNonNegative(depth.fillable_base) != null) return true;
    return false;
}

function mapRecommendedFix(category: OfferOutcomeCategory): string {
    switch (category) {
        case 'INSUFFICIENT_LIQUIDITY_AT_PRICE':
            return 'Reduce order size or relax the limit price to match available liquidity.';
        case 'MISSING_DEPTH_EVIDENCE':
            return 'Persist depth preflight snapshots for OfferCreate attempts before submit.';
        case 'ROUNDING_OR_MINIMUM_AMOUNT':
            return 'Round base/quote amounts to valid precision and avoid dust-sized offers.';
        case 'MIN_ORDER_SANITY':
            return 'Increase order size or relax min-order thresholds to avoid dust/underflow rejects.';
        case 'MISSING_INTENT_TRACE':
            return 'Enable tx-intent lookup/backfill and persist tx_type/offer_create for rejected trades.';
        case 'BALANCE_OR_TRUSTLINE':
            return 'Verify balances, trustlines, and authorization for both legs before submit.';
        case 'EXPIRED_LAST_LEDGER':
            return 'Increase LastLedgerSequence buffer and reduce submit-to-ledger latency.';
        case 'FEE_OR_RESERVE':
            return 'Increase fee/reserve headroom before placing offers.';
        default:
            return 'Inspect submit_result/meta alongside offer_create and depth evidence.';
    }
}

export function computeImpliedOfferPriceQuotePerBase(
    args: ComputeImpliedOfferPriceArgs,
): number | null {
    const side = normalizeSide(args.side);
    if (!side || !args.offerCreateIntent) return null;

    const takerGets = parseIntentAmountValue(args.offerCreateIntent.takerGets);
    const takerPays = parseIntentAmountValue(args.offerCreateIntent.takerPays);
    if (takerGets == null || takerPays == null || takerGets <= 0 || takerPays <= 0) {
        return null;
    }

    const baseAmount = side === 'buy' ? takerPays : takerGets;
    const quoteAmount = side === 'buy' ? takerGets : takerPays;
    if (baseAmount <= 0 || quoteAmount <= 0) return null;

    const implied = quoteAmount / baseAmount;
    if (!Number.isFinite(implied) || implied <= 0) return null;
    return implied;
}

export function explainOfferOutcome(input: {
    trace: TradeTrace | null | undefined;
    side?: 'BUY' | 'SELL' | 'buy' | 'sell' | null;
}): OfferOutcomeExplanation | null {
    const trace = input.trace;
    if (!trace) return null;

    const side = normalizeSide(input.side ?? null);
    const txResult = inferTxResult(trace);
    const txResultUpper = txResult?.toUpperCase() ?? null;
    const txResultLower = txResult?.toLowerCase() ?? null;
    const offerCreateIntent = trace.offer_create;
    const hasOfferCreateIntent = offerCreateIntent != null;
    const hasTakerAmounts = hasOfferCreateTakerAmounts(offerCreateIntent);

    const impliedLimitPrice = computeImpliedOfferPriceQuotePerBase({
        offerCreateIntent,
        side,
    });

    const intendedPrice = toFinitePositive(trace.depth_check?.intended_price ?? null);
    const diffVsExpectedBps = computeAbsoluteDiffBps(toFinitePositive(trace.expected_price), impliedLimitPrice);
    const diffVsIntendedBps = computeAbsoluteDiffBps(intendedPrice, impliedLimitPrice);
    const minUnitUnderflowShown = canShowMinUnitUnderflow(offerCreateIntent);
    const hasDepthCheckEvidence = hasDepthEvidence(trace.depth_check);
    const largeImpliedPriceDeviation =
        impliedLimitPrice != null
        && (
            (diffVsExpectedBps != null && diffVsExpectedBps > SANITY_DEVIATION_THRESHOLD_BPS)
            || (diffVsIntendedBps != null && diffVsIntendedBps > SANITY_DEVIATION_THRESHOLD_BPS)
        );
    const roundingOrMinProof = hasOfferCreateIntent && hasTakerAmounts && (largeImpliedPriceDeviation || minUnitUnderflowShown);

    const evidence: OfferOutcomeEvidence = {
        txType: trace.tx_type,
        txResult,
        engineResult: trace.submit_result?.engine_result ?? null,
        outcome: trace.outcome ?? null,
        outcomeReason: trace.outcome_reason,
        expectedPrice: toFinitePositive(trace.expected_price),
        baselineBestBid: toFinitePositive(trace.baseline_best_bid),
        baselineBestAsk: toFinitePositive(trace.baseline_best_ask),
        baselineSpreadBps: trace.baseline_spread_bps,
        side,
        impliedLimitPrice,
        diffVsExpectedBps,
        diffVsIntendedBps,
        intendedPrice,
        requiredBase: toFiniteNonNegative(trace.depth_check?.required_base ?? null),
        minRequiredBase: toFiniteNonNegative(trace.depth_check?.min_required_base ?? null),
        fillableBase: toFiniteNonNegative(trace.depth_check?.fillable_base ?? null),
        hasDepth: trace.depth_check?.has_depth ?? null,
        iocMinFillRatio: toFiniteNonNegative(trace.depth_check?.ioc_min_fill_ratio ?? null),
        depthCheckLevels: toFiniteNonNegative(trace.depth_check?.depth_check_levels ?? null),
        orderType: trace.depth_check?.order_type ?? null,
        offerCreateMissing: !hasOfferCreateIntent,
        takerAmountsMissing: !hasTakerAmounts,
        minUnitUnderflowShown,
    };

    let outcomeCategory: OfferOutcomeCategory = 'UNKNOWN';
    let rootCause: string | null = null;

    if (txResultLower === 'execution-min-order-sanity') {
        outcomeCategory = 'MIN_ORDER_SANITY';
        rootCause = 'EXECUTION_MIN_ORDER_SANITY';
    } else if (trace.outcome === 'partial' || trace.fill_snapshot?.partial === true) {
        outcomeCategory = 'INSUFFICIENT_LIQUIDITY_AT_PRICE';
    } else if (txResultUpper === 'TECKILLED') {
        if (!hasOfferCreateIntent || !hasTakerAmounts) {
            outcomeCategory = 'MISSING_INTENT_TRACE';
            rootCause = 'MISSING_OFFER_CREATE_INTENT';
        } else if (!hasDepthCheckEvidence) {
            outcomeCategory = 'MISSING_DEPTH_EVIDENCE';
            rootCause = 'MISSING_DEPTH_CHECK';
        } else if (hasInsufficientDepth(trace.depth_check)) {
            outcomeCategory = 'INSUFFICIENT_LIQUIDITY_AT_PRICE';
        } else if (roundingOrMinProof) {
            outcomeCategory = 'ROUNDING_OR_MINIMUM_AMOUNT';
        } else {
            outcomeCategory = 'UNKNOWN';
        }
    } else if (
        txResultUpper === 'TECUNFUNDED_OFFER'
        || txResultUpper === 'TECNO_LINE'
        || txResultUpper === 'TECNO_AUTH'
        || txResultUpper === 'TECNO_ISSUER'
        || txResultUpper === 'TECFROZEN'
    ) {
        outcomeCategory = 'BALANCE_OR_TRUSTLINE';
    } else if (
        txResultUpper === 'TECINSUF_RESERVE_OFFER'
        || txResultUpper === 'TELINSUF_FEE_P'
        || txResultUpper === 'TECINSUFF_FEE'
    ) {
        outcomeCategory = 'FEE_OR_RESERVE';
    } else if (
        txResultUpper === 'TEFMAX_LEDGER'
        || txResultUpper === 'TECEXPIRED'
        || txResultUpper === 'TEMBAD_EXPIRATION'
    ) {
        outcomeCategory = 'EXPIRED_LAST_LEDGER';
    } else if (roundingOrMinProof && txResultUpper?.startsWith('TEM')) {
        outcomeCategory = 'ROUNDING_OR_MINIMUM_AMOUNT';
    }

    return {
        outcomeCategory,
        rootCause,
        evidence,
        recommendedFix: mapRecommendedFix(outcomeCategory),
    };
}
