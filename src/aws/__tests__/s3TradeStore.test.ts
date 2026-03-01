/**
 * S3 Trade Store — unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Shared send mock — captured by the module factory below. */
const sendMock = vi.fn();

// Mock the AWS S3 SDK
vi.mock('@aws-sdk/client-s3', () => {
    class MockS3Client {
        send = sendMock;
    }
    return {
        S3Client: MockS3Client,
        GetObjectCommand: class { constructor(public input: unknown) { } },
        PutObjectCommand: class { constructor(public input: unknown) { } },
    };
});

// Suppress logger output in tests
vi.mock('../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import {
    S3TradeStore,
    resolveS3TradeStoreConfig,
    getS3TradeStore,
    setS3TradeStoreForTesting,
    resetS3TradeStore,
    type S3TradeStoreConfig,
} from '../s3TradeStore';

const DEFAULT_CONFIG: S3TradeStoreConfig = {
    bucket: 'my-bucket',
    key: 'trade_history.json',
    region: 'us-east-1',
};

// ─── resolveS3TradeStoreConfig ───────────────────────────────────────────────

describe('resolveS3TradeStoreConfig', () => {
    const original = { ...process.env };

    afterEach(() => {
        process.env = { ...original };
    });

    it('returns null when S3_TRADE_HISTORY_BUCKET is not set', () => {
        delete process.env.S3_TRADE_HISTORY_BUCKET;
        expect(resolveS3TradeStoreConfig()).toBeNull();
    });

    it('returns config when bucket is set', () => {
        process.env.S3_TRADE_HISTORY_BUCKET = 'my-bucket';
        process.env.S3_TRADE_HISTORY_KEY = 'custom/key.json';
        process.env.S3_TRADE_HISTORY_REGION = 'eu-west-1';
        const cfg = resolveS3TradeStoreConfig();
        expect(cfg).toEqual({
            bucket: 'my-bucket',
            key: 'custom/key.json',
            region: 'eu-west-1',
        });
    });

    it('defaults key and region', () => {
        process.env.S3_TRADE_HISTORY_BUCKET = 'my-bucket';
        delete process.env.S3_TRADE_HISTORY_KEY;
        delete process.env.S3_TRADE_HISTORY_REGION;
        delete process.env.AWS_REGION;
        const cfg = resolveS3TradeStoreConfig();
        expect(cfg).toEqual({
            bucket: 'my-bucket',
            key: 'trade_history.json',
            region: 'us-east-1',
        });
    });

    it('falls back to AWS_REGION env var', () => {
        process.env.S3_TRADE_HISTORY_BUCKET = 'my-bucket';
        delete process.env.S3_TRADE_HISTORY_REGION;
        process.env.AWS_REGION = 'ap-southeast-2';
        const cfg = resolveS3TradeStoreConfig();
        expect(cfg?.region).toBe('ap-southeast-2');
    });
});

// ─── S3TradeStore.load() ─────────────────────────────────────────────────────

describe('S3TradeStore.load', () => {
    beforeEach(() => {
        sendMock.mockReset();
    });

    it('returns parsed array from S3', async () => {
        const trades = [{ id: '1', pair: 'XRP/USD' }, { id: '2', pair: 'XRP/USD' }];
        sendMock.mockResolvedValueOnce({
            Body: { transformToString: () => Promise.resolve(JSON.stringify(trades)) },
        });

        const store = new S3TradeStore(DEFAULT_CONFIG);
        const result = await store.load();
        expect(result).toEqual(trades);
    });

    it('returns null for NoSuchKey (object not yet created)', async () => {
        const err = new Error('NoSuchKey');
        (err as unknown as Record<string, unknown>).name = 'NoSuchKey';
        sendMock.mockRejectedValueOnce(err);

        const store = new S3TradeStore(DEFAULT_CONFIG);
        const result = await store.load();
        expect(result).toBeNull();
    });

    it('returns null for 404 status code', async () => {
        const err = new Error('Not Found');
        (err as unknown as Record<string, unknown>).$metadata = { httpStatusCode: 404 };
        sendMock.mockRejectedValueOnce(err);

        const store = new S3TradeStore(DEFAULT_CONFIG);
        const result = await store.load();
        expect(result).toBeNull();
    });

    it('throws on unexpected S3 errors', async () => {
        sendMock.mockRejectedValueOnce(new Error('AccessDenied'));

        const store = new S3TradeStore(DEFAULT_CONFIG);
        await expect(store.load()).rejects.toThrow('AccessDenied');
    });

    it('returns null when body is empty', async () => {
        sendMock.mockResolvedValueOnce({
            Body: { transformToString: () => Promise.resolve('') },
        });

        const store = new S3TradeStore(DEFAULT_CONFIG);
        const result = await store.load();
        expect(result).toBeNull();
    });

    it('returns null when object is not a JSON array', async () => {
        sendMock.mockResolvedValueOnce({
            Body: { transformToString: () => Promise.resolve('{"not": "array"}') },
        });

        const store = new S3TradeStore(DEFAULT_CONFIG);
        const result = await store.load();
        expect(result).toBeNull();
    });
});

// ─── S3TradeStore.save() ─────────────────────────────────────────────────────

describe('S3TradeStore.save', () => {
    beforeEach(() => {
        sendMock.mockReset();
    });

    it('uploads JSON to S3', async () => {
        sendMock.mockResolvedValue({});

        const store = new S3TradeStore(DEFAULT_CONFIG);
        const trades = [{ id: '1' }];
        store.save(trades);

        // Wait for the async upload to complete
        await store.waitForPendingUpload();

        expect(sendMock).toHaveBeenCalledTimes(1);
        const cmd = sendMock.mock.calls[0]![0];
        expect(cmd.input.Bucket).toBe('my-bucket');
        expect(cmd.input.Key).toBe('trade_history.json');
        expect(cmd.input.ContentType).toBe('application/json');
        expect(JSON.parse(cmd.input.Body)).toEqual(trades);
    });

    it('does not throw when upload fails (logs error instead)', async () => {
        sendMock.mockRejectedValueOnce(new Error('S3 write failed'));

        const store = new S3TradeStore(DEFAULT_CONFIG);
        store.save([{ id: '1' }]);
        // Should not throw
        await store.waitForPendingUpload();
    });

    it('coalesces rapid saves (only one PutObject in flight)', async () => {
        let resolveFirst: (() => void) | undefined;
        const firstUpload = new Promise<void>((r) => { resolveFirst = r; });

        sendMock.mockImplementationOnce(() => firstUpload.then(() => ({})));
        sendMock.mockResolvedValue({});

        const store = new S3TradeStore(DEFAULT_CONFIG);
        store.save([{ id: '1' }]);
        store.save([{ id: '2' }]);  // Should be coalesced (dropped)

        expect(store.isPending).toBe(true);

        // Complete the first upload
        resolveFirst!();
        await store.waitForPendingUpload();

        // Only one PutObject call should have been made
        expect(sendMock).toHaveBeenCalledTimes(1);
    });
});

// ─── Singleton management ────────────────────────────────────────────────────

describe('singleton management', () => {
    const original = { ...process.env };

    afterEach(() => {
        process.env = { ...original };
        resetS3TradeStore();
    });

    it('getS3TradeStore returns null when not configured', () => {
        delete process.env.S3_TRADE_HISTORY_BUCKET;
        resetS3TradeStore();
        expect(getS3TradeStore()).toBeNull();
    });

    it('getS3TradeStore returns an instance when configured', () => {
        process.env.S3_TRADE_HISTORY_BUCKET = 'test-bucket';
        resetS3TradeStore();
        const store = getS3TradeStore();
        expect(store).toBeInstanceOf(S3TradeStore);
    });

    it('setS3TradeStoreForTesting overrides the singleton', () => {
        const mock = new S3TradeStore(DEFAULT_CONFIG);
        setS3TradeStoreForTesting(mock);
        expect(getS3TradeStore()).toBe(mock);
    });

    it('resetS3TradeStore clears the singleton', () => {
        process.env.S3_TRADE_HISTORY_BUCKET = 'test-bucket';
        getS3TradeStore(); // create
        resetS3TradeStore();
        // After reset, a new call re-evaluates config
        delete process.env.S3_TRADE_HISTORY_BUCKET;
        expect(getS3TradeStore()).toBeNull();
    });
});
