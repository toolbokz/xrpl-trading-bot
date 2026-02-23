/**
 * App Router request guard for localhost-only endpoints.
 *
 * Pages API routes use withLocalApi (socket-aware). App Router handlers
 * do not expose socket.remoteAddress, so this guard relies on host/proxy
 * headers plus optional LOCAL_API_TOKEN enforcement.
 */

export interface AppRouteGuardFailure {
    allowed: false;
    status: number;
    error: string;
    reason: string;
}

export interface AppRouteGuardSuccess {
    allowed: true;
}

export type AppRouteGuardResult = AppRouteGuardSuccess | AppRouteGuardFailure;

function isLocalhostHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    if (normalized.startsWith('localhost')) return true;
    if (normalized.startsWith('127.0.0.1')) return true;
    if (normalized.startsWith('[::1]')) return true;
    return false;
}

function isLocalIp(ip: string): boolean {
    const normalized = ip.trim().toLowerCase();
    if (normalized === '127.0.0.1' || normalized.startsWith('127.')) return true;
    if (normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
    if (normalized === 'localhost') return true;
    return false;
}

export function evaluateAppRouteGuard(
    headers: Headers,
    env: NodeJS.ProcessEnv = process.env,
): AppRouteGuardResult {
    const host = headers.get('host') ?? '';
    if (!host || !isLocalhostHost(host)) {
        return {
            allowed: false,
            status: 403,
            error: 'Remote access denied',
            reason: `Host ${host || 'unknown'} is not localhost`,
        };
    }

    const isDevMode = env.BOT_API_DEV_MODE === 'true';
    if (!isDevMode) {
        const forwardedFor = headers.get('x-forwarded-for');
        if (forwardedFor) {
            const firstIp = forwardedFor.split(',')[0]?.trim() ?? '';
            if (!firstIp || !isLocalIp(firstIp)) {
                return {
                    allowed: false,
                    status: 403,
                    error: 'Proxied requests not allowed',
                    reason: `x-forwarded-for indicates remote source: ${firstIp || 'unknown'}`,
                };
            }
        }

        const realIp = headers.get('x-real-ip');
        if (realIp && !isLocalIp(realIp)) {
            return {
                allowed: false,
                status: 403,
                error: 'Proxied requests not allowed',
                reason: `x-real-ip indicates remote source: ${realIp}`,
            };
        }
    }

    const requiredToken = env.LOCAL_API_TOKEN;
    if (typeof requiredToken === 'string' && requiredToken.length > 0) {
        const tokenHeader = headers.get('x-local-api-token');
        const authHeader = headers.get('authorization');
        const bearer = authHeader?.replace(/^Bearer\s+/i, '') ?? null;
        const providedToken = tokenHeader ?? bearer;
        if (!providedToken) {
            return {
                allowed: false,
                status: 401,
                error: 'Unauthorized',
                reason: 'LOCAL_API_TOKEN header required',
            };
        }
        if (providedToken !== requiredToken) {
            return {
                allowed: false,
                status: 401,
                error: 'Unauthorized',
                reason: 'Invalid LOCAL_API_TOKEN',
            };
        }
    }

    return { allowed: true };
}
