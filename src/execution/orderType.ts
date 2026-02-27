import { isStrictConfigEnabled } from '../config/featureFlags';

export type ExecutionOrderType = 'IOC' | 'FOK' | 'RESTING' | 'SMART';
export type ExecutionOrderFlags = {
    immediateOrCancel?: boolean;
    fillOrKill?: boolean;
    passive?: boolean;
};

export interface ExecutionMode {
    orderType: ExecutionOrderType;
    resolvedOrderType: 'IOC' | 'FOK';
    minFillRatio: number;
    flags: ExecutionOrderFlags;
}

const DEFAULT_EXECUTION_ORDER_TYPE: ExecutionOrderType = 'IOC';
const DEFAULT_IOC_MIN_FILL_RATIO = 0.5;

function parseExecutionOrderType(env: NodeJS.ProcessEnv): ExecutionOrderType {
    const raw = (env.EXECUTION_ORDER_TYPE || '').trim().toUpperCase();
    if (raw === 'FOK') return 'FOK';
    if (raw === 'RESTING') return 'RESTING';
    if (raw === 'SMART') return 'SMART';
    if (raw === 'IOC') return 'IOC';
    return DEFAULT_EXECUTION_ORDER_TYPE;
}

function parseConfiguredMinFillRatio(env: NodeJS.ProcessEnv): number | null {
    const raw = env.EXECUTION_MIN_FILL_RATIO ?? env.EXECUTION_IOC_MIN_FILL_RATIO;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return Math.max(0.05, Math.min(1, parsed));
}

function resolveCanonicalOrderType(orderType: ExecutionOrderType): 'IOC' | 'FOK' {
    if (orderType === 'FOK') return 'FOK';
    return 'IOC';
}

export function getExecutionMode(env: NodeJS.ProcessEnv = process.env): ExecutionMode {
    const orderType = parseExecutionOrderType(env);
    const resolvedOrderType = resolveCanonicalOrderType(orderType);
    const configuredMinFillRatio = parseConfiguredMinFillRatio(env);
    const strictEnabled = isStrictConfigEnabled(env);

    let minFillRatio = configuredMinFillRatio ?? (resolvedOrderType === 'FOK' ? 1 : DEFAULT_IOC_MIN_FILL_RATIO);
    if (resolvedOrderType === 'FOK' && Math.abs(minFillRatio - 1) > 1e-12) {
        if (strictEnabled) {
            throw new Error('Invalid execution mode: FOK requires EXECUTION_MIN_FILL_RATIO=1.0');
        }
        minFillRatio = 1;
    }

    const flags: ExecutionOrderFlags = resolvedOrderType === 'FOK'
        ? { fillOrKill: true }
        : { immediateOrCancel: true };

    return {
        orderType,
        resolvedOrderType,
        minFillRatio,
        flags,
    };
}

/**
 * Resolve execution order type from environment.
 * Allowed values: IOC | FOK | RESTING | SMART (case-insensitive).
 */
export function getExecutionOrderType(env: NodeJS.ProcessEnv = process.env): ExecutionOrderType {
    return getExecutionMode(env).orderType;
}

export function getExecutionMinFillRatio(env: NodeJS.ProcessEnv = process.env): number {
    return getExecutionMode(env).minFillRatio;
}

/**
 * Map execution order type to OfferCreate flags.
 */
export function getExecutionOrderFlags(env: NodeJS.ProcessEnv = process.env): ExecutionOrderFlags {
    return getExecutionMode(env).flags;
}
