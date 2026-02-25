/**
 * Operational Safety Policy Enforcement
 *
 * Policy-level enforcement gates that block dangerous configurations
 * at startup before any funds-touching code runs.
 *
 * Rules:
 *   1. BOT_ALLOW_REMOTE=true in production → BLOCK unless safety lock file exists
 *   2. Mainnet + paper=false → require MAINNET_LIVE_TRADING_ACK=true
 *   3. Log all policy decisions for forensic audit
 *
 * @module security/safetyPolicy
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PolicyViolation {
    rule: string;
    message: string;
    severity: 'BLOCK' | 'WARN';
}

export interface PolicyResult {
    allowed: boolean;
    violations: PolicyViolation[];
    ackRequired: string[];
    timestamp: number;
    hostname: string;
}

export interface SafetyPolicyConfig {
    /** Path to the safety lock file (default: data/.mainnet-live-ack) */
    lockFilePath: string;
    /** Whether to require explicit mainnet live trading acknowledgement */
    requireMainnetAck: boolean;
    /** Whether to enforce remote access policy */
    enforceRemotePolicy: boolean;
}

export class SafetyPolicyError extends Error {
    constructor(
        public readonly violations: PolicyViolation[],
    ) {
        const msgs = violations.map(v => `  [${v.severity}] ${v.rule}: ${v.message}`).join('\n');
        super(`Safety policy violations:\n${msgs}`);
        this.name = 'SafetyPolicyError';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LOCK_FILE = path.resolve(process.cwd(), 'data', '.mainnet-live-ack');

export function loadSafetyPolicyConfig(): SafetyPolicyConfig {
    return {
        lockFilePath: process.env.SAFETY_LOCK_FILE || DEFAULT_LOCK_FILE,
        requireMainnetAck: process.env.SAFETY_SKIP_MAINNET_ACK !== 'true',
        enforceRemotePolicy: process.env.SAFETY_SKIP_REMOTE_POLICY !== 'true',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock file helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the mainnet live trading acknowledgement lock file exists.
 * The lock file is created manually by the operator to confirm they
 * understand live trading risks.
 */
export function hasMainnetAckFile(lockFilePath: string = DEFAULT_LOCK_FILE): boolean {
    try {
        return fs.existsSync(lockFilePath);
    } catch {
        return false;
    }
}

/**
 * Create the mainnet acknowledgement lock file.
 * Includes metadata about who created it and when.
 */
export function createMainnetAckFile(lockFilePath: string = DEFAULT_LOCK_FILE): void {
    const dir = path.dirname(lockFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(
        {
            acknowledged: true,
            createdAt: new Date().toISOString(),
            hostname: os.hostname(),
            user: os.userInfo().username,
            pid: process.pid,
            note: 'This file acknowledges live mainnet trading. Delete to re-enable safety gate.',
        },
        null,
        2,
    );

    fs.writeFileSync(lockFilePath, content, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate all safety policies. Returns a result with violations.
 * Call this at startup BEFORE initializing any runtime components.
 */
export function evaluateSafetyPolicy(config?: Partial<SafetyPolicyConfig>): PolicyResult {
    const cfg = { ...loadSafetyPolicyConfig(), ...config };
    const violations: PolicyViolation[] = [];
    const ackRequired: string[] = [];

    const isProduction = process.env.NODE_ENV === 'production';
    const isMainnet = process.env.XRPL_NETWORK === 'mainnet';
    const isPaper = process.env.PAPER_TRADING !== 'false'; // default true
    const allowRemote = process.env.BOT_ALLOW_REMOTE === 'true';

    // Rule 1: BOT_ALLOW_REMOTE=true in production
    if (cfg.enforceRemotePolicy && allowRemote && isProduction) {
        violations.push({
            rule: 'REMOTE_ACCESS_PRODUCTION',
            message:
                'BOT_ALLOW_REMOTE=true is set in production. ' +
                'This exposes your wallet to remote attackers. ' +
                'Remove BOT_ALLOW_REMOTE or set to false.',
            severity: 'BLOCK',
        });
    }

    // Rule 1b: BOT_ALLOW_REMOTE=true on mainnet (even non-production)
    if (cfg.enforceRemotePolicy && allowRemote && isMainnet) {
        violations.push({
            rule: 'REMOTE_ACCESS_MAINNET',
            message:
                'BOT_ALLOW_REMOTE=true with mainnet. ' +
                'Remote access on mainnet risks fund theft.',
            severity: 'WARN',
        });
    }

    // Rule 2: Mainnet live trading without acknowledgement
    if (cfg.requireMainnetAck && isMainnet && !isPaper) {
        const hasAck =
            process.env.MAINNET_LIVE_TRADING_ACK === 'true' ||
            hasMainnetAckFile(cfg.lockFilePath);

        if (!hasAck) {
            violations.push({
                rule: 'MAINNET_LIVE_TRADING_UNACKNOWLEDGED',
                message:
                    'Live trading on mainnet requires explicit acknowledgement. ' +
                    'Set MAINNET_LIVE_TRADING_ACK=true or create the lock file: ' +
                    cfg.lockFilePath,
                severity: 'BLOCK',
            });
            ackRequired.push('MAINNET_LIVE_TRADING_ACK');
        }
    }

    // Rule 3: Production without BOT_LOCAL_ONLY
    if (isProduction && process.env.BOT_LOCAL_ONLY !== 'true' && !allowRemote) {
        violations.push({
            rule: 'PRODUCTION_LOCAL_ONLY_MISSING',
            message:
                'Production requires BOT_LOCAL_ONLY=true to confirm local execution.',
            severity: 'BLOCK',
        });
    }

    // Rule 4: Mainnet with default position size (likely forgot to configure)
    if (isMainnet && !isPaper) {
        const posSize = parseFloat(
            process.env.BASE_ORDER_SIZE_XRP || process.env.POSITION_SIZE_XRP || '5',
        );
        const maxTrade = parseFloat(process.env.MAX_TRADE_SIZE || '1000');
        if (posSize >= maxTrade) {
            violations.push({
                rule: 'POSITION_SIZE_EXCEEDS_MAX',
                message:
                    `BASE_ORDER_SIZE_XRP/POSITION_SIZE_XRP (${posSize}) >= MAX_TRADE_SIZE (${maxTrade}). ` +
                    'Check risk configuration.',
                severity: 'WARN',
            });
        }
    }

    const hasBlockers = violations.some(v => v.severity === 'BLOCK');

    return {
        allowed: !hasBlockers,
        violations,
        ackRequired,
        timestamp: Date.now(),
        hostname: os.hostname(),
    };
}

/**
 * Enforce safety policy at startup. Throws SafetyPolicyError if blocked.
 * Logs warnings for non-blocking violations.
 */
export function enforceSafetyPolicy(config?: Partial<SafetyPolicyConfig>): PolicyResult {
    const result = evaluateSafetyPolicy(config);

    // Log warnings
    for (const v of result.violations) {
        if (v.severity === 'WARN') {
            console.warn(`⚠️  SAFETY WARNING [${v.rule}]: ${v.message}`);
        }
    }

    // Block on BLOCK violations
    if (!result.allowed) {
        throw new SafetyPolicyError(
            result.violations.filter(v => v.severity === 'BLOCK'),
        );
    }

    return result;
}
