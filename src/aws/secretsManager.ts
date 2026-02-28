/**
 * AWS Secrets Manager integration for XRPL Trading Bot.
 *
 * Fetches wallet credentials (seed, secret numbers, passphrase) from
 * AWS Secrets Manager at startup, injecting them into process.env before
 * the config module reads them.
 *
 * Enable by setting:
 *   AWS_SECRET_NAME=xrpl-trading-bot/wallet   (the secret name in SM)
 *   AWS_REGION=ap-southeast-2                  (region where the secret lives)
 *
 * The secret JSON should contain one or more of:
 *   {
 *     "XRPL_SECRET_NUMBERS_MAINNET_ENC": "...",
 *     "XRPL_SECRET_PASSPHRASE": "...",
 *     "XRPL_SEED_MAINNET": "s...",
 *     "XRPL_SECRET_MAINNET": "s...",
 *     "XRPL_SECRET_NUMBERS_MAINNET": "123456,..."
 *   }
 *
 * Any key present in the secret is set as a process.env variable
 * (unless already set — local env takes precedence).
 */

import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/** Env keys we allow the secret to populate. */
const ALLOWED_KEYS = new Set([
    'XRPL_SECRET_NUMBERS_MAINNET_ENC',
    'XRPL_SECRET_PASSPHRASE',
    'XRPL_SEED_MAINNET',
    'XRPL_SECRET_MAINNET',
    'XRPL_SECRET_NUMBERS_MAINNET',
    'XRPL_SEED',
    'XRPL_SECRET',
    'XRPL_SECRET_NUMBERS',
    'XRPL_SEED_TESTNET',
    'XRPL_SECRET_TESTNET',
    'XRPL_SECRET_NUMBERS_TESTNET',
    // KMS key ID can also be stored in Secrets Manager
    'KMS_KEY_ID',
]);

export interface SecretsManagerConfig {
    /** The name or ARN of the secret in AWS Secrets Manager. */
    secretName: string;
    /** AWS region (default: from AWS_REGION env or 'us-east-1'). */
    region?: string;
}

/**
 * Resolve SecretsManagerConfig from environment variables.
 * Returns null if AWS_SECRET_NAME is not set (feature disabled).
 */
export function resolveSecretsManagerConfig(): SecretsManagerConfig | null {
    const secretName = process.env.AWS_SECRET_NAME;
    if (!secretName) return null;

    return {
        secretName,
        region: process.env.AWS_REGION || 'us-east-1',
    };
}

/**
 * Fetch a secret from AWS Secrets Manager, parse the JSON payload,
 * and inject allowed keys into process.env.
 *
 * @returns The number of env vars injected, or 0 if nothing was fetched.
 * @throws If the secret cannot be retrieved or parsed.
 */
export async function loadSecretsIntoEnv(
    config: SecretsManagerConfig,
): Promise<number> {
    const clientOpts = config.region ? { region: config.region } : {};
    const client = new SecretsManagerClient(clientOpts);

    const response = await client.send(
        new GetSecretValueCommand({ SecretId: config.secretName }),
    );

    const raw = response.SecretString;
    if (!raw) {
        throw new Error(
            `AWS Secrets Manager secret "${config.secretName}" has no string value. ` +
            'Binary secrets are not supported — store credentials as a JSON string.',
        );
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(
            `AWS Secrets Manager secret "${config.secretName}" is not valid JSON.`,
        );
    }

    let injected = 0;
    for (const [key, value] of Object.entries(parsed)) {
        if (!ALLOWED_KEYS.has(key)) {
            console.warn(
                `[aws/secretsManager] Ignoring unknown key "${key}" from secret "${config.secretName}".`,
            );
            continue;
        }
        if (typeof value !== 'string' || value.length === 0) continue;

        // Local env takes precedence — don't overwrite.
        if (process.env[key]) {
            console.log(
                `[aws/secretsManager] Key "${key}" already set in env — skipping Secrets Manager value.`,
            );
            continue;
        }

        process.env[key] = value;
        injected++;
        console.log(`[aws/secretsManager] Injected "${key}" from Secrets Manager.`);
    }

    return injected;
}

/**
 * Top-level convenience: check if AWS_SECRET_NAME is configured, and if so,
 * load secrets before config is parsed. Safe to call even when not on AWS.
 */
export async function maybeLoadAwsSecrets(): Promise<void> {
    const config = resolveSecretsManagerConfig();
    if (!config) return; // Feature disabled — no-op.

    try {
        const count = await loadSecretsIntoEnv(config);
        console.log(
            `[aws/secretsManager] Loaded ${count} credential(s) from "${config.secretName}" in ${config.region}.`,
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Failed to load credentials from AWS Secrets Manager ` +
            `("${config.secretName}" in ${config.region}): ${msg}\n` +
            'Ensure the EC2 instance role has secretsmanager:GetSecretValue permission ' +
            'and the secret exists.',
        );
    }
}
