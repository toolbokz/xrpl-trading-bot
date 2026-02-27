/**
 * GET /api/analytics/trade-diagnostics
 *
 * Returns post-trade diagnostics for the last N trades (default 10, max 2000).
 * Diagnostics are derived on read from the stored trade history — no separate
 * persistence is needed. The pure function `buildDiagnosticsForTrades` runs
 * over the trade array, sorts newest-first, and caps at `limit`.
 *
 * Query params:
 *   ?limit=10   — number of diagnostics to return (default 10, max 50)
 *   ?pair=XRP/RLUSD — optional pair filter
 *
 * Backfill: because diagnostics are computed on read, all existing historical
 * trades are automatically included — no migration step required.
 *
 * Live updates: the UI polls this endpoint; when OfferExecutor records a new
 * trade (or updates status via upsertTradeTrace), the next poll picks up the
 * change because WebTradeHistoryService uses mtime-based cache invalidation
 * on trade_history.json.
 */
import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { tradeHistory } from '../../../lib/tradeHistory';
import { buildDiagnosticsForTrades, type PostTradeDiagnostic, type DiagnosticTradeInput } from '../../../../analytics/postTradeDiagnostic';

export const config = {
    api: { bodyParser: false },
};

interface DiagnosticsResponse {
    diagnostics: PostTradeDiagnostic[];
    total: number;
    requestId?: string;
}

interface ErrorResponse {
    error: string;
    requestId?: string;
}

async function handler(
    req: LocalRequest,
    res: NextApiResponse<DiagnosticsResponse | ErrorResponse>,
): Promise<void> {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed', requestId: req.requestId });
    }

    try {
        const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 10;
        const limit = Math.max(1, Math.min(2000, Number.isFinite(rawLimit) ? rawLimit : 10));
        const pair = typeof req.query.pair === 'string' ? req.query.pair : undefined;

        // Fetch more trades than limit to guarantee we have enough after filtering
        const fetchCount = Math.max(limit * 2, 200);
        const trades = pair
            ? tradeHistory.getTradesByPair(pair, fetchCount)
            : tradeHistory.getRecentTrades(fetchCount);

        const diagnostics = buildDiagnosticsForTrades(trades as unknown as DiagnosticTradeInput[], limit);

        return res.status(200).json({
            diagnostics,
            total: trades.length,
            requestId: req.requestId,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to compute trade diagnostics';
        console.error('[API /analytics/trade-diagnostics] Error:', msg);
        return res.status(500).json({ error: msg, requestId: req.requestId });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'] });
