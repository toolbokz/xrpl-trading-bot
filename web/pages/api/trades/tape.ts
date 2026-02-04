/**
 * DEPRECATED: This route is now proxied to the backend.
 * 
 * The backend HTTP server (src/server/httpServer.ts) now handles /trades/tape
 * and Next.js proxies requests via rewrites in next.config.mjs.
 * 
 * This file is kept as a fallback but requests to /api/trades/tape
 * are rewritten to the backend server at http://127.0.0.1:4000/trades/tape.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse): void {
    // This route should not be called due to Next.js rewrite
    // If it is, redirect to backend
    const backendPort = process.env.BACKEND_HTTP_PORT || 4000;
    const query = req.url?.split('?')[1] || '';
    res.writeHead(307, { Location: `http://127.0.0.1:${backendPort}/trades/tape?${query}` });
    res.end();
}
