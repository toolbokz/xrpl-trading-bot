/**
 * Prometheus metrics endpoint.
 * Returns metrics in Prometheus exposition format.
 * 
 * Localhost-only access (no external auth needed).
 */

import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../lib/localApi';
import { getPrometheusMetrics, BotMetrics } from '../../lib/metrics/collector';
import { botController } from '../../lib/botController';
import { logger } from '../../../src/analytics/logger';

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

function handler(req: LocalRequest, res: NextApiResponse): void {
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

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
