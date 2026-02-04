#!/usr/bin/env ts-node
/**
 * CLI helper to encrypt mainnet secret numbers.
 * 
 * Usage:
 *   npm run encrypt:mainnet-secret
 * 
 * Security:
 *   - All input is hidden (no echo to terminal)
 *   - Secrets are never logged or printed
 *   - Only accepts input via stdin prompts (no argv/env)
 * 
 * Note on secret numbers:
 *   - Leading zeros are preserved (e.g., 002806 stays as 002806)
 *   - Groups are treated as strings, not numbers
 *   - Input: 8 groups separated by commas or spaces
 * 
 * Outputs:
 *   XRPL_SECRET_NUMBERS_MAINNET_ENC=<base64>
 */

import readline from 'readline';
import { encryptToBase64 } from '../src/security/secretBox';

const SECRET_NUMBERS_COUNT = 8;

function createRL(): readline.Interface {
    if (!process.stdin.isTTY) {
        throw new Error('This script requires an interactive terminal (TTY)');
    }
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });
}

function askHidden(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => {
        // Print the question first
        process.stdout.write(question);

        // Suppress echo for typed characters
        // @ts-ignore - internal API for hidden input
        const originalWrite = rl._writeToOutput;
        // @ts-ignore
        rl._writeToOutput = () => { };

        rl.question('', (answer) => {
            // @ts-ignore
            rl._writeToOutput = originalWrite;
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

/**
 * Validate and normalize secret numbers.
 * Preserves leading zeros by treating each group as a string.
 * Returns comma-separated format: "123456,002806,..."
 */
function validateSecretNumbers(input: string): string {
    // Split on any non-digit characters (commas, spaces, etc.)
    const parts = input
        .split(/[^0-9]+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    if (parts.length !== SECRET_NUMBERS_COUNT) {
        throw new Error(`Invalid format: expected ${SECRET_NUMBERS_COUNT} groups`);
    }

    // Validate each part as a 6-digit string (pad if needed, preserve leading zeros)
    const normalized = parts.map((part, idx) => {
        const num = Number(part);
        if (!Number.isInteger(num) || num < 0 || num > 999_999) {
            throw new Error(`Invalid format: group ${idx + 1} out of range`);
        }
        // Pad to 6 digits, preserving leading zeros
        return part.padStart(6, '0');
    });

    return normalized.join(',');
}

async function main(): Promise<void> {
    // Reject if secrets passed via argv or specific env vars
    if (process.argv.length > 2) {
        throw new Error('Do not pass secrets via command line arguments');
    }
    if (process.env.XRPL_SECRET_NUMBERS_INPUT) {
        throw new Error('Do not pass secrets via environment variables');
    }

    console.log('=== XRPL Secret Numbers Encryption ===');
    console.log('All input is hidden for security.\n');

    const rl = createRL();

    try {
        // Get secret numbers (hidden)
        const rawNumbers = await askHidden(
            rl,
            'Enter secret numbers (8 groups, hidden): '
        );

        // Validate format without printing plaintext
        const normalized = validateSecretNumbers(rawNumbers);

        // Get passphrase (hidden)
        const passphrase = await askHidden(rl, 'Enter encryption passphrase (min 8 chars): ');
        if (passphrase.length < 8) {
            throw new Error('Passphrase must be at least 8 characters');
        }

        const confirm = await askHidden(rl, 'Confirm passphrase: ');
        if (passphrase !== confirm) {
            throw new Error('Passphrases do not match');
        }

        // Encrypt and output only the env line
        const encrypted = encryptToBase64(normalized, passphrase);

        console.log('');
        console.log(`XRPL_SECRET_NUMBERS_MAINNET_ENC=${encrypted}`);

    } finally {
        rl.close();
    }
}

main().catch((err) => {
    // Don't leak any secret data in error messages
    const safeMessage = err.message?.includes('secret')
        ? err.message
        : `Error: ${err.message}`;
    console.error(`\n✗ ${safeMessage}`);
    process.exit(1);
});
