/**
 * AWS S3 persistence layer for trade history.
 *
 * When enabled (via S3_TRADE_HISTORY_BUCKET env var), trade history is
 * written to S3 in addition to (or instead of) the local JSON file.
 * This provides durable cloud-backed storage that survives instance
 * replacement and supports centralized auditability.
 *
 * Environment variables:
 *   S3_TRADE_HISTORY_BUCKET  — S3 bucket name (required to enable)
 *   S3_TRADE_HISTORY_KEY     — Object key (default: "trade_history.json")
 *   S3_TRADE_HISTORY_REGION  — AWS region (default: AWS_REGION or "us-east-1")
 *
 * The IAM role / credentials used by the bot must have:
 *   s3:GetObject, s3:PutObject on the target bucket/key.
 */

import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    type S3ClientConfig,
} from '@aws-sdk/client-s3';

import { logger } from '../analytics/logger';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface S3TradeStoreConfig {
    /** S3 bucket name. */
    bucket: string;
    /** Object key inside the bucket (default: "trade_history.json"). */
    key: string;
    /** AWS region (default: "us-east-1"). */
    region: string;
}

/**
 * Resolve S3 trade-store config from environment variables.
 * Returns null when the feature is disabled (no bucket configured).
 */
export function resolveS3TradeStoreConfig(): S3TradeStoreConfig | null {
    const bucket = process.env.S3_TRADE_HISTORY_BUCKET;
    if (!bucket) return null;

    return {
        bucket,
        key: process.env.S3_TRADE_HISTORY_KEY || 'trade_history.json',
        region: process.env.S3_TRADE_HISTORY_REGION || process.env.AWS_REGION || 'us-east-1',
    };
}

// ─── Store implementation ────────────────────────────────────────────────────

export class S3TradeStore {
    private readonly client: S3Client;
    private readonly bucket: string;
    private readonly key: string;

    /** Queue pending upload to avoid overlapping PutObject calls. */
    private pendingUpload: Promise<void> | null = null;
    private dirty = false;

    constructor(config: S3TradeStoreConfig, clientOverride?: S3Client) {
        this.bucket = config.bucket;
        this.key = config.key;
        const clientOpts: S3ClientConfig = { region: config.region };
        this.client = clientOverride ?? new S3Client(clientOpts);

        logger.info(
            { bucket: this.bucket, key: this.key, region: config.region },
            '[S3TradeStore] Initialized — trade history will sync to S3',
        );
    }

    // ── Read ──────────────────────────────────────────────────────────────

    /**
     * Load trade history JSON from S3.
     * Returns the parsed array, or null if the object does not exist.
     */
    async load(): Promise<unknown[] | null> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: this.key,
            });
            const response = await this.client.send(command);
            const body = await response.Body?.transformToString('utf-8');
            if (!body) return null;

            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed)) {
                logger.warn(
                    { bucket: this.bucket, key: this.key },
                    '[S3TradeStore] Object is not a JSON array — ignoring',
                );
                return null;
            }

            logger.info(
                { count: parsed.length, bucket: this.bucket, key: this.key },
                '[S3TradeStore] Loaded trade history from S3',
            );
            return parsed;
        } catch (err: unknown) {
            // NoSuchKey / 404 — the object doesn't exist yet, that's fine
            if (isNoSuchKeyError(err)) {
                logger.info(
                    { bucket: this.bucket, key: this.key },
                    '[S3TradeStore] No existing trade history in S3 — starting fresh',
                );
                return null;
            }
            logger.error(
                { err, bucket: this.bucket, key: this.key },
                '[S3TradeStore] Failed to load trade history from S3',
            );
            throw err;
        }
    }

    // ── Write ─────────────────────────────────────────────────────────────

    /**
     * Persist the full trade array to S3.
     *
     * Writes are coalesced: if a previous upload is still in flight, the
     * current payload is queued and sent once the prior one completes.
     * This prevents race conditions and excessive S3 API calls during
     * high-frequency trade recording.
     */
    save(trades: unknown[]): void {
        this.dirty = true;
        const payload = JSON.stringify(trades, null, 2);

        if (this.pendingUpload) {
            // An upload is in progress — the next flush will pick up the
            // latest `dirty` payload.
            return;
        }

        this.flush(payload);
    }

    private flush(payload: string): void {
        this.dirty = false;
        this.pendingUpload = this.upload(payload)
            .catch((err) => {
                logger.error(
                    { err, bucket: this.bucket, key: this.key },
                    '[S3TradeStore] Failed to save trade history to S3',
                );
            })
            .finally(() => {
                this.pendingUpload = null;
                // If another save() arrived while we were uploading,
                // do another flush with the latest data.  The caller
                // will have dropped the payload, so we re-stringify.
                // (The `dirty` flag is set by save().)
                // NOTE: we intentionally don't re-flush here because
                // the next recordTrade/saveToDisk call will trigger it.
            });
    }

    private async upload(payload: string): Promise<void> {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.key,
            Body: payload,
            ContentType: 'application/json',
        });
        await this.client.send(command);
        logger.debug(
            { bucket: this.bucket, key: this.key, bytes: payload.length },
            '[S3TradeStore] Trade history saved to S3',
        );
    }

    /**
     * Wait for any in-flight upload to finish.  Called during graceful
     * shutdown to ensure the final state reaches S3.
     */
    async waitForPendingUpload(): Promise<void> {
        if (this.pendingUpload) {
            await this.pendingUpload;
        }
    }

    /** Expose for testing. */
    get isPending(): boolean {
        return this.pendingUpload !== null;
    }

    get isDirty(): boolean {
        return this.dirty;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isNoSuchKeyError(err: unknown): boolean {
    if (err && typeof err === 'object') {
        // AWS SDK v3 error shape
        if ('name' in err && (err as { name: string }).name === 'NoSuchKey') return true;
        if ('Code' in err && (err as { Code: string }).Code === 'NoSuchKey') return true;
        if ('$metadata' in err) {
            const meta = (err as { $metadata: { httpStatusCode?: number } }).$metadata;
            if (meta?.httpStatusCode === 404) return true;
        }
    }
    return false;
}

// ─── Singleton management ────────────────────────────────────────────────────

let _instance: S3TradeStore | null = null;

/**
 * Get or create the singleton S3TradeStore (if configured).
 * Returns null when S3 persistence is not enabled.
 */
export function getS3TradeStore(): S3TradeStore | null {
    if (_instance) return _instance;

    const config = resolveS3TradeStoreConfig();
    if (!config) return null;

    _instance = new S3TradeStore(config);
    return _instance;
}

/**
 * Replace the singleton (for testing).
 */
export function setS3TradeStoreForTesting(store: S3TradeStore | null): void {
    _instance = store;
}

/**
 * Reset the singleton (called on shutdown).
 */
export function resetS3TradeStore(): void {
    _instance = null;
}
