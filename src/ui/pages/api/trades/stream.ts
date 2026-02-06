/**
 * GET /api/trades/stream
 *
 * Server-Sent Events (SSE) endpoint for real-time trade tape updates.
 *
 * In single-process mode (the only supported mode now), the tradeTapeEvents
 * emitter lives in the same process as this API route, so events flow
 * directly without any cross-process proxy.
 *
 * Protocol:
 *   - event: trade      — individual trade from the tape
 *   - event: heartbeat  — keepalive every 15 s (carries serverSessionId)
 *   - event: connected  — sent once on initial connection
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { tradeTapeEvents } from '../../../../market/tradeTapeService';
import { getServerSessionId } from '../../../../runtime/runtimeSingleton';
import type { Trade } from '../../../../market/tradeTape';

export const config = {
    api: { bodyParser: false },
};

const HEARTBEAT_INTERVAL_MS = 15_000;

export default function handler(req: NextApiRequest, res: NextApiResponse): void {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        res.status(405).end('Method Not Allowed');
        return;
    }

    // --- SSE headers ---
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',          // Disable Nginx buffering
    });

    const sessionId = getServerSessionId();

    // Send "connected" event
    res.write(
        `event: connected\ndata: ${JSON.stringify({ serverSessionId: sessionId, ts: Date.now() })}\n\n`,
    );

    // --- Trade listener ---
    const onTrade = (trade: Trade) => {
        try {
            res.write(`event: trade\ndata: ${JSON.stringify(trade)}\n\n`);
        } catch {
            // Client disconnected — cleanup happens below
        }
    };

    tradeTapeEvents.onTrade(onTrade);

    // --- Heartbeat ---
    const heartbeat = setInterval(() => {
        try {
            res.write(
                `event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now(), serverSessionId: sessionId })}\n\n`,
            );
        } catch {
            // Client gone
        }
    }, HEARTBEAT_INTERVAL_MS);

    // --- Cleanup on disconnect ---
    const cleanup = () => {
        clearInterval(heartbeat);
        tradeTapeEvents.offTrade(onTrade);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
}
