/**
 * GET /api/runtime/events
 *
 * Returns structured observability events from the runtime event bus.
 *
 * Query params:
 *   ?limit=N        — max events to return (default: 50, max: 500)
 *   ?type=X         — legacy alias for eventType
 *   ?eventType=X    — exact event type or comma-separated list
 *   ?eventTypePrefix=SUBMIT_ — prefix filter (e.g. SUBMIT_, ORDER_)
 *   ?correlationId=X — exact correlationId match
 *   ?pairKey=X      — filter by pair key (e.g. XRP/RLUSD)
 *   ?afterSeq=N     — incremental polling: only events with seq > afterSeq
 *   ?startMs=N&endMs=N — time range filter for forensic replay
 *
 * Response shape:
 *   { requestId, seq, count, events[], summary }
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { getRuntimeInstance } from '../../../lib/runtimeBridge';
import type {
    ObservabilityEvent,
    ObservabilityEventType,
} from '../../../../observability/eventBus';
import { OBSERVABILITY_EVENT_TYPES } from '../../../../observability/eventBus';

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

function firstQueryValue(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
    return undefined;
}

function parseEventTypeList(value: string | undefined): {
    provided: boolean;
    values: Set<ObservabilityEventType>;
} {
    const raw = (value ?? '').trim();
    if (!raw) return { provided: false, values: new Set<ObservabilityEventType>() };
    const split = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    const allowed = new Set<ObservabilityEventType>();
    for (const entry of split) {
        if (OBSERVABILITY_EVENT_TYPES.includes(entry as ObservabilityEventType)) {
            allowed.add(entry as ObservabilityEventType);
        }
    }
    return { provided: true, values: allowed };
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
    const rawEventType = firstQueryValue(
        (req.query.eventType as string | string[] | undefined)
        ?? (req.query.type as string | string[] | undefined),
    );
    const eventTypeFilter = parseEventTypeList(rawEventType);
    const eventTypePrefix = firstQueryValue(req.query.eventTypePrefix as string | string[] | undefined)?.trim();
    const correlationId = firstQueryValue(req.query.correlationId as string | string[] | undefined)?.trim();
    const pairKey = firstQueryValue(req.query.pairKey as string | string[] | undefined)?.trim();
    const afterSeq = parseInt(String(req.query.afterSeq ?? ''), 10);
    const startMs = parseInt(String(req.query.startMs ?? ''), 10);
    const endMs = parseInt(String(req.query.endMs ?? ''), 10);

    let events: ObservabilityEvent[];
    const scanLimit = Math.max(bus.getCount(), limit);

    if (Number.isFinite(afterSeq) && afterSeq >= 0) {
        // Incremental polling mode
        events = bus.getSince(afterSeq, scanLimit);
    } else if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > 0 && endMs > 0) {
        // Forensic replay mode — time range
        events = bus.getTimeRange(startMs, endMs);
    } else {
        // Default: most recent events (newest first)
        events = bus.getRecent(scanLimit);
    }

    if (pairKey) {
        events = events.filter((event) => event.pairKey === pairKey);
    }

    if (eventTypeFilter.provided) {
        events = events.filter((event) => eventTypeFilter.values.has(event.eventType));
    }

    if (eventTypePrefix && eventTypePrefix.length > 0) {
        events = events.filter((event) => event.eventType.startsWith(eventTypePrefix));
    }

    if (correlationId && correlationId.length > 0) {
        events = events.filter((event) => event.correlationId === correlationId);
    }

    if (events.length > limit) {
        events = events.slice(0, limit);
    }

    return res.status(200).json({
        requestId: req.requestId,
        seq: bus.getSeq(),
        count: events.length,
        events,
        summary: bus.getSummary(),
    });
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
