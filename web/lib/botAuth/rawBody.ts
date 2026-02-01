import type { NextApiRequest } from 'next';

/**
 * Read the raw body from a Next.js API request.
 * Must be used with `export const config = { api: { bodyParser: false } }` for POST/PUT/DELETE.
 * For GET requests, returns empty string.
 */
export async function readRawBody(req: NextApiRequest): Promise<string> {
    // GET/HEAD requests have no body
    if (req.method === 'GET' || req.method === 'HEAD') {
        return '';
    }

    // If body is already parsed (shouldn't happen with bodyParser: false)
    if (req.body && typeof req.body === 'object') {
        return JSON.stringify(req.body);
    }

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });

        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            resolve(rawBody);
        });

        req.on('error', (err) => {
            reject(err);
        });

        // Handle already-consumed stream
        if (req.readable === false) {
            resolve('');
        }
    });
}

/**
 * Parse JSON from raw body string.
 */
export function parseJsonBody<T = unknown>(rawBody: string): T | null {
    if (!rawBody || rawBody.trim() === '') {
        return null;
    }

    try {
        return JSON.parse(rawBody) as T;
    } catch {
        return null;
    }
}
