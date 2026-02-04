/**
 * Backend HTTP Server for Trade Streaming
 * 
 * This server runs in the backend process and exposes:
 * - GET /trades/stream - SSE endpoint for real-time trade updates
 * - GET /trades/tape - REST endpoint for recent trades
 * 
 * The Next.js frontend proxies to this server via rewrites.
 */

import http from 'http';
import { URL } from 'url';
import { logger } from '../analytics/logger';
import { tradeTapeEvents } from '../market/tradeTapeService';
import { getGlobalTradeTape, Trade, TradeAggression } from '../market/tradeTape';

const DEFAULT_PORT = 4000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_PENDING_MESSAGES = 50;

interface TradeTapeResponse {
    trades: Trade[];
    stats: TradeAggression;
    vwap: number | null;
    pairKey: string | null;
    count: number;
}

export class BackendHttpServer {
    private server: http.Server | null = null;
    private port: number;
    private sseClients: Set<http.ServerResponse> = new Set();

    constructor(port?: number) {
        this.port = port ?? parseInt(process.env.BACKEND_HTTP_PORT ?? String(DEFAULT_PORT), 10);
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    logger.warn({ port: this.port }, 'Backend HTTP port in use, trying next port');
                    this.port++;
                    this.server?.listen(this.port);
                } else {
                    reject(err);
                }
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                logger.info({ port: this.port }, '🌐 Backend HTTP server started (localhost only)');
                resolve();
            });
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            // Close all SSE connections
            for (const client of this.sseClients) {
                try {
                    client.end();
                } catch {
                    // Ignore errors on close
                }
            }
            this.sseClients.clear();

            if (this.server) {
                this.server.close(() => {
                    logger.info('Backend HTTP server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    getPort(): number {
        return this.port;
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // Localhost-only check
        const remoteAddr = req.socket.remoteAddress;
        const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

        if (!isLocalhost && process.env.BOT_ALLOW_REMOTE !== 'true') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden: localhost only' }));
            return;
        }

        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const pathname = url.pathname;

        // CORS headers for local development
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (pathname === '/trades/stream' && req.method === 'GET') {
            this.handleSSE(req, res);
        } else if (pathname === '/trades/tape' && req.method === 'GET') {
            this.handleTapeREST(req, res, url);
        } else if (pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', sseClients: this.sseClients.size }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Send retry instruction
        res.write('retry: 1000\n\n');

        // Track this client
        this.sseClients.add(res);
        logger.info({ clientCount: this.sseClients.size }, 'SSE client connected');

        // Message queue for backpressure
        const pendingMessages: string[] = [];
        let writing = false;

        const flushMessages = (): void => {
            if (writing || pendingMessages.length === 0) return;

            writing = true;
            const message = pendingMessages.shift();
            if (message) {
                res.write(message, (err) => {
                    writing = false;
                    if (err) {
                        cleanup();
                    } else {
                        flushMessages();
                    }
                });
            } else {
                writing = false;
            }
        };

        const sendEvent = (event: string, data: unknown): void => {
            const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

            if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
                pendingMessages.shift(); // Drop oldest on backpressure
            }

            pendingMessages.push(message);
            flushMessages();
        };

        // Send connected event
        sendEvent('connected', { status: 'connected', timestamp: Date.now() });

        // Trade listener
        const onTrade = (trade: Trade): void => {
            logger.debug({ tradeId: trade.id }, 'SSE: Sending trade to client');
            sendEvent('trade', trade);
        };

        // Subscribe to trade events
        tradeTapeEvents.onTrade(onTrade);
        logger.info('SSE: Subscribed to tradeTapeEvents');

        // Keepalive ping every 15s
        const keepaliveInterval = setInterval(() => {
            // Send comment line as ping (doesn't trigger event listeners)
            res.write(': ping\n\n');
            // Also send ping event for explicit handling
            sendEvent('ping', { timestamp: Date.now() });
        }, KEEPALIVE_INTERVAL_MS);

        // Cleanup function
        const cleanup = (): void => {
            clearInterval(keepaliveInterval);
            tradeTapeEvents.offTrade(onTrade);
            this.sseClients.delete(res);
            logger.info({ clientCount: this.sseClients.size }, 'SSE client disconnected');
            try {
                res.end();
            } catch {
                // Ignore
            }
        };

        // Handle client disconnect
        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('error', cleanup);
    }

    private handleTapeREST(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
        try {
            const tape = getGlobalTradeTape();

            if (!tape) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    trades: [],
                    stats: { buyVolumeBase: 0, sellVolumeBase: 0, buyCount: 0, sellCount: 0 },
                    vwap: null,
                    pairKey: null,
                    count: 0,
                } as TradeTapeResponse));
                return;
            }

            const limit = Math.min(
                parseInt(url.searchParams.get('limit') ?? '100', 10) || 100,
                500
            );
            const windowMs = Math.min(
                parseInt(url.searchParams.get('windowMs') ?? '300000', 10) || 300_000,
                3600_000
            );

            const allTrades = tape.getRecent(windowMs);
            const trades = allTrades.slice(-limit).reverse();
            const stats = tape.getAggression(windowMs);
            const vwap = tape.getVWAP(windowMs);
            const pairKey = tape.getPairKey();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                trades,
                stats,
                vwap,
                pairKey,
                count: trades.length,
            } as TradeTapeResponse));
        } catch (err) {
            logger.error({ err }, 'Error handling /trades/tape');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
}

// Singleton instance
let serverInstance: BackendHttpServer | null = null;

export function getBackendHttpServer(): BackendHttpServer {
    if (!serverInstance) {
        serverInstance = new BackendHttpServer();
    }
    return serverInstance;
}

export async function startBackendHttpServer(): Promise<BackendHttpServer> {
    const server = getBackendHttpServer();
    await server.start();
    return server;
}

export async function stopBackendHttpServer(): Promise<void> {
    if (serverInstance) {
        await serverInstance.stop();
        serverInstance = null;
    }
}
