/**
 * Tests for the safety policy enforcement module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    evaluateSafetyPolicy,
    enforceSafetyPolicy,
    hasMainnetAckFile,
    createMainnetAckFile,
    SafetyPolicyError,
} from '../../security/safetyPolicy';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('evaluateSafetyPolicy', () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        // Reset env
        delete process.env.BOT_ALLOW_REMOTE;
        delete process.env.XRPL_NETWORK;
        (process.env as any).NODE_ENV = undefined;
        delete process.env.PAPER_TRADING;
        delete process.env.BOT_LOCAL_ONLY;
        delete process.env.MAINNET_LIVE_TRADING_ACK;
        delete process.env.POSITION_SIZE_XRP;
        delete process.env.MAX_TRADE_SIZE;
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('allows default development configuration', () => {
        const result = evaluateSafetyPolicy({ requireMainnetAck: true, enforceRemotePolicy: true });
        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
    });

    it('blocks BOT_ALLOW_REMOTE in production', () => {
        process.env.BOT_ALLOW_REMOTE = 'true';
        (process.env as any).NODE_ENV = 'production';

        const result = evaluateSafetyPolicy({ enforceRemotePolicy: true });
        expect(result.allowed).toBe(false);
        const block = result.violations.find(v => v.rule === 'REMOTE_ACCESS_PRODUCTION');
        expect(block).toBeDefined();
        expect(block!.severity).toBe('BLOCK');
    });

    it('warns on BOT_ALLOW_REMOTE with mainnet', () => {
        process.env.BOT_ALLOW_REMOTE = 'true';
        process.env.XRPL_NETWORK = 'mainnet';

        const result = evaluateSafetyPolicy({ enforceRemotePolicy: true });
        const warn = result.violations.find(v => v.rule === 'REMOTE_ACCESS_MAINNET');
        expect(warn).toBeDefined();
        expect(warn!.severity).toBe('WARN');
    });

    it('blocks mainnet live trading without acknowledgement', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        process.env.PAPER_TRADING = 'false';

        const result = evaluateSafetyPolicy({
            requireMainnetAck: true,
            lockFilePath: '/tmp/nonexistent-lock-file',
        });
        expect(result.allowed).toBe(false);
        const block = result.violations.find(v => v.rule === 'MAINNET_LIVE_TRADING_UNACKNOWLEDGED');
        expect(block).toBeDefined();
    });

    it('allows mainnet live trading with env ack', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        process.env.PAPER_TRADING = 'false';
        process.env.MAINNET_LIVE_TRADING_ACK = 'true';
        process.env.BOT_LOCAL_ONLY = 'true';
        (process.env as any).NODE_ENV = 'production';

        const result = evaluateSafetyPolicy({
            requireMainnetAck: true,
            enforceRemotePolicy: true,
        });
        const ackViolation = result.violations.find(v => v.rule === 'MAINNET_LIVE_TRADING_UNACKNOWLEDGED');
        expect(ackViolation).toBeUndefined();
    });

    it('blocks production without BOT_LOCAL_ONLY', () => {
        (process.env as any).NODE_ENV = 'production';

        const result = evaluateSafetyPolicy({ enforceRemotePolicy: true });
        expect(result.allowed).toBe(false);
        const block = result.violations.find(v => v.rule === 'PRODUCTION_LOCAL_ONLY_MISSING');
        expect(block).toBeDefined();
    });

    it('warns when position size exceeds max trade size', () => {
        process.env.XRPL_NETWORK = 'mainnet';
        process.env.PAPER_TRADING = 'false';
        process.env.MAINNET_LIVE_TRADING_ACK = 'true';
        process.env.POSITION_SIZE_XRP = '2000';
        process.env.MAX_TRADE_SIZE = '1000';
        process.env.BOT_LOCAL_ONLY = 'true';
        (process.env as any).NODE_ENV = 'production';

        const result = evaluateSafetyPolicy({ requireMainnetAck: true });
        const warn = result.violations.find(v => v.rule === 'POSITION_SIZE_EXCEEDS_MAX');
        expect(warn).toBeDefined();
        expect(warn!.severity).toBe('WARN');
    });
});

describe('enforceSafetyPolicy', () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('throws SafetyPolicyError on blocking violation', () => {
        process.env.BOT_ALLOW_REMOTE = 'true';
        (process.env as any).NODE_ENV = 'production';

        expect(() => enforceSafetyPolicy({ enforceRemotePolicy: true })).toThrow(SafetyPolicyError);
    });

    it('does not throw for warnings only', () => {
        process.env.BOT_ALLOW_REMOTE = 'true';
        process.env.XRPL_NETWORK = 'mainnet';
        (process.env as any).NODE_ENV = undefined;

        expect(() => enforceSafetyPolicy({ enforceRemotePolicy: true })).not.toThrow();
    });
});

describe('mainnet ack file', () => {
    const tmpDir = os.tmpdir();
    const testLockFile = path.join(tmpDir, '.test-mainnet-ack');

    afterEach(() => {
        try {
            fs.unlinkSync(testLockFile);
        } catch { /* ignore */ }
    });

    it('hasMainnetAckFile returns false when file missing', () => {
        expect(hasMainnetAckFile(testLockFile)).toBe(false);
    });

    it('createMainnetAckFile creates the file', () => {
        createMainnetAckFile(testLockFile);
        expect(hasMainnetAckFile(testLockFile)).toBe(true);

        const content = JSON.parse(fs.readFileSync(testLockFile, 'utf8'));
        expect(content.acknowledged).toBe(true);
        expect(content.hostname).toBeDefined();
    });
});
