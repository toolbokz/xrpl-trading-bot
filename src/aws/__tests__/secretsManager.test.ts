/**
 * AWS Secrets Manager integration — unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Shared send mock — captured by the module factory below. */
const sendMock = vi.fn();

// Mock the AWS SDK — must be before the import of secretsManager
vi.mock('@aws-sdk/client-secrets-manager', () => {
    class MockSecretsManagerClient {
        send = sendMock;
    }
    return {
        SecretsManagerClient: MockSecretsManagerClient,
        GetSecretValueCommand: class { constructor(public input: unknown) { } },
    };
});

import {
    resolveSecretsManagerConfig,
    loadSecretsIntoEnv,
    maybeLoadAwsSecrets,
} from '../secretsManager';

describe('resolveSecretsManagerConfig', () => {
    const original = { ...process.env };

    afterEach(() => {
        process.env = { ...original };
    });

    it('returns null when AWS_SECRET_NAME is not set', () => {
        delete process.env.AWS_SECRET_NAME;
        expect(resolveSecretsManagerConfig()).toBeNull();
    });

    it('returns config when AWS_SECRET_NAME is set', () => {
        process.env.AWS_SECRET_NAME = 'my/secret';
        process.env.AWS_REGION = 'eu-west-1';
        const cfg = resolveSecretsManagerConfig();
        expect(cfg).toEqual({ secretName: 'my/secret', region: 'eu-west-1' });
    });

    it('defaults region to us-east-1', () => {
        process.env.AWS_SECRET_NAME = 'my/secret';
        delete process.env.AWS_REGION;
        const cfg = resolveSecretsManagerConfig();
        expect(cfg?.region).toBe('us-east-1');
    });
});

describe('loadSecretsIntoEnv', () => {
    const original = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        process.env = { ...original };
    });

    it('injects allowed keys into process.env', async () => {

        sendMock.mockResolvedValueOnce({
            SecretString: JSON.stringify({
                XRPL_SEED_MAINNET: 'sMainnetSeed123',
                XRPL_SECRET_PASSPHRASE: 'hunter2',
            }),
        });

        delete process.env.XRPL_SEED_MAINNET;
        delete process.env.XRPL_SECRET_PASSPHRASE;

        const count = await loadSecretsIntoEnv({ secretName: 'test', region: 'us-east-1' });
        expect(count).toBe(2);
        expect(process.env.XRPL_SEED_MAINNET).toBe('sMainnetSeed123');
        expect(process.env.XRPL_SECRET_PASSPHRASE).toBe('hunter2');
    });

    it('does not overwrite existing env values', async () => {

        sendMock.mockResolvedValueOnce({
            SecretString: JSON.stringify({ XRPL_SEED_MAINNET: 'from-sm' }),
        });

        process.env.XRPL_SEED_MAINNET = 'from-local';
        const count = await loadSecretsIntoEnv({ secretName: 'test', region: 'us-east-1' });
        expect(count).toBe(0);
        expect(process.env.XRPL_SEED_MAINNET).toBe('from-local');
    });

    it('ignores unknown keys', async () => {

        sendMock.mockResolvedValueOnce({
            SecretString: JSON.stringify({
                XRPL_SEED_MAINNET: 'ok',
                RANDOM_KEY: 'ignored',
            }),
        });

        delete process.env.XRPL_SEED_MAINNET;
        const count = await loadSecretsIntoEnv({ secretName: 'test', region: 'us-east-1' });
        expect(count).toBe(1);
        expect(process.env.RANDOM_KEY).toBeUndefined();
    });

    it('throws on invalid JSON', async () => {

        sendMock.mockResolvedValueOnce({ SecretString: 'not-json' });
        await expect(loadSecretsIntoEnv({ secretName: 'test', region: 'us-east-1' })).rejects.toThrow(
            /not valid JSON/,
        );
    });

    it('throws on binary secret', async () => {

        sendMock.mockResolvedValueOnce({ SecretString: null });
        await expect(loadSecretsIntoEnv({ secretName: 'test', region: 'us-east-1' })).rejects.toThrow(
            /no string value/,
        );
    });
});

describe('maybeLoadAwsSecrets', () => {
    const original = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        process.env = { ...original };
    });

    it('is a no-op when AWS_SECRET_NAME is not set', async () => {
        delete process.env.AWS_SECRET_NAME;
        await expect(maybeLoadAwsSecrets()).resolves.toBeUndefined();
    });

    it('throws a descriptive error when SM call fails', async () => {
        process.env.AWS_SECRET_NAME = 'bad-secret';
        process.env.AWS_REGION = 'us-east-1';

        sendMock.mockRejectedValueOnce(new Error('Access denied'));

        await expect(maybeLoadAwsSecrets()).rejects.toThrow(/Access denied/);
    });
});
