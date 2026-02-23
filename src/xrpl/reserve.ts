/**
 * Dynamic XRPL reserve calculation.
 * 
 * XRPL reserves are computed as:
 *   required = baseReserve + (ownerCount * ownerReserve)
 * 
 * Where:
 *   - baseReserve: Minimum XRP to activate an account (currently 10 XRP)
 *   - ownerReserve: Per-owned-object reserve (currently 2 XRP)
 *   - ownerCount: Number of objects the account owns (trustlines, offers, etc.)
 * 
 * This module fetches live values from the network rather than hardcoding.
 */

import type { Client } from 'xrpl';
import { logger } from '../analytics/logger';
import { isAuditGuardsEnabled } from '../config/featureFlags';

export interface ReserveRequirement {
    /** Base reserve in XRP (account activation cost) */
    baseReserveXRP: number;
    /** Per-owner reserve in XRP (each owned object) */
    ownerReserveXRP: number;
    /** Current owner count for the account */
    ownerCount: number;
    /** Total required reserve in XRP */
    requiredXRP: number;
    /** Available balance after reserve in XRP */
    availableXRP: number;
    /** Total account balance in XRP */
    balanceXRP: number;
}

export interface ReserveConfig {
    /** Additional buffer in basis points (100 = 1%) over required reserve */
    bufferBps?: number | undefined;
    /** Additional fixed buffer in XRP over required reserve */
    bufferXRP?: number | undefined;
}

export type ReserveErrorCode =
    | 'RESERVE_TIMEOUT'
    | 'XRPL_DISCONNECTED'
    | 'MALFORMED_RESPONSE'
    | 'REQUEST_FAILED';

export interface ReserveErrorClassification {
    code: ReserveErrorCode;
    retryable: boolean;
    message: string;
}

const DROPS_PER_XRP = 1_000_000;

function resolveReserveRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const parsed = Number.parseInt(env.XRPL_RESERVE_REQUEST_TIMEOUT_MS ?? '', 10);
    if (!Number.isFinite(parsed)) return 4_000;
    return Math.max(500, parsed);
}

export function classifyReserveError(err: unknown): ReserveErrorClassification {
    if (err instanceof Error) {
        if (err.name === 'ReserveRequestTimeoutError' || err.message.includes('reserve-timeout')) {
            return {
                code: 'RESERVE_TIMEOUT',
                retryable: true,
                message: err.message,
            };
        }
        if (err.message.includes('client not connected')) {
            return {
                code: 'XRPL_DISCONNECTED',
                retryable: true,
                message: err.message,
            };
        }
        if (err.message.includes('Unable to fetch reserve values') || err.message.includes('Account not found')) {
            return {
                code: 'MALFORMED_RESPONSE',
                retryable: false,
                message: err.message,
            };
        }
        return {
            code: 'REQUEST_FAILED',
            retryable: true,
            message: err.message,
        };
    }

    return {
        code: 'REQUEST_FAILED',
        retryable: true,
        message: String(err),
    };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, command: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const timeoutError = new Error(`reserve-timeout:${command}:${timeoutMs}ms`);
            timeoutError.name = 'ReserveRequestTimeoutError';
            reject(timeoutError);
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function requestWithOptionalTimeout<T>(
    client: Client,
    request: Parameters<Client['request']>[0],
    command: string,
): Promise<T> {
    const reqPromise = client.request(request) as Promise<T>;
    if (!isAuditGuardsEnabled()) {
        return reqPromise;
    }

    const timeoutMs = resolveReserveRequestTimeoutMs();
    return withTimeout(reqPromise, timeoutMs, command);
}

/**
 * Fetch current network reserve requirements from server_state.
 * Returns base and owner reserve values in XRP, or null if client is not connected.
 */
export async function getNetworkReserves(client: Client): Promise<{ baseReserveXRP: number; ownerReserveXRP: number } | null> {
    if (!client.isConnected()) {
        logger.debug('XRPL client not connected, skipping reserve check');
        return null;
    }

    const response = await requestWithOptionalTimeout<Awaited<ReturnType<Client['request']>>>(client, {
        command: 'server_state',
    }, 'server_state');

    const state = response.result?.state;
    if (!state?.validated_ledger?.reserve_base || !state?.validated_ledger?.reserve_inc) {
        throw new Error('Unable to fetch reserve values from server_state');
    }

    const baseReserveDrops = state.validated_ledger.reserve_base;
    const ownerReserveDrops = state.validated_ledger.reserve_inc;

    return {
        baseReserveXRP: baseReserveDrops / DROPS_PER_XRP,
        ownerReserveXRP: ownerReserveDrops / DROPS_PER_XRP,
    };
}

/**
 * Fetch account info including owner count and balance.
 * Returns null if client is not connected.
 */
export async function getAccountInfo(
    client: Client,
    account: string
): Promise<{ ownerCount: number; balanceXRP: number } | null> {
    if (!client.isConnected()) {
        logger.debug('XRPL client not connected, skipping account info fetch');
        return null;
    }

    const response = await requestWithOptionalTimeout<Awaited<ReturnType<Client['request']>>>(client, {
        command: 'account_info',
        account,
        ledger_index: 'validated',
    }, 'account_info');

    const accountData = response.result?.account_data;
    if (!accountData) {
        throw new Error(`Account not found: ${account}`);
    }

    return {
        ownerCount: accountData.OwnerCount || 0,
        balanceXRP: Number(accountData.Balance) / DROPS_PER_XRP,
    };
}

/**
 * Calculate full reserve requirement for an account.
 * 
 * @param client - Connected XRPL client
 * @param account - Account address
 * @param config - Optional buffer configuration
 * @returns Detailed reserve requirement including available balance, or null if client not connected
 */
export async function calculateReserveRequirement(
    client: Client,
    account: string,
    config?: ReserveConfig
): Promise<ReserveRequirement | null> {
    const [networkReserves, accountInfo] = await Promise.all([
        getNetworkReserves(client),
        getAccountInfo(client, account),
    ]);

    // If client disconnected during fetch, return null to skip this tick
    if (!networkReserves || !accountInfo) {
        return null;
    }

    const { baseReserveXRP, ownerReserveXRP } = networkReserves;
    const { ownerCount, balanceXRP } = accountInfo;

    // Base requirement: baseReserve + (ownerCount * ownerReserve)
    let requiredXRP = baseReserveXRP + (ownerCount * ownerReserveXRP);

    // Apply buffer if configured
    if (config?.bufferBps && config.bufferBps > 0) {
        requiredXRP += requiredXRP * (config.bufferBps / 10_000);
    }
    if (config?.bufferXRP && config.bufferXRP > 0) {
        requiredXRP += config.bufferXRP;
    }

    const availableXRP = Math.max(0, balanceXRP - requiredXRP);

    return {
        baseReserveXRP,
        ownerReserveXRP,
        ownerCount,
        requiredXRP,
        availableXRP,
        balanceXRP,
    };
}

/**
 * Check if account has sufficient reserves for trading.
 * 
 * @param client - Connected XRPL client
 * @param account - Account address
 * @param minAvailableXRP - Minimum available balance after reserves (default: 0)
 * @param config - Optional buffer configuration
 * @returns Object with adequate flag and requirement, or { adequate: true, requirement: null } if client not connected (skip tick)
 */
export async function hasAdequateReserves(
    client: Client,
    account: string,
    minAvailableXRP: number = 0,
    config?: ReserveConfig
): Promise<{ adequate: boolean; requirement: ReserveRequirement | null; skipped?: boolean }> {
    const requirement = await calculateReserveRequirement(client, account, config);

    // If client disconnected, skip this tick but don't trigger shutdown
    if (!requirement) {
        logger.debug({ account }, 'Skipping reserve check - client not connected');
        return { adequate: true, requirement: null, skipped: true };
    }

    const adequate = requirement.availableXRP >= minAvailableXRP;

    if (!adequate) {
        logger.warn({
            account,
            balanceXRP: requirement.balanceXRP,
            requiredXRP: requirement.requiredXRP,
            availableXRP: requirement.availableXRP,
            minAvailableXRP,
            ownerCount: requirement.ownerCount,
        }, 'Insufficient reserves for trading');
    } else {
        logger.debug({
            account,
            availableXRP: requirement.availableXRP,
            requiredXRP: requirement.requiredXRP,
        }, 'Reserve check passed');
    }

    return { adequate, requirement };
}

/**
 * Load reserve config from environment variables.
 */
export function loadReserveConfig(): ReserveConfig {
    const bufferBps = Number(process.env.RESERVE_BUFFER_BPS) || 0;
    const bufferXRP = Number(process.env.RESERVE_BUFFER_XRP) || 0;

    return {
        bufferBps: bufferBps > 0 ? bufferBps : undefined,
        bufferXRP: bufferXRP > 0 ? bufferXRP : undefined,
    };
}
