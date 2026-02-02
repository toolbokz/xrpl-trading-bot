/**
 * Localhost Safety Guard
 * 
 * This module ensures the trading bot can ONLY run on localhost.
 * Remote execution is completely blocked for security.
 * 
 * The bot handles real funds and wallet seeds - it must never be
 * exposed to the internet or run on cloud infrastructure.
 */

import os from 'os';
import fs from 'fs';

export class RemoteExecutionBlockedError extends Error {
    constructor(reason: string) {
        super(`Remote execution is disabled. ${reason}. This bot is locked to localhost for safety.`);
        this.name = 'RemoteExecutionBlockedError';
    }
}

export class CloudExecutionBlockedError extends Error {
    constructor(platform: string) {
        super(`Cloud execution blocked on ${platform}. This bot is restricted to local machines only.`);
        this.name = 'CloudExecutionBlockedError';
    }
}

export interface LocalOnlyConfig {
    /** Allow remote access (DANGEROUS - for advanced users only) */
    allowRemote: boolean;
    /** Force local-only mode */
    forceLocalOnly: boolean;
    /** Current NODE_ENV */
    nodeEnv: string;
    /** Detected cloud platform (if any) */
    cloudPlatform: string | null;
    /** Whether running in a container */
    isContainer: boolean;
    /** Local hostname */
    hostname: string;
    /** Bound network interfaces */
    networkInterfaces: string[];
}

/**
 * Detect if running on a cloud platform.
 * Returns the platform name or null if local.
 */
export function detectCloudPlatform(): string | null {
    // Vercel
    if (process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL) {
        return 'Vercel';
    }

    // AWS
    if (process.env.AWS_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV) {
        return 'AWS';
    }

    // Google Cloud
    if (process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT) {
        return 'Google Cloud Platform';
    }

    // Azure
    if (process.env.AZURE_FUNCTIONS_ENVIRONMENT || process.env.WEBSITE_SITE_NAME) {
        return 'Microsoft Azure';
    }

    // Heroku
    if (process.env.DYNO || process.env.HEROKU_APP_NAME) {
        return 'Heroku';
    }

    // Railway
    if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
        return 'Railway';
    }

    // Render
    if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
        return 'Render';
    }

    // Fly.io
    if (process.env.FLY_APP_NAME || process.env.FLY_REGION) {
        return 'Fly.io';
    }

    // DigitalOcean App Platform
    if (process.env.DIGITALOCEAN_APP_ID) {
        return 'DigitalOcean';
    }

    // Netlify
    if (process.env.NETLIFY || process.env.NETLIFY_DEV) {
        return 'Netlify';
    }

    // Generic container detection
    if (process.env.KUBERNETES_SERVICE_HOST || process.env.KUBERNETES_PORT) {
        return 'Kubernetes';
    }

    return null;
}

/**
 * Detect if running inside a Docker container.
 */
export function detectContainer(): boolean {
    // Explicit Docker env var
    if (process.env.DOCKER === 'true' || process.env.DOCKER_CONTAINER === 'true') {
        return true;
    }

    // Check for Docker-specific files (Linux)
    try {
        if (fs.existsSync('/.dockerenv')) {
            return true;
        }
        // Check cgroup for docker
        if (fs.existsSync('/proc/1/cgroup')) {
            const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
            if (cgroup.includes('docker') || cgroup.includes('kubepods')) {
                return true;
            }
        }
    } catch {
        // Ignore file read errors (Windows, etc.)
    }

    return false;
}

/**
 * Get all bound network interface addresses.
 */
export function getNetworkInterfaces(): string[] {
    const interfaces = os.networkInterfaces();
    const addresses: string[] = [];

    for (const name of Object.keys(interfaces)) {
        const netInterface = interfaces[name];
        if (netInterface) {
            for (const addr of netInterface) {
                addresses.push(addr.address);
            }
        }
    }

    return addresses;
}

/**
 * Check if a hostname/address is localhost.
 */
export function isLocalhostAddress(address: string): boolean {
    const normalizedAddress = address.toLowerCase().trim();

    // Direct matches
    if (normalizedAddress === '127.0.0.1' || normalizedAddress === 'localhost' || normalizedAddress === '::1') {
        return true;
    }

    // IPv4 loopback range (127.x.x.x)
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalizedAddress)) {
        return true;
    }

    // IPv6 loopback variations
    if (normalizedAddress === '0:0:0:0:0:0:0:1' || normalizedAddress === '::ffff:127.0.0.1') {
        return true;
    }

    return false;
}

/**
 * Load the local-only configuration from environment.
 */
export function loadLocalOnlyConfig(): LocalOnlyConfig {
    const hostname = os.hostname();
    const networkInterfaces = getNetworkInterfaces();

    return {
        allowRemote: process.env.BOT_ALLOW_REMOTE === 'true',
        forceLocalOnly: process.env.BOT_LOCAL_ONLY === 'true',
        nodeEnv: process.env.NODE_ENV || 'development',
        cloudPlatform: detectCloudPlatform(),
        isContainer: detectContainer(),
        hostname,
        networkInterfaces,
    };
}

/**
 * Validate that the bot is running in a safe local environment.
 * Throws an error if remote execution is detected.
 * 
 * @param _context - Optional context string for error messages (unused, for logging)
 * @throws RemoteExecutionBlockedError if not running locally
 * @throws CloudExecutionBlockedError if running on cloud platform
 */
export function enforceLocalOnly(_context: string = 'Bot'): void {
    const config = loadLocalOnlyConfig();

    // Allow override for advanced users (with warnings)
    if (config.allowRemote) {
        if (config.nodeEnv === 'production') {
            // In production, BOT_ALLOW_REMOTE is extremely dangerous
            console.warn('⚠️  WARNING: BOT_ALLOW_REMOTE is enabled in production!');
            console.warn('⚠️  This exposes your wallet and funds to remote attackers.');
            console.warn('⚠️  Only use this if you FULLY understand the risks.');
        }
        return; // Allow execution with warning
    }

    // Block cloud platforms unconditionally
    if (config.cloudPlatform) {
        throw new CloudExecutionBlockedError(config.cloudPlatform);
    }

    // Block production mode unless explicitly local
    if (config.nodeEnv === 'production' && !config.forceLocalOnly) {
        throw new RemoteExecutionBlockedError(
            'Production mode requires BOT_LOCAL_ONLY=true to confirm local execution'
        );
    }

    // Block container execution (Docker, Kubernetes) unless local-only is forced
    if (config.isContainer && !config.forceLocalOnly) {
        throw new RemoteExecutionBlockedError(
            'Container execution detected. Set BOT_LOCAL_ONLY=true to run in containers'
        );
    }

    // All checks passed for development/local mode
}

/**
 * Validate an incoming request IP is from localhost.
 * Returns true if the request is from localhost, false otherwise.
 * 
 * @param remoteAddress - The remote IP address from the request
 * @param forwardedFor - The X-Forwarded-For header value (if any)
 */
export function isRequestFromLocalhost(
    remoteAddress: string | undefined,
    forwardedFor: string | string[] | undefined
): boolean {
    const config = loadLocalOnlyConfig();

    // If remote access is explicitly allowed, accept all requests
    if (config.allowRemote) {
        return true;
    }

    // If there's an X-Forwarded-For header, the request came through a proxy
    // This means it's likely from a remote source
    if (forwardedFor) {
        return false;
    }

    // Check the remote address
    if (!remoteAddress) {
        return false;
    }

    return isLocalhostAddress(remoteAddress);
}

/**
 * Get a human-readable status of the local-only configuration.
 */
export function getLocalOnlyStatus(): {
    isLocal: boolean;
    reason: string;
    config: LocalOnlyConfig;
} {
    const config = loadLocalOnlyConfig();

    if (config.allowRemote) {
        return {
            isLocal: false,
            reason: 'Remote access enabled via BOT_ALLOW_REMOTE',
            config,
        };
    }

    if (config.cloudPlatform) {
        return {
            isLocal: false,
            reason: `Running on cloud platform: ${config.cloudPlatform}`,
            config,
        };
    }

    if (config.isContainer && !config.forceLocalOnly) {
        return {
            isLocal: false,
            reason: 'Running in container without BOT_LOCAL_ONLY=true',
            config,
        };
    }

    return {
        isLocal: true,
        reason: 'Running in local-only mode',
        config,
    };
}
