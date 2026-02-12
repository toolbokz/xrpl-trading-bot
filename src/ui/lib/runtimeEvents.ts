interface RuntimeEventLike {
    eventType?: unknown;
}

export function hasOrderFilledEvent(events: unknown[]): boolean {
    return events.some((event) => {
        if (!event || typeof event !== 'object') return false;
        const maybeEvent = event as RuntimeEventLike;
        return maybeEvent.eventType === 'ORDER_FILLED';
    });
}
