export type ExecutionOrderType = 'IOC' | 'FOK';
export type ExecutionOrderFlags = {
    immediateOrCancel?: boolean;
    fillOrKill?: boolean;
};

const DEFAULT_EXECUTION_ORDER_TYPE: ExecutionOrderType = 'IOC';

/**
 * Resolve execution order type from environment.
 * Allowed values: IOC | FOK (case-insensitive).
 */
export function getExecutionOrderType(): ExecutionOrderType {
    const raw = (process.env.EXECUTION_ORDER_TYPE || '').trim().toUpperCase();
    if (raw === 'FOK') return 'FOK';
    if (raw === 'IOC') return 'IOC';
    return DEFAULT_EXECUTION_ORDER_TYPE;
}

/**
 * Map execution order type to OfferCreate flags.
 */
export function getExecutionOrderFlags(): ExecutionOrderFlags {
    const orderType = getExecutionOrderType();
    return orderType === 'FOK'
        ? { fillOrKill: true }
        : { immediateOrCancel: true };
}
