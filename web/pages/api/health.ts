import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../lib/localApi';
import { botController } from '../../lib/botController';
import { ensureRuntimeHooks } from '../../lib/runtimeHooks';
import { loadConfig } from '../../../src/config';

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
 */
function handler(req: LocalRequest, res: NextApiResponse<HealthResponse>) {
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
        requestId: req.requestId,
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

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
