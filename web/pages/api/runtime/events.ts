/**
 * GET /api/runtime/events
 *
 * Returns structured observability events from the runtime event bus.
 *
 * Query params:
 *   ?limit=N        — max events to return (default: 50, max: 500)
 *   ?type=X         — filter by event type (e.g. FSM_TRANSITION, EXECUTION_BLOCKED)
 *   ?pairKey=X      — filter by pair key (e.g. XRP/RLUSD)
 *   ?afterSeq=N     — incremental polling: only events with seq > afterSeq
 *   ?startMs=N&endMs=N — time range filter for forensic replay
 *
 * Response shape:
 *   { requestId, seq, count, events[], summary }
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { getRuntimeInstance } from '../../../lib/runtimeBridge';
import type {
    ObservabilityEvent,
    ObservabilityEventType,
} from '../../../../src/observability/eventBus';
import { OBSERVABILITY_EVENT_TYPES } from '../../../../src/observability/eventBus';

interface EventsResponse {
    requestId: string;
    /** Current bus sequence number (for incremental polling). */
    seq: number;
    /** Number of events returned. */
    count: number;
    /** Filtered events. */
    events: ObservabilityEvent[];
    /** Event type summary (count per type in the full buffer). */
    summary: Record<string, number>;
}

function handler(req: LocalRequest, res: NextApiResponse<EventsResponse>) {
    const runtime = getRuntimeInstance();
    const bus = runtime?.getObservabilityBus();

    if (!bus) {
        return res.status(200).json({
            requestId: req.requestId,
            seq: 0,
            count: 0,
            events: [],
            summary: Object.fromEntries(
                OBSERVABILITY_EVENT_TYPES.map((t) => [t, 0]),
            ),
        });
    }

    const limit = Math.min(
        Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50),
        500,
    );
    const eventType = req.query.type as string | undefined;
    const pairKey = req.query.pairKey as string | undefined;
    const afterSeq = parseInt(String(req.query.afterSeq ?? ''), 10);
    const startMs = parseInt(String(req.query.startMs ?? ''), 10);
    const endMs = parseInt(String(req.query.endMs ?? ''), 10);

    let events: ObservabilityEvent[];

    if (Number.isFinite(afterSeq) && afterSeq >= 0) {
        // Incremental polling mode
        events = bus.getSince(afterSeq, limit);
    } else if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > 0 && endMs > 0) {
        // Forensic replay mode — time range
        events = bus.getTimeRange(startMs, endMs);
        if (events.length > limit) {
            events = events.slice(0, limit);
        }
    } else if (eventType && OBSERVABILITY_EVENT_TYPES.includes(eventType as ObservabilityEventType)) {
        // Filter by event type
        events = bus.getByType(eventType as ObservabilityEventType, limit);
    } else if (pairKey) {
        // Filter by pair key
        events = bus.getByPair(pairKey, limit);
    } else {
        // Default: most recent events (newest first)
        events = bus.getRecent(limit);
    }

    return res.status(200).json({
        requestId: req.requestId,
        seq: bus.getSeq(),
        count: events.length,
        events,
        summary: bus.getSummary(),
    });
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
