#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const VALID_PROFILES = new Set(['testnet', 'mainnet']);

function usage() {
    console.log('Usage: node scripts/use-env-profile.js <testnet|mainnet> [--target <path-to-.env>] [--force] [--no-backup]');
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const profile = args[0];
    let targetPath = '.env';
    let force = false;
    let noBackup = false;

    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--target') {
            const next = args[index + 1];
            if (!next) throw new Error('--target requires a file path');
            targetPath = next;
            index += 1;
            continue;
        }
        if (arg === '--force') {
            force = true;
            continue;
        }
        if (arg === '--no-backup') {
            noBackup = true;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return { profile, targetPath, force, noBackup };
}

function resolveProfilePath(rootDir, profile) {
    const localOverride = path.resolve(rootDir, `.env.${profile}.local`);
    if (fs.existsSync(localOverride)) return localOverride;
    return path.resolve(rootDir, `.env.${profile}`);
}

function enforceMainnetConfirmation(force) {
    if (force) return;
    if (process.env.CONFIRM_MAINNET === 'YES') return;
    throw new Error(
        'Refusing to activate mainnet profile without explicit confirmation. ' +
        'Re-run with CONFIRM_MAINNET=YES or --force.'
    );
}

function backupIfExists(absTarget) {
    if (!fs.existsSync(absTarget)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${absTarget}.bak-${stamp}`;
    fs.copyFileSync(absTarget, backupPath);
    return backupPath;
}

function main() {
    const { profile, targetPath, force, noBackup } = parseArgs(process.argv);

    if (!profile || !VALID_PROFILES.has(profile)) {
        usage();
        process.exit(2);
    }

    if (profile === 'mainnet') {
        enforceMainnetConfirmation(force);
    }

    const rootDir = process.cwd();
    const sourcePath = resolveProfilePath(rootDir, profile);
    const absTarget = path.resolve(rootDir, targetPath);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(
            `Profile file not found: ${sourcePath}. ` +
            `Create .env.${profile} (or .env.${profile}.local) first.`
        );
    }

    const backupPath = noBackup ? null : backupIfExists(absTarget);
    fs.copyFileSync(sourcePath, absTarget);

    console.log(`[env-profile] Activated profile: ${profile}`);
    console.log(`[env-profile] Source: ${sourcePath}`);
    console.log(`[env-profile] Target: ${absTarget}`);
    if (backupPath) {
        console.log(`[env-profile] Previous .env backup: ${backupPath}`);
    }

    if (profile === 'mainnet') {
        console.warn('[env-profile] Mainnet profile activated. Confirm PAPER_TRADING and safety acknowledgements before running.');
    }
}

try {
    main();
} catch (error) {
    console.error(`[env-profile] ${error.message}`);
    process.exit(1);
}
