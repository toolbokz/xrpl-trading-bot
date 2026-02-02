import type { NextApiRequest } from 'next';

/** Maximum request body size in bytes (64KB) */
const MAX_BODY_SIZE = 64 * 1024;

/** Error thrown when request body exceeds size limit */
export class BodyTooLargeError extends Error {
    constructor(size: number, maxSize: number = MAX_BODY_SIZE) {
        super(`Request body too large: ${size} bytes exceeds limit of ${maxSize} bytes`);
        this.name = 'BodyTooLargeError';
    }
}

/**
 * Read the raw body from a Next.js API request.
 * Must be used with `export const config = { api: { bodyParser: false } }` for POST/PUT/DELETE.
 * For GET requests, returns empty string.
 * 
 * @param req - Next.js API request
 * @param maxSize - Maximum allowed body size in bytes (default: 64KB)
 * @throws {BodyTooLargeError} If body exceeds maxSize
 */
export async function readRawBody(req: NextApiRequest, maxSize: number = MAX_BODY_SIZE): Promise<string> {
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
        let totalSize = 0;

        req.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > maxSize) {
                req.destroy();
                reject(new BodyTooLargeError(totalSize, maxSize));
                return;
            }
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
