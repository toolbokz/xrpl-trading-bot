import type { NextApiRequest, NextApiResponse } from 'next';
import { botController } from '../../lib/botController';
import { ensureRuntimeHooks } from '../../lib/runtimeHooks';
import { loadConfig } from '../../../src/config';
import { v4 as uuidv4 } from 'uuid';

// Start time for uptime calculation
const startTime = Date.now();

// Version from package.json (loaded at build time)
const packageVersion = process.env.npm_package_version || '0.0.0';

export interface HealthResponse {
    ok: boolean;
    timestamp: string;
    uptimeSec: number;
    version: string;
    requestId: string;
    xrpl: {
        connected: boolean;
        endpoint: string;
        network: string;
    };
    bot: {
        state: string;
        paperTrading: boolean;
    };
}

/**
 * GET /api/health
 * 
 * Health check endpoint for monitoring.
 * Returns bot and XRPL connection status.
 * 
 * This endpoint is public (no auth required) as it doesn't expose sensitive data.
 */
export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<HealthResponse | { error: string }>
) {
    // Accept inbound X-REQUEST-ID or generate one
    const inboundRequestId = req.headers['x-request-id'];
    const requestId = typeof inboundRequestId === 'string' && inboundRequestId.length > 0
        ? inboundRequestId
        : `req_${uuidv4()}`;

    res.setHeader('X-Request-ID', requestId);

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const config = loadConfig();
    const botState = botController.getState();

    // Try to get XRPL connection status
    let xrplConnected = false;
    try {
        const runtime = ensureRuntimeHooks();
        const client = runtime.getClient();
        xrplConnected = client?.isConnected() ?? false;
    } catch {
        // Runtime not initialized, connection status unknown
        xrplConnected = false;
    }

    const health: HealthResponse = {
        ok: true,
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor((Date.now() - startTime) / 1000),
        version: packageVersion,
        requestId,
        xrpl: {
            connected: xrplConnected,
            endpoint: config.xrpl.endpoint.replace(/wss?:\/\/[^@]*@/, 'wss://***@'), // Redact credentials if any
            network: config.xrpl.network,
        },
        bot: {
            state: botState,
            paperTrading: config.paperTrading,
        },
    };

    // Set ok to false if critical systems are down
    if (botState === 'RUNNING' && !xrplConnected) {
        health.ok = false;
    }

    return res.status(health.ok ? 200 : 503).json(health);
}
