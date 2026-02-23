import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getApiXrplClient } from '../../../lib/apiXrplClient';
import {
    tradeHistory,
    TradeDepthCheckSnapshot,
    TradeDepthRepriceSnapshot,
    TradeOfferCreateIntent,
    TradeTrace,
    TradeTracePatch,
} from '../../../../analytics/tradeHistory';
import { explainOfferOutcome, OfferOutcomeExplanation } from '../../../../analytics/offerOutcomeExplainer';
import { TokenBucketRateLimiter } from '../../../../utils/rateLimiter';

export const config = {
    api: { bodyParser: false },
};

interface TxIntentResponse {
    requestId: string;
    tradeId: string | null;
    hash: string | null;
    pairKey: string | null;
    txType: string | null;
    offerCreateIntent: TradeOfferCreateIntent | null;
    depth_check: TradeDepthCheckSnapshot | null;
    depth_reprice: TradeDepthRepriceSnapshot | null;
    explain: OfferOutcomeExplanation | null;
    backfilled: boolean;
    backfillError: string | null;
}

interface ErrorResponse {
    requestId: string;
    error: string;
}

function firstQueryValue(value: string | string[] | undefined): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
        const trimmed = value[0].trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

function redactIntentAmount(amount: string | Record<string, unknown> | null): string | Record<string, unknown> | null {
    if (typeof amount === 'string' || amount == null) return amount;
    const copy: Record<string, unknown> = { ...amount };
    if (typeof copy.issuer === 'string') {
        copy.issuer = '[redacted]';
    }
    return copy;
}

interface OfferCreateFlagDefinition {
    mask: number;
    label: string;
}

const OFFER_CREATE_FLAG_DEFINITIONS: OfferCreateFlagDefinition[] = [
    { mask: 0x00010000, label: 'PASSIVE' },
    { mask: 0x00020000, label: 'IOC' },
    { mask: 0x00040000, label: 'FOK' },
    { mask: 0x00080000, label: 'SELL' },
];

const OFFER_CREATE_KNOWN_FLAG_MASK = OFFER_CREATE_FLAG_DEFINITIONS.reduce(
    (acc, entry) => acc | entry.mask,
    0,
);

let txIntentLookupLimiter: TokenBucketRateLimiter | null = null;

function getTxIntentLookupLimiter(): TokenBucketRateLimiter {
    if (!txIntentLookupLimiter) {
        const parsed = Number.parseInt(process.env.TX_INTENT_LOOKUP_MAX_TPS ?? '4', 10);
        const maxTps = Number.isFinite(parsed) ? Math.max(1, parsed) : 4;
        txIntentLookupLimiter = new TokenBucketRateLimiter({
            maxTps,
            bucketSize: maxTps,
        });
    }
    return txIntentLookupLimiter;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value != null;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (typeof raw !== 'string') return fallback;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
    return fallback;
}

function parseIntegerOrNull(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.floor(value);
}

function toLookupTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.TX_INTENT_LOOKUP_TIMEOUT_MS ?? '5000', 10);
    if (!Number.isFinite(parsed)) return 5000;
    return Math.min(30_000, Math.max(250, parsed));
}

function decodeOfferCreateFlags(rawFlags: number): string[] {
    const decoded = new Set<string>();
    for (const entry of OFFER_CREATE_FLAG_DEFINITIONS) {
        if ((rawFlags & entry.mask) !== 0) {
            decoded.add(entry.label);
        }
    }
    const unknownMask = rawFlags & ~OFFER_CREATE_KNOWN_FLAG_MASK;
    if (unknownMask !== 0) {
        decoded.add(`RAW_0x${unknownMask.toString(16).toUpperCase()}`);
    }
    return Array.from(decoded);
}

function sanitizeOfferCreateIntent(intent: TradeOfferCreateIntent | null | undefined): TradeOfferCreateIntent | null {
    if (!intent) return null;
    return {
        flags: Number.isFinite(intent.flags) ? Math.max(0, Math.floor(intent.flags)) : 0,
        flagsDecoded: Array.isArray(intent.flagsDecoded)
            ? intent.flagsDecoded.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
            : [],
        takerGets: redactIntentAmount(intent.takerGets),
        takerPays: redactIntentAmount(intent.takerPays),
        feeDrops: typeof intent.feeDrops === 'string' ? intent.feeDrops : null,
        sequence: typeof intent.sequence === 'number' && Number.isFinite(intent.sequence) ? intent.sequence : null,
        lastLedgerSequence: typeof intent.lastLedgerSequence === 'number' && Number.isFinite(intent.lastLedgerSequence)
            ? intent.lastLedgerSequence
            : null,
    };
}

function sanitizeDepthCheckSnapshot(snapshot: TradeDepthCheckSnapshot | null | undefined): TradeDepthCheckSnapshot | null {
    if (!snapshot) return null;
    return {
        side: snapshot.side === 'SELL' ? 'SELL' : 'BUY',
        intended_price: typeof snapshot.intended_price === 'number' && Number.isFinite(snapshot.intended_price)
            ? snapshot.intended_price
            : null,
        required_base: typeof snapshot.required_base === 'number' && Number.isFinite(snapshot.required_base)
            ? snapshot.required_base
            : null,
        min_required_base: typeof snapshot.min_required_base === 'number' && Number.isFinite(snapshot.min_required_base)
            ? snapshot.min_required_base
            : null,
        fillable_base: typeof snapshot.fillable_base === 'number' && Number.isFinite(snapshot.fillable_base)
            ? snapshot.fillable_base
            : null,
        has_depth: typeof snapshot.has_depth === 'boolean' ? snapshot.has_depth : null,
        ioc_min_fill_ratio: typeof snapshot.ioc_min_fill_ratio === 'number' && Number.isFinite(snapshot.ioc_min_fill_ratio)
            ? snapshot.ioc_min_fill_ratio
            : null,
        depth_check_levels: typeof snapshot.depth_check_levels === 'number' && Number.isFinite(snapshot.depth_check_levels)
            ? snapshot.depth_check_levels
            : null,
        order_type: snapshot.order_type === 'IOC' || snapshot.order_type === 'FOK'
            ? snapshot.order_type
            : null,
        ledger_index_mode: snapshot.ledger_index_mode === 'current' || snapshot.ledger_index_mode === 'validated'
            ? snapshot.ledger_index_mode
            : null,
        request_taker_gets_currency: typeof snapshot.request_taker_gets_currency === 'string'
            ? snapshot.request_taker_gets_currency
            : null,
        request_taker_pays_currency: typeof snapshot.request_taker_pays_currency === 'string'
            ? snapshot.request_taker_pays_currency
            : null,
        error: typeof snapshot.error === 'string' && snapshot.error.length > 0
            ? snapshot.error
            : null,
    };
}

function sanitizeDepthRepriceSnapshot(snapshot: TradeDepthRepriceSnapshot | null | undefined): TradeDepthRepriceSnapshot | null {
    if (!snapshot) return null;
    const decision = snapshot.decision === 'applied'
        || snapshot.decision === 'skipped_over_budget'
        || snapshot.decision === 'skipped_no_candidate'
        || snapshot.decision === 'not_needed'
        ? snapshot.decision
        : null;
    return {
        enabled: snapshot.enabled === true,
        intended_price: typeof snapshot.intended_price === 'number' && Number.isFinite(snapshot.intended_price)
            ? snapshot.intended_price
            : null,
        repriced_price: typeof snapshot.repriced_price === 'number' && Number.isFinite(snapshot.repriced_price)
            ? snapshot.repriced_price
            : null,
        required_reprice_bps: typeof snapshot.required_reprice_bps === 'number' && Number.isFinite(snapshot.required_reprice_bps)
            ? snapshot.required_reprice_bps
            : null,
        min_required_base: typeof snapshot.min_required_base === 'number' && Number.isFinite(snapshot.min_required_base)
            ? snapshot.min_required_base
            : null,
        fillable_base_at_intended: typeof snapshot.fillable_base_at_intended === 'number' && Number.isFinite(snapshot.fillable_base_at_intended)
            ? snapshot.fillable_base_at_intended
            : null,
        fillable_base_at_repriced: typeof snapshot.fillable_base_at_repriced === 'number' && Number.isFinite(snapshot.fillable_base_at_repriced)
            ? snapshot.fillable_base_at_repriced
            : null,
        decision,
        max_reprice_bps: typeof snapshot.max_reprice_bps === 'number' && Number.isFinite(snapshot.max_reprice_bps)
            ? snapshot.max_reprice_bps
            : null,
    };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${timeoutLabel}-timeout`)), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

function extractTxJson(result: Record<string, unknown>): Record<string, unknown> | null {
    if (isObjectRecord(result.tx_json)) return result.tx_json;
    if (isObjectRecord(result.tx)) return result.tx;
    const looksLikeTxJson =
        typeof result.TransactionType === 'string'
        || result.TakerGets !== undefined
        || result.TakerPays !== undefined
        || result.Flags !== undefined
        || result.Fee !== undefined
        || result.Sequence !== undefined
        || result.LastLedgerSequence !== undefined;
    if (looksLikeTxJson) return result;
    return null;
}

function parseOfferCreateIntentFromTxJson(txJson: Record<string, unknown>, txType: string): TradeOfferCreateIntent | null {
    if (txType !== 'OfferCreate') return null;

    const rawFlags = parseIntegerOrNull(txJson.Flags);
    const flags = rawFlags == null || rawFlags < 0 ? 0 : rawFlags;
    const intent: TradeOfferCreateIntent = {
        flags,
        flagsDecoded: decodeOfferCreateFlags(flags),
        takerGets: redactIntentAmount(
            typeof txJson.TakerGets === 'string' || isObjectRecord(txJson.TakerGets)
                ? txJson.TakerGets
                : null,
        ),
        takerPays: redactIntentAmount(
            typeof txJson.TakerPays === 'string' || isObjectRecord(txJson.TakerPays)
                ? txJson.TakerPays
                : null,
        ),
        feeDrops: typeof txJson.Fee === 'string' ? txJson.Fee : null,
        sequence: parseIntegerOrNull(txJson.Sequence),
        lastLedgerSequence: parseIntegerOrNull(txJson.LastLedgerSequence),
    };

    return sanitizeOfferCreateIntent(intent);
}

function mergeTraceWithBackfill(trace: TradeTrace | null | undefined, patch: {
    txType: string | null;
    offerCreateIntent: TradeOfferCreateIntent | null;
}): TradeTrace | null {
    if (!trace) return null;
    return {
        ...trace,
        tx_type: patch.txType ?? trace.tx_type,
        offer_create: patch.offerCreateIntent ?? trace.offer_create,
    };
}

async function lookupTxIntentByHash(hash: string): Promise<{
    txType: string;
    offerCreateIntent: TradeOfferCreateIntent | null;
}> {
    if (!getTxIntentLookupLimiter().tryConsume()) {
        throw new Error('tx-intent-lookup-rate-limited');
    }

    const client = await getApiXrplClient();
    const response = await withTimeout(
        client.request({
            command: 'tx',
            transaction: hash,
            binary: false,
        }),
        toLookupTimeoutMs(),
        'tx-intent-lookup',
    );

    if (!isObjectRecord(response)) {
        throw new Error('tx-intent-lookup-invalid-response');
    }
    const result = response.result;
    if (!isObjectRecord(result)) {
        throw new Error('tx-intent-lookup-missing-result');
    }
    if (result.validated !== true) {
        throw new Error('tx-not-validated');
    }

    const txJson = extractTxJson(result);
    if (!txJson) {
        throw new Error('tx-intent-lookup-missing-tx_json');
    }
    const txType = typeof txJson.TransactionType === 'string' && txJson.TransactionType.length > 0
        ? txJson.TransactionType
        : null;
    if (!txType) {
        throw new Error('tx-intent-lookup-missing-transaction-type');
    }

    const offerCreateIntent = parseOfferCreateIntentFromTxJson(txJson, txType);
    return {
        txType,
        offerCreateIntent,
    };
}

function canLookupTxIntent(): boolean {
    if (process.env.BOT_LOCAL_ONLY !== 'true') return false;
    return parseBooleanEnv('FEATURE_TX_INTENT_LOOKUP', false);
}

function shouldPersistTxIntentBackfill(): boolean {
    return parseBooleanEnv('FEATURE_TX_INTENT_LOOKUP_PERSIST', false);
}

async function handler(req: LocalRequest, res: NextApiResponse<TxIntentResponse | ErrorResponse>): Promise<void> {
    const tradeIdQuery = firstQueryValue(req.query.tradeId as string | string[] | undefined);
    const hashQuery = firstQueryValue(req.query.hash as string | string[] | undefined);

    if (!tradeIdQuery && !hashQuery) {
        res.status(400).json({
            requestId: req.requestId,
            error: 'Either tradeId or hash query parameter is required',
        });
        return;
    }

    let trade = tradeIdQuery
        ? tradeHistory.getTradeById(tradeIdQuery)
        : null;
    if (!trade && hashQuery) {
        trade = tradeHistory.getTradeByHash(hashQuery);
    }

    if (!trade) {
        res.status(404).json({
            requestId: req.requestId,
            error: 'Trade not found',
        });
        return;
    }

    const txHash = trade.hash ?? trade.trace?.tx_hash ?? null;
    const traceTxType = typeof trade.trace?.tx_type === 'string' && trade.trace.tx_type.length > 0
        ? trade.trace.tx_type
        : null;
    const traceOfferCreateIntent = sanitizeOfferCreateIntent(trade.trace?.offer_create ?? null);
    const traceDepthCheck = sanitizeDepthCheckSnapshot(trade.trace?.depth_check ?? null);
    const traceDepthReprice = sanitizeDepthRepriceSnapshot(trade.trace?.depth_reprice ?? null);
    let txType = traceTxType ?? (traceOfferCreateIntent ? 'OfferCreate' : null);
    let offerCreateIntent = traceOfferCreateIntent;
    let explainTrace: TradeTrace | null = trade.trace ?? null;
    let backfilled = false;
    let backfillError: string | null = null;

    const traceOfferMissing = trade.trace?.offer_create == null;
    const traceTxTypeMissing = traceTxType == null;
    if (txHash && (traceOfferMissing || traceTxTypeMissing) && canLookupTxIntent()) {
        try {
            const lookup = await lookupTxIntentByHash(txHash);
            txType = lookup.txType;
            offerCreateIntent = sanitizeOfferCreateIntent(lookup.offerCreateIntent);
            explainTrace = mergeTraceWithBackfill(trade.trace, {
                txType: lookup.txType,
                offerCreateIntent,
            });
            backfilled = true;

            if (shouldPersistTxIntentBackfill()) {
                const patch: TradeTracePatch = {};
                if (traceTxTypeMissing && txType) {
                    patch.tx_type = txType;
                }
                if (traceOfferMissing && offerCreateIntent) {
                    patch.offer_create = offerCreateIntent;
                }
                if (Object.keys(patch).length > 0) {
                    tradeHistory.upsertTradeTrace({
                        hash: txHash,
                        tradeId: trade.id ?? null,
                        patch,
                    });
                }
            }
        } catch (err) {
            backfillError = err instanceof Error ? err.message : 'tx-intent-lookup-failed';
        }
    }

    const explain = explainOfferOutcome({
        trace: explainTrace,
        side: trade.side,
    });

    res.status(200).json({
        requestId: req.requestId,
        tradeId: trade.id ?? null,
        hash: txHash,
        pairKey: trade.pair ?? null,
        txType,
        offerCreateIntent,
        depth_check: traceDepthCheck,
        depth_reprice: traceDepthReprice,
        explain,
        backfilled,
        backfillError,
    });
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
