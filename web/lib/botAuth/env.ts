/**
 * Environment configuration for bot API authentication.
 * All secrets stay server-side only.
 */

import type { Role } from './permissions';

export interface ApiKey {
    id: string;
    secret: string;
    role: Role;
    description?: string;
    allowedIps?: string[];
}

export interface BotAuthEnv {
    BOT_API_KEYS: ApiKey[];
    BOT_API_TTL_SECONDS: number;
    BOT_API_RATE_LIMIT_PER_MIN: number;
    BOT_API_ALLOWED_IPS: string[] | null;
    REDIS_URL?: string;
    PATH_ARB_ENABLED: boolean;
    PATH_ARB_DRY_RUN: boolean;
    PATH_ARB_MIN_EDGE_BPS: number;
    PATH_ARB_MAX_SLIPPAGE_BPS: number;
    PATH_ARB_MIN_PROFIT_XRP: number;
    PATH_ARB_MAX_TX_FEE_DROPS: number;
    PATH_ARB_CIRCUIT_BREAKER_FAILURES: number;
    PATH_ARB_CIRCUIT_BREAKER_WINDOW_MS: number;
    PATH_ARB_MIN_BALANCE_XRP: number;
}

function parseApiKeys(json: string | undefined): ApiKey[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((k: unknown): k is ApiKey => {
            if (typeof k !== 'object' || k === null) return false;
            const obj = k as Record<string, unknown>;
            return (
                typeof obj.id === 'string' &&
                obj.id.length >= 8 &&
                typeof obj.secret === 'string' &&
                obj.secret.length >= 32 &&
                (obj.role === 'admin' || obj.role === 'operator' || obj.role === 'readonly')
            );
        });
    } catch {
        console.error('[BotAuth] Invalid BOT_API_KEYS JSON');
        return [];
    }
}

function parseIpAllowlist(ips: string | undefined): string[] | null {
    if (!ips) return null;
    const list = ips.split(',').map((ip: string) => ip.trim()).filter(Boolean);
    return list.length > 0 ? list : null;
}

let cachedEnv: BotAuthEnv | null = null;

export function loadBotAuthEnv(): BotAuthEnv {
    if (cachedEnv) return cachedEnv;

    cachedEnv = {
        BOT_API_KEYS: parseApiKeys(process.env.BOT_API_KEYS),
        BOT_API_TTL_SECONDS: Number(process.env.BOT_API_TTL_SECONDS) || 60,
        BOT_API_RATE_LIMIT_PER_MIN: Number(process.env.BOT_API_RATE_LIMIT_PER_MIN) || 30,
        BOT_API_ALLOWED_IPS: parseIpAllowlist(process.env.BOT_API_ALLOWED_IPS),
        REDIS_URL: process.env.REDIS_URL,
        PATH_ARB_ENABLED: process.env.PATH_ARB_ENABLED === 'true',
        PATH_ARB_DRY_RUN: process.env.PATH_ARB_DRY_RUN !== 'false', // default true
        PATH_ARB_MIN_EDGE_BPS: Number(process.env.PATH_ARB_MIN_EDGE_BPS) || 10,
        PATH_ARB_MAX_SLIPPAGE_BPS: Number(process.env.PATH_ARB_MAX_SLIPPAGE_BPS) || 50,
        PATH_ARB_MIN_PROFIT_XRP: Number(process.env.PATH_ARB_MIN_PROFIT_XRP) || 0.1,
        PATH_ARB_MAX_TX_FEE_DROPS: Number(process.env.PATH_ARB_MAX_TX_FEE_DROPS) || 100000,
        PATH_ARB_CIRCUIT_BREAKER_FAILURES: Number(process.env.PATH_ARB_CIRCUIT_BREAKER_FAILURES) || 5,
        PATH_ARB_CIRCUIT_BREAKER_WINDOW_MS: Number(process.env.PATH_ARB_CIRCUIT_BREAKER_WINDOW_MS) || 300000,
        PATH_ARB_MIN_BALANCE_XRP: Number(process.env.PATH_ARB_MIN_BALANCE_XRP) || 50,
    };

    return cachedEnv;
}

export function getApiKeyById(keyId: string): ApiKey | undefined {
    const env = loadBotAuthEnv();
    return env.BOT_API_KEYS.find((k: ApiKey) => k.id === keyId);
}

export function clearEnvCache(): void {
    cachedEnv = null;
}
