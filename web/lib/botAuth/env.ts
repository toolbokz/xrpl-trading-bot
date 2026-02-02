/**
 * Environment configuration for bot API authentication.
 * All secrets stay server-side only.
 * 
 * BOT_API_KEYS must be a JSON string array:
 * BOT_API_KEYS='[{"id":"admin-key-01","secret":"64-char-hex","role":"admin"}]'
 */

import type { Role } from './permissions';

export interface ApiKey {
    id: string;
    secret: string;
    role: Role;
    description?: string | undefined;
    allowedIps?: string[] | undefined;
}

export interface BotAuthEnv {
    BOT_API_KEYS: ApiKey[];
    BOT_API_TTL_SECONDS: number;
    BOT_API_RATE_LIMIT_PER_MIN: number;
    BOT_API_ALLOWED_IPS: string[] | null;
    REDIS_URL?: string | undefined;
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

/** Validation errors for BOT_API_KEYS */
export class ApiKeyConfigError extends Error {
    constructor(message: string) {
        super(`[BotAuth] BOT_API_KEYS configuration error: ${message}`);
        this.name = 'ApiKeyConfigError';
    }
}

/**
 * Validates a single API key object.
 * Returns validation error message or null if valid.
 */
function validateApiKey(key: unknown, index: number): string | null {
    if (typeof key !== 'object' || key === null) {
        return `Key at index ${index} must be an object`;
    }
    const obj = key as Record<string, unknown>;

    // ID must be at least 6 chars (trimmed)
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (id.length < 6) {
        return `Key at index ${index}: 'id' must be a string with at least 6 characters (after trimming)`;
    }
    if (typeof obj.secret !== 'string' || obj.secret.length < 32) {
        return `Key at index ${index}: 'secret' must be a string with at least 32 characters`;
    }
    if (!/^[0-9a-fA-F]+$/.test(obj.secret)) {
        return `Key at index ${index}: 'secret' must be a hex string`;
    }
    if (obj.role !== 'admin' && obj.role !== 'operator' && obj.role !== 'readonly') {
        return `Key at index ${index}: 'role' must be 'admin', 'operator', or 'readonly'`;
    }
    return null;
}

/**
 * Parse and validate BOT_API_KEYS from environment.
 * FAILS FAST: throws ApiKeyConfigError if format is invalid.
 * 
 * Expected format: JSON array of objects with id, secret, role
 * Example: '[{"id":"admin-key-01","secret":"64charhex...","role":"admin"}]'
 */
function parseApiKeys(json: string | undefined): ApiKey[] {
    if (!json || json.trim() === '') {
        // No keys configured - this is a valid (but warn-worthy) state for development
        console.warn('[BotAuth] BOT_API_KEYS not configured - all API auth will fail');
        return [];
    }

    // Detect common misconfiguration: raw hex string instead of JSON array
    if (/^[0-9a-fA-F]+$/.test(json.trim())) {
        throw new ApiKeyConfigError(
            'BOT_API_KEYS appears to be a raw hex string. ' +
            'It must be a JSON array: \'[{"id":"key-id","secret":"your-hex-secret","role":"admin"}]\''
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (err) {
        throw new ApiKeyConfigError(
            `Failed to parse JSON: ${err instanceof Error ? err.message : 'Invalid JSON'}. ` +
            'Format must be: \'[{"id":"key-id","secret":"hex-secret","role":"admin|operator|readonly"}]\''
        );
    }

    if (!Array.isArray(parsed)) {
        throw new ApiKeyConfigError(
            'BOT_API_KEYS must be a JSON array, got: ' + typeof parsed
        );
    }

    if (parsed.length === 0) {
        console.warn('[BotAuth] BOT_API_KEYS is an empty array - all API auth will fail');
        return [];
    }

    // Validate each key
    const validatedKeys: ApiKey[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < parsed.length; i++) {
        const error = validateApiKey(parsed[i], i);
        if (error) {
            throw new ApiKeyConfigError(error);
        }
        const key = parsed[i] as Record<string, unknown>;
        const normalizedId = (key.id as string).trim();

        // Check for duplicate IDs (case-sensitive, trimmed)
        if (seenIds.has(normalizedId)) {
            throw new ApiKeyConfigError(
                `Duplicate API key ID '${normalizedId}' at index ${i}. Each key must have a unique ID.`
            );
        }
        seenIds.add(normalizedId);

        validatedKeys.push({
            id: normalizedId,
            secret: key.secret as string,
            role: key.role as Role,
            description: typeof key.description === 'string' ? key.description : undefined,
            allowedIps: Array.isArray(key.allowedIps) ? key.allowedIps.filter(ip => typeof ip === 'string') : undefined,
        });
    }

    console.log(`[BotAuth] Loaded ${validatedKeys.length} API key(s): ${validatedKeys.map(k => k.id).join(', ')}`);
    return validatedKeys;
}

function parseIpAllowlist(ips: string | undefined): string[] | null {
    if (!ips) return null;
    const list = ips.split(',').map((ip: string) => ip.trim()).filter(Boolean);
    return list.length > 0 ? list : null;
}

let cachedEnv: BotAuthEnv | null = null;

export function loadBotAuthEnv(): BotAuthEnv {
    if (cachedEnv) return cachedEnv;

    const env: BotAuthEnv = {
        BOT_API_KEYS: parseApiKeys(process.env.BOT_API_KEYS),
        BOT_API_TTL_SECONDS: Number(process.env.BOT_API_TTL_SECONDS) || 60,
        BOT_API_RATE_LIMIT_PER_MIN: Number(process.env.BOT_API_RATE_LIMIT_PER_MIN) || 30,
        BOT_API_ALLOWED_IPS: parseIpAllowlist(process.env.BOT_API_ALLOWED_IPS),
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

    if (process.env.REDIS_URL) {
        env.REDIS_URL = process.env.REDIS_URL;
    }

    cachedEnv = env;
    return cachedEnv;
}

export function getApiKeyById(keyId: string): ApiKey | undefined {
    const env = loadBotAuthEnv();
    return env.BOT_API_KEYS.find((k: ApiKey) => k.id === keyId);
}

export function clearEnvCache(): void {
    cachedEnv = null;
}
