import { createHmac, createHash, timingSafeEqual } from 'crypto';

export interface HmacVerifyParams {
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    rawBody: string;
    signature: string;
    secret: string;
}

/**
 * Compute the canonical string for HMAC signing.
 * FORMAT: METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
 */
export function computeCanonical(
    method: string,
    path: string,
    timestamp: string,
    nonce: string,
    rawBody: string
): string {
    const bodyHash = createHash('sha256').update(rawBody || '').digest('hex');
    return `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/**
 * Compute HMAC SHA256 signature.
 */
export function computeSignature(canonical: string, secret: string): string {
    return createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * Verify HMAC signature using constant-time comparison.
 */
export function verifySignature(params: HmacVerifyParams): boolean {
    const canonical = computeCanonical(
        params.method,
        params.path,
        params.timestamp,
        params.nonce,
        params.rawBody
    );

    const expectedSig = computeSignature(canonical, params.secret);

    // Constant-time comparison to prevent timing attacks
    try {
        const sigBuffer = Buffer.from(params.signature, 'hex');
        const expectedBuffer = Buffer.from(expectedSig, 'hex');

        if (sigBuffer.length !== expectedBuffer.length) {
            return false;
        }

        return timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
        return false;
    }
}

/**
 * Validate timestamp is within TTL window.
 */
export function isTimestampValid(timestamp: string, ttlSeconds: number): boolean {
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;

    const now = Math.floor(Date.now() / 1000);
    const diff = Math.abs(now - ts);

    return diff <= ttlSeconds;
}
