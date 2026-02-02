/**
 * Prometheus metrics endpoint.
 * Returns metrics in Prometheus exposition format.
 * 
 * Authentication: Optional - controlled by METRICS_AUTH_REQUIRED env var.
 * Default: Requires bot:metrics permission when auth is enabled.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getPrometheusMetrics, BotMetrics } from '../../lib/metrics/collector';
import { botController, type BotState } from '../../lib/botController';

// Bot state sync interval
let syncInterval: NodeJS.Timeout | null = null;

function startBotStateSync(): void {
    if (syncInterval) return;

    // Sync bot state every 5 seconds
    syncInterval = setInterval(() => {
        try {
            const state = botController.getState();
            BotMetrics.setBotState(state);
        } catch {
            // Bot controller may not be initialized
        }
    }, 5000);

    if (syncInterval.unref) {
        syncInterval.unref();
    }
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
): Promise<void> {
    // Only allow GET
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    // Check if authentication is required
    const authRequired = process.env.METRICS_AUTH_REQUIRED === 'true';

    if (authRequired) {
        // Simple bearer token auth for metrics
        const authHeader = req.headers.authorization;
        const expectedToken = process.env.METRICS_AUTH_TOKEN;

        if (!expectedToken) {
            console.warn('[Metrics] METRICS_AUTH_REQUIRED is true but METRICS_AUTH_TOKEN is not set');
            res.status(500).json({ error: 'Metrics authentication not configured' });
            return;
        }

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing authorization header' });
            return;
        }

        const token = authHeader.slice(7);
        if (token !== expectedToken) {
            res.status(403).json({ error: 'Invalid token' });
            return;
        }
    }

    // Start bot state sync if not already running
    startBotStateSync();

    // Sync current bot state before returning metrics
    try {
        const state = botController.getState();
        BotMetrics.setBotState(state);
    } catch {
        // Bot controller may not be initialized
    }

    // Return metrics in Prometheus format
    const metrics = getPrometheusMetrics();

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(metrics);
}
