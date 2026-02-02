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

const DROPS_PER_XRP = 1_000_000;

/**
 * Fetch current network reserve requirements from server_state.
 * Returns base and owner reserve values in XRP.
 */
export async function getNetworkReserves(client: Client): Promise<{ baseReserveXRP: number; ownerReserveXRP: number }> {
    if (!client.isConnected()) {
        throw new Error('XRPL client not connected');
    }

    const response = await client.request({
        command: 'server_state',
    });

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
 */
export async function getAccountInfo(
    client: Client,
    account: string
): Promise<{ ownerCount: number; balanceXRP: number }> {
    if (!client.isConnected()) {
        throw new Error('XRPL client not connected');
    }

    const response = await client.request({
        command: 'account_info',
        account,
        ledger_index: 'validated',
    });

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
 * @returns Detailed reserve requirement including available balance
 */
export async function calculateReserveRequirement(
    client: Client,
    account: string,
    config?: ReserveConfig
): Promise<ReserveRequirement> {
    const [networkReserves, accountInfo] = await Promise.all([
        getNetworkReserves(client),
        getAccountInfo(client, account),
    ]);

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
 * @returns true if account has sufficient reserves
 */
export async function hasAdequateReserves(
    client: Client,
    account: string,
    minAvailableXRP: number = 0,
    config?: ReserveConfig
): Promise<{ adequate: boolean; requirement: ReserveRequirement }> {
    const requirement = await calculateReserveRequirement(client, account, config);

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
