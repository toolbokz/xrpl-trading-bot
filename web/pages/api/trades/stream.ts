/**
 * DEPRECATED: This route is no longer used.
 * 
 * SSE streaming now runs in the backend process (src/server/httpServer.ts)
 * and Next.js proxies requests via rewrites in next.config.mjs.
 * 
 * This file is kept for reference but requests to /api/trades/stream
 * are rewritten to the backend server at http://127.0.0.1:4000/trades/stream.
 * 
 * The original implementation below doesn't work because:
 * - Backend runs as a separate process from Next.js
 * - tradeTapeEvents emitter in backend is not the same instance as in Next.js
 * - Events emitted in backend never reach this route
 */

import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse): void {
    // This route should never be called due to Next.js rewrite
    // If it is, redirect to backend
    res.writeHead(307, { Location: 'http://127.0.0.1:4000/trades/stream' });
    res.end();
}
