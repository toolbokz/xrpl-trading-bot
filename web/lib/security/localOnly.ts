import type { NextApiRequest, NextApiResponse } from 'next';

export class RemoteAccessDeniedError extends Error {
    constructor(reason: string) {
        super(`Remote access disabled. ${reason}`);
        this.name = 'RemoteAccessDeniedError';
    }
}

export function isCloudEnvironment(): string | null {
    if (process.env.VERCEL || process.env.VERCEL_ENV || process.env.NOW_REGION || process.env.VERCEL_URL) {
        return 'Vercel';
    }
    if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV || process.env.AWS_REGION) {
        return 'AWS';
    }
    if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT) {
        return 'Google Cloud Platform';
    }
    if (process.env.KUBERNETES_SERVICE_HOST) {
        return 'Kubernetes';
    }
    return null;
}

export function isLocalhostIp(ip: string | undefined): boolean {
    if (!ip) return false;
    const normalized = ip.trim().toLowerCase();
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

export function getClientIpInfo(req: NextApiRequest): {
    remoteAddress: string | undefined;
    forwardedFor?: string;
    realIp?: string;
    proxyDetected: boolean;
} {
    const remoteAddress = req.socket?.remoteAddress;
    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];

    const forwardedFor = Array.isArray(forwarded)
        ? forwarded[0]
        : forwarded;

    const normalizedRealIp = Array.isArray(realIp)
        ? realIp[0]
        : realIp;

    return {
        remoteAddress,
        ...(forwardedFor ? { forwardedFor } : {}),
        ...(normalizedRealIp ? { realIp: normalizedRealIp } : {}),
        proxyDetected: !!forwardedFor || !!normalizedRealIp,
    };
}

export interface LocalOnlyConfig {
    allowRemote: boolean;
    forceLocalOnly: boolean;
    isProduction: boolean;
    cloudPlatform: string | null;
}

export function loadLocalOnlyConfig(): LocalOnlyConfig {
    return {
        allowRemote: process.env.BOT_ALLOW_REMOTE === 'true',
        forceLocalOnly: process.env.BOT_LOCAL_ONLY === 'true',
        isProduction: process.env.NODE_ENV === 'production',
        cloudPlatform: isCloudEnvironment(),
    };
}

export interface LocalhostCheckResult {
    allowed: boolean;
    reason?: string;
    remoteAddress?: string;
    proxyDetected: boolean;
}

export function validateLocalhostRequest(req: NextApiRequest): LocalhostCheckResult {
    const config = loadLocalOnlyConfig();
    const clientInfo = getClientIpInfo(req);

    if (config.allowRemote) {
        return {
            allowed: true,
            reason: 'BOT_ALLOW_REMOTE override',
            remoteAddress: clientInfo.remoteAddress,
            proxyDetected: clientInfo.proxyDetected,
        };
    }

    if (config.cloudPlatform) {
        return {
            allowed: false,
            reason: `Remote access disabled: Cloud platform ${config.cloudPlatform}`,
            remoteAddress: clientInfo.remoteAddress,
            proxyDetected: clientInfo.proxyDetected,
        };
    }

    if (clientInfo.proxyDetected) {
        return {
            allowed: false,
            reason: 'Remote access disabled: Proxy headers detected',
            remoteAddress: clientInfo.remoteAddress,
            proxyDetected: true,
        };
    }

    if (!isLocalhostIp(clientInfo.remoteAddress)) {
        return {
            allowed: false,
            reason: `Remote access disabled: Non-localhost IP ${clientInfo.remoteAddress ?? 'unknown'}`,
            remoteAddress: clientInfo.remoteAddress,
            proxyDetected: false,
        };
    }

    return {
        allowed: true,
        remoteAddress: clientInfo.remoteAddress,
        proxyDetected: false,
    };
}

export function enforceLocalhostRequest(
    req: NextApiRequest,
    _res?: NextApiResponse,
): { error: string; reason: string; remoteAddress?: string; status: 403 } | null {
    const result = validateLocalhostRequest(req);
    if (result.allowed) {
        return null;
    }

    console.warn('[Security] Remote access blocked:', {
        reason: result.reason,
        remoteAddress: result.remoteAddress,
        isProxied: result.proxyDetected,
        path: req.url,
        method: req.method,
    });

    return {
        error: 'Remote access disabled',
        reason: result.reason ?? 'Remote access disabled',
        remoteAddress: result.remoteAddress,
        status: 403,
    };
}

export function validateServerStartup(): { allowed: boolean; reason: string } {
    const config = loadLocalOnlyConfig();

    if (config.allowRemote) {
        return { allowed: true, reason: 'BOT_ALLOW_REMOTE override' };
    }

    if (config.cloudPlatform) {
        return {
            allowed: false,
            reason: `Cloud platform detected: ${config.cloudPlatform}`,
        };
    }

    if (config.isProduction && !config.forceLocalOnly) {
        return {
            allowed: false,
            reason: 'Production mode requires BOT_LOCAL_ONLY=true',
        };
    }

    return { allowed: true, reason: 'Local execution allowed' };
}
