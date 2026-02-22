import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockReq {
    method: string;
    query: Record<string, string>;
    requestId: string;
}

interface MockRes {
    statusCode: number;
    body: any;
    status: (code: number) => MockRes;
    json: (payload: any) => MockRes;
}

function createMockReq(query: Record<string, string> = {}): MockReq {
    return {
        method: 'GET',
        query,
        requestId: `req-${Date.now()}`,
    };
}

function createMockRes(): MockRes {
    const res: MockRes = {
        statusCode: 0,
        body: null,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(payload: any) {
            res.body = payload;
            return res;
        },
    };
    return res;
}

async function loadHandlerWithBus(bus: { getObservabilityBus: () => unknown }) {
    vi.doMock('../../../../lib/runtimeBridge', () => ({
        getRuntimeInstance: () => bus,
    }));
    vi.doMock('../../../../lib/localApi', () => ({
        withLocalApi: (handler: Function) => handler,
    }));
    return (await import('../events')).default;
}

describe.sequential('/api/runtime/events filters', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('filters by eventTypePrefix before applying limit', async () => {
        const { ObservabilityBus } = await import('../../../../../observability/eventBus');
        const bus = new ObservabilityBus({ maxEvents: 500, dedupIntervalMs: 0 });

        bus.emit({ eventType: 'SUBMIT_ATTEMPT', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });
        bus.emit({ eventType: 'SUBMIT_SUCCESS', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });
        bus.emit({ eventType: 'SUBMIT_FAIL', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });

        for (let i = 0; i < 120; i += 1) {
            bus.emit({
                eventType: 'FAIR_VALUE_UPDATED',
                pairKey: 'XRP/RLUSD',
                runtimeState: 'READY',
                detail: { idx: i },
            });
        }

        const eventsHandler = await loadHandlerWithBus({
            getObservabilityBus: () => bus,
        });
        const req = createMockReq({ eventTypePrefix: 'SUBMIT_', limit: '2' }) as any;
        const res = createMockRes() as any;
        eventsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.events.map((event: any) => event.eventType)).toEqual(['SUBMIT_FAIL', 'SUBMIT_SUCCESS']);
    });

    it('supports comma-separated eventType exact-match filtering', async () => {
        const { ObservabilityBus } = await import('../../../../../observability/eventBus');
        const bus = new ObservabilityBus({ maxEvents: 200, dedupIntervalMs: 0 });

        bus.emit({ eventType: 'SUBMIT_ATTEMPT', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });
        bus.emit({ eventType: 'SUBMIT_SUCCESS', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });
        bus.emit({ eventType: 'ORDER_PLACED', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });
        bus.emit({ eventType: 'SUBMIT_FAIL', pairKey: 'XRP/RLUSD', runtimeState: 'READY', detail: {} });

        const eventsHandler = await loadHandlerWithBus({
            getObservabilityBus: () => bus,
        });
        const req = createMockReq({ eventType: 'SUBMIT_SUCCESS,SUBMIT_FAIL', limit: '10' }) as any;
        const res = createMockRes() as any;
        eventsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.events.map((event: any) => event.eventType)).toEqual(['SUBMIT_FAIL', 'SUBMIT_SUCCESS']);
    });

    it('filters by correlationId with lifecycle prefixes', async () => {
        const { ObservabilityBus } = await import('../../../../../observability/eventBus');
        const bus = new ObservabilityBus({ maxEvents: 200, dedupIntervalMs: 0 });

        bus.emit({
            eventType: 'ORDER_PLACED',
            pairKey: 'XRP/RLUSD',
            runtimeState: 'READY',
            correlationId: 'trade-a',
            detail: { marker: 'order-placed-a' },
        });
        bus.emit({
            eventType: 'ORDER_FILLED',
            pairKey: 'XRP/RLUSD',
            runtimeState: 'READY',
            correlationId: 'trade-b',
            detail: { marker: 'order-filled-b' },
        });
        bus.emit({
            eventType: 'ORDER_FILLED',
            pairKey: 'XRP/RLUSD',
            runtimeState: 'READY',
            correlationId: 'trade-a',
            detail: { marker: 'order-filled-a' },
        });

        const eventsHandler = await loadHandlerWithBus({
            getObservabilityBus: () => bus,
        });
        const req = createMockReq({
            eventTypePrefix: 'ORDER_',
            correlationId: 'trade-a',
            limit: '10',
        }) as any;
        const res = createMockRes() as any;
        eventsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.events).toHaveLength(2);
        expect(res.body.events.every((event: any) => event.correlationId === 'trade-a')).toBe(true);
        expect(res.body.events.every((event: any) => String(event.eventType).startsWith('ORDER_'))).toBe(true);
    });
});
