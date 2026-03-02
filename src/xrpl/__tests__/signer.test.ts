/**
 * Tests for signer readiness and factory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    SeedSigner,
    XummSigner,
    LedgerSigner,
    KmsSigner,
    assertSignerReady,
    createSignerFromEnv,
    SignerNotImplementedError,
} from '../../xrpl/signer';

describe('SeedSigner', () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        delete process.env.XRPL_NETWORK;
        (process.env as any).NODE_ENV = undefined;
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('creates signer from valid seed', () => {
        // Use a well-known test seed
        const signer = new SeedSigner('sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r');
        expect(signer.type).toBe('seed');
    });

    it('blocks on mainnet context', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        expect(() => new SeedSigner('sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r')).toThrow(
            /disabled on mainnet/,
        );
    });

    it('getReadinessReport returns ready', () => {
        const signer = new SeedSigner('sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r');
        const report = signer.getReadinessReport();
        expect(report.ready).toBe(true);
        expect(report.type).toBe('seed');
    });
});

describe('XummSigner', () => {
    it('throws SignerNotImplementedError on signTx', async () => {
        const signer = new XummSigner('key', 'secret');
        await expect(signer.signTx({} as any)).rejects.toThrow(SignerNotImplementedError);
    });

    it('throws SignerNotImplementedError on getAddress', async () => {
        const signer = new XummSigner('key', 'secret');
        await expect(signer.getAddress()).rejects.toThrow(SignerNotImplementedError);
    });

    it('reports not ready', async () => {
        const signer = new XummSigner('key', 'secret');
        expect(await signer.isReady()).toBe(false);
    });

    it('getReadinessReport shows credentials status', () => {
        const signer = new XummSigner('key', 'secret');
        const report = signer.getReadinessReport();
        expect(report.ready).toBe(false);
        expect(report.hasCredentials).toBe(true);
        expect(report.reason).toContain('xumm-sdk');
    });
});

describe('LedgerSigner', () => {
    it('throws SignerNotImplementedError on signTx', async () => {
        const signer = new LedgerSigner();
        await expect(signer.signTx({} as any)).rejects.toThrow(SignerNotImplementedError);
    });

    it('reports not ready', async () => {
        const signer = new LedgerSigner();
        expect(await signer.isReady()).toBe(false);
    });

    it('getReadinessReport shows install hint', () => {
        const report = new LedgerSigner().getReadinessReport();
        expect(report.ready).toBe(false);
        expect(report.reason).toContain('ledgerhq');
    });
});

describe('KmsSigner', () => {
    it('rejects signTx without KMS connectivity', async () => {
        const signer = new KmsSigner('key-123', 'us-east-1');
        // signTx will try to call getAddress() first which calls KMS
        await expect(signer.signTx({} as any)).rejects.toThrow();
    });

    it('reports not ready without KMS connectivity', async () => {
        const signer = new KmsSigner('key-123');
        // isReady() tries to connect to KMS — should fail without real credentials
        expect(await signer.isReady()).toBe(false);
    });

    it('getReadinessReport shows credentials and not-yet-initialized', () => {
        const report = new KmsSigner('key-123').getReadinessReport();
        // Not ready until isReady()/getAddress() is called
        expect(report.ready).toBe(false);
        expect(report.hasCredentials).toBe(true);
        expect(report.reason).toContain('not yet initialized');
    });
});

describe('assertSignerReady', () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        delete process.env.SIGNER_SKIP_READY_CHECK;
        delete process.env.XRPL_NETWORK;
        (process.env as any).NODE_ENV = undefined;
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('passes for SeedSigner with dry-run signing', async () => {
        const signer = new SeedSigner('sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r');
        await expect(assertSignerReady(signer)).resolves.not.toThrow();
    });

    it('fails for XummSigner (not implemented)', async () => {
        const signer = new XummSigner('key', 'secret');
        await expect(assertSignerReady(signer)).rejects.toThrow(SignerNotImplementedError);
    });

    it('fails for KmsSigner without KMS connectivity', async () => {
        const signer = new KmsSigner('key-123');
        // assertSignerReady checks readinessReport: ready=false → throws
        await expect(assertSignerReady(signer)).rejects.toThrow();
    });

    it('skips check when SIGNER_SKIP_READY_CHECK=true', async () => {
        process.env.SIGNER_SKIP_READY_CHECK = 'true';
        const signer = new KmsSigner('key-123');
        await expect(assertSignerReady(signer)).resolves.not.toThrow();
    });
});

describe('createSignerFromEnv', () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        delete process.env.XRPL_SEED;
        delete process.env.XRPL_SECRET_NUMBERS;
        delete process.env.XUMM_API_KEY;
        delete process.env.XUMM_API_SECRET;
        delete process.env.KMS_KEY_ID;
        delete process.env.LEDGER_ENABLED;
        delete process.env.XRPL_NETWORK;
        (process.env as any).NODE_ENV = undefined;
        delete process.env.AWS_REGION;
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('creates SeedSigner from XRPL_SEED', () => {
        process.env.XRPL_SEED = 'sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r';
        const signer = createSignerFromEnv();
        expect(signer.type).toBe('seed');
    });

    it('throws when no credentials set', () => {
        expect(() => createSignerFromEnv()).toThrow(/No signing credentials/);
    });

    it('creates KmsSigner on mainnet with KMS_KEY_ID', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        process.env.KMS_KEY_ID = 'arn:aws:kms:us-east-1:123456789:key/abc';
        const signer = createSignerFromEnv();
        expect(signer.type).toBe('kms');
    });

    it('creates XummSigner on mainnet with XUMM_API_KEY', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        process.env.XUMM_API_KEY = 'test-key';
        process.env.XUMM_API_SECRET = 'test-secret';
        const signer = createSignerFromEnv();
        expect(signer.type).toBe('xumm');
    });

    it('creates LedgerSigner on mainnet with LEDGER_ENABLED', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        process.env.LEDGER_ENABLED = 'true';
        const signer = createSignerFromEnv();
        expect(signer.type).toBe('ledger');
    });

    it('blocks SeedSigner on mainnet', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        process.env.XRPL_SEED = 'sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r';
        expect(() => createSignerFromEnv()).toThrow(/Mainnet.*requires/);
    });
});
