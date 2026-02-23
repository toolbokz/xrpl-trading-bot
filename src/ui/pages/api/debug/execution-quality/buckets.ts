import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { tradeHistory, Trade } from '../../../../lib/tradeHistory';
import { explainOfferOutcome } from '../../../../../analytics/offerOutcomeExplainer';

export const config = {
    api: { bodyParser: false },
};

type FlagKey = 'IOC' | 'FOK' | 'PASSIVE';

interface SideCounts {
    BUY: number;
    SELL: number;
}

interface BucketsResponse {
    requestId: string;
    limit: number;
    totalTradesAnalyzed: number;
    buckets: Record<string, number>;
    flagsDecoded: Record<FlagKey, number>;
    sideByBucket: Record<string, SideCounts>;
    examplesByBucket: Record<string, string[]>;
}

interface ErrorResponse {
    requestId: string;
    error: string;
}

const DEFAULT_LIMIT = 500;
const MIN_LIMIT = 1;
const MAX_LIMIT = 5_000;
const MAX_EXAMPLES_PER_BUCKET = 20;
const FLAG_KEYS: FlagKey[] = ['IOC', 'FOK', 'PASSIVE'];

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

function parseLimit(rawValue: string | null): number {
    if (!rawValue) return DEFAULT_LIMIT;
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

function buildBucket(trade: Trade): string {
    const engineResultRaw = trade.trace?.submit_result?.engine_result;
    const engineResult = typeof engineResultRaw === 'string' && engineResultRaw.length > 0
        ? engineResultRaw
        : 'NONE';
    const explain = explainOfferOutcome({
        trace: trade.trace ?? null,
        side: trade.side,
    });
    const category = explain?.outcomeCategory ?? 'NONE';
    return `${engineResult}:${category}`;
}

function decodeExecutionFlags(trade: Trade): Set<FlagKey> {
    const decodedRaw = trade.trace?.offer_create?.flagsDecoded;
    if (!Array.isArray(decodedRaw)) return new Set();
    const normalized = decodedRaw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toUpperCase());
    return new Set(
        normalized.filter((entry): entry is FlagKey => (
            entry === 'IOC' || entry === 'FOK' || entry === 'PASSIVE'
        )),
    );
}

function hasTraceHash(trace: Trade['trace']): boolean {
    if (!trace) return false;
    return typeof trace.tx_hash === 'string' && trace.tx_hash.trim().length > 0;
}

function hasTraceSubmitTs(trace: Trade['trace']): boolean {
    if (!trace) return false;
    return typeof trace.submit_ts_ms === 'number' && Number.isFinite(trace.submit_ts_ms);
}

function hasTraceSubmitEngineResult(trace: Trade['trace']): boolean {
    if (!trace) return false;
    return typeof trace.submit_result?.engine_result === 'string' && trace.submit_result.engine_result.length > 0;
}

function isExecutionRelevantTrade(trade: Trade): boolean {
    if (trade.paper) return false;
    const trace = trade.trace;
    if (!trace) return false;

    const hasTxHash = hasTraceHash(trace);
    const hasSubmitTs = hasTraceSubmitTs(trace);
    const hasSubmitEngineResult = hasTraceSubmitEngineResult(trace);
    const hasOfferType = trace.tx_type === 'OfferCreate';
    const hasOfferIntent = trace.offer_create != null;

    const hasExecutionEvidence = hasTxHash || hasSubmitTs || hasSubmitEngineResult || hasOfferType || hasOfferIntent;
    if (!hasExecutionEvidence) return false;

    if (trade.status === 'PENDING' && !hasTxHash && !hasSubmitTs) {
        return false;
    }

    return true;
}

function handler(req: LocalRequest, res: NextApiResponse<BucketsResponse | ErrorResponse>): void {
    if (req.method !== 'GET') {
        res.status(405).json({
            requestId: req.requestId,
            error: 'Method not allowed',
        });
        return;
    }

    try {
        const limit = parseLimit(firstQueryValue(req.query.limit as string | string[] | undefined));
        const trades = tradeHistory
            .getRecentTrades(limit)
            .filter(isExecutionRelevantTrade);

        const buckets: Record<string, number> = {};
        const flagsDecoded: Record<FlagKey, number> = {
            IOC: 0,
            FOK: 0,
            PASSIVE: 0,
        };
        const sideByBucket: Record<string, SideCounts> = {};
        const examplesByBucket: Record<string, string[]> = {};

        for (const trade of trades) {
            const bucket = buildBucket(trade);
            buckets[bucket] = (buckets[bucket] ?? 0) + 1;

            const side = trade.side === 'SELL' ? 'SELL' : 'BUY';
            const bucketSideCounts = sideByBucket[bucket] ?? { BUY: 0, SELL: 0 };
            bucketSideCounts[side] += 1;
            sideByBucket[bucket] = bucketSideCounts;

            const examples = examplesByBucket[bucket] ?? [];
            if (typeof trade.id === 'string' && trade.id.length > 0 && examples.length < MAX_EXAMPLES_PER_BUCKET) {
                examples.push(trade.id);
            }
            examplesByBucket[bucket] = examples;

            const decodedFlags = decodeExecutionFlags(trade);
            for (const flag of FLAG_KEYS) {
                if (decodedFlags.has(flag)) {
                    flagsDecoded[flag] += 1;
                }
            }
        }

        res.status(200).json({
            requestId: req.requestId,
            limit,
            totalTradesAnalyzed: trades.length,
            buckets,
            flagsDecoded,
            sideByBucket,
            examplesByBucket,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to compute execution quality buckets';
        res.status(500).json({
            requestId: req.requestId,
            error: message,
        });
    }
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
