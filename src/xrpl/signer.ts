/**
 * Signer interface for XRPL transaction signing.
 *
 * This abstraction allows swapping between different signing methods:
 * - SeedSigner: Development only, uses plaintext seed
 * - XummSigner: Uses Xumm wallet for user signing
 * - LedgerSigner: Uses Ledger hardware wallet
 * - KmsSigner: Uses cloud KMS (AWS/GCP/Azure)
 */

import { Wallet, Transaction, Client } from 'xrpl';
import { walletFromSecretNumbers } from 'xrpl/dist/npm/Wallet/walletFromSecretNumbers';

export interface SignedTransaction {
    tx_blob: string;
    hash?: string;
}

/**
 * Report from a signer about its operational readiness.
 */
export interface SignerReadinessReport {
    type: string;
    ready: boolean;
    reason: string;
    /** Whether credentials/config are present (even if SDK is missing). */
    hasCredentials: boolean;
}

/**
 * Thrown by non-implemented signers (KMS, Xumm, Ledger).
 * Provides actionable error messages with installation instructions.
 */
export class SignerNotImplementedError extends Error {
    constructor(
        public readonly signerType: string,
        public readonly installHint: string,
    ) {
        super(
            `Signer "${signerType}" is not implemented. ${installHint} ` +
            'See docs/security-key-rotation.md for integration guidance.'
        );
        this.name = 'SignerNotImplementedError';
    }
}

export interface Signer {
    readonly type: 'seed' | 'xumm' | 'ledger' | 'kms';

    /**
     * Get the wallet address (public).
     */
    getAddress(): Promise<string>;

    /**
     * Sign a transaction.
     * The transaction should be prepared/autofilled before signing.
     */
    signTx(tx: Transaction): Promise<SignedTransaction>;

    /**
     * Optional: Check if the signer is ready/connected.
     */
    isReady?(): Promise<boolean>;

    /**
     * Optional: Get a detailed readiness report.
     */
    getReadinessReport?(): SignerReadinessReport;
}

/**
 * SeedSigner - Development/testing only.
 *
 * ⚠️ SECURITY WARNING: This signer uses plaintext seeds and is
 * DISABLED in production environments. Use hardware wallets or
 * KMS for production deployments.
 */
export class SeedSigner implements Signer {
    readonly type = 'seed' as const;
    private wallet: Wallet;

    constructor(seedOrSecretNumbers: string, isSecretNumbers = false) {
        // Block mainnet and production usage
        if (isMainnetContext()) {
            throw new Error(
                'SeedSigner is disabled on mainnet and in production. ' +
                'Use hardware wallet (Ledger), Xumm, or KMS signer instead.'
            );
        }

        if (isSecretNumbers) {
            const nums = seedOrSecretNumbers.split(',').map((n) => n.trim());
            this.wallet = walletFromSecretNumbers(nums);
        } else {
            this.wallet = Wallet.fromSeed(seedOrSecretNumbers);
        }

        console.warn(
            '[SeedSigner] ⚠️  Using development-only seed signer. ' +
            'DO NOT use in production!'
        );
    }

    async getAddress(): Promise<string> {
        return this.wallet.classicAddress;
    }

    async signTx(tx: Transaction): Promise<SignedTransaction> {
        const signed = this.wallet.sign(tx);
        return {
            tx_blob: signed.tx_blob,
            hash: signed.hash,
        };
    }

    async isReady(): Promise<boolean> {
        return true;
    }

    /**
     * Get the underlying wallet (for legacy code migration).
     * @deprecated Use signTx() instead
     */
    getWallet(): Wallet {
        console.warn('[SeedSigner] getWallet() is deprecated. Use signTx() instead.');
        return this.wallet;
    }

    getReadinessReport(): SignerReadinessReport {
        return {
            type: 'seed',
            ready: true,
            reason: 'Seed signer ready (development/testnet only)',
            hasCredentials: true,
        };
    }
}

/**
 * XummSigner - Uses Xumm wallet for signing.
 *
 * HARD FAILURE: This signer requires the xumm-sdk package which is not
 * included as a dependency. Install it and implement the signing flow
 * before using this signer in production.
 *
 * When implemented, the flow is:
 * 1. Create a sign request via Xumm API
 * 2. User approves on their Xumm mobile app
 * 3. Signed tx_blob is returned via WebSocket/polling
 */
export class XummSigner implements Signer {
    readonly type = 'xumm' as const;
    private _apiKey: string;
    private _apiSecret: string;
    constructor(apiKey: string, apiSecret: string, _userToken?: string) {
        this._apiKey = apiKey;
        this._apiSecret = apiSecret;
    }

    /** Get configuration for future implementation */
    protected getConfig(): { apiKey: string; apiSecret: string } {
        return { apiKey: this._apiKey, apiSecret: this._apiSecret };
    }

    async getAddress(): Promise<string> {
        throw new SignerNotImplementedError(
            'xumm',
            'Install xumm-sdk and implement getAddress() to derive the linked account.',
        );
    }

    async signTx(_tx: Transaction): Promise<SignedTransaction> {
        throw new SignerNotImplementedError(
            'xumm',
            'Install xumm-sdk and implement the sign-request flow (create request → user approval → tx_blob).',
        );
    }

    async isReady(): Promise<boolean> {
        // Cannot be ready without the SDK
        return false;
    }

    getReadinessReport(): SignerReadinessReport {
        return {
            type: 'xumm',
            ready: false,
            reason: 'Xumm SDK not installed. Run: npm install xumm-sdk',
            hasCredentials: !!(this._apiKey && this._apiSecret),
        };
    }
}

/**
 * LedgerSigner - Uses Ledger hardware wallet for signing.
 *
 * HARD FAILURE: This signer requires @ledgerhq/hw-transport-node-hid
 * and the XRP app communication protocol. Install the transport library
 * and implement the signing flow before using.
 *
 * When implemented, the flow is:
 * 1. Connect to Ledger device via USB/HID
 * 2. Open XRP app on device
 * 3. Send serialized transaction to device
 * 4. User confirms on device screen
 * 5. Device returns signature
 */
export class LedgerSigner implements Signer {
    readonly type = 'ledger' as const;
    private _derivationPath: string;

    constructor(derivationPath = "44'/144'/0'/0/0") {
        this._derivationPath = derivationPath;
    }

    /** Get derivation path for future implementation */
    protected getDerivationPath(): string {
        return this._derivationPath;
    }

    async getAddress(): Promise<string> {
        throw new SignerNotImplementedError(
            'ledger',
            'Install @ledgerhq/hw-transport-node-hid and implement Ledger XRP app communication.',
        );
    }

    async signTx(_tx: Transaction): Promise<SignedTransaction> {
        throw new SignerNotImplementedError(
            'ledger',
            'Install @ledgerhq/hw-transport-node-hid and implement device signing flow.',
        );
    }

    async isReady(): Promise<boolean> {
        return false;
    }

    getReadinessReport(): SignerReadinessReport {
        return {
            type: 'ledger',
            ready: false,
            reason: 'Ledger HW library not installed. Run: npm install @ledgerhq/hw-transport-node-hid',
            hasCredentials: true, // No credentials needed — hardware device
        };
    }
}

/**
 * KmsSigner - Uses cloud Key Management Service (AWS KMS).
 *
 * HARD FAILURE: This signer requires @aws-sdk/client-kms.
 * The XRPL private key must be stored as an asymmetric key in KMS
 * with ECDSA_SHA_256 signing permissions (secp256k1).
 *
 * When implemented, the flow is:
 * 1. Call KMS GetPublicKey to derive the XRPL r-address
 * 2. Serialize transaction for signing (per XRPL spec)
 * 3. Call KMS Sign with ECDSA_SHA_256
 * 4. Construct the signed transaction blob with DER signature
 */
export class KmsSigner implements Signer {
    readonly type = 'kms' as const;
    private _keyId: string;
    private _region: string;

    constructor(keyId: string, region = 'us-east-1') {
        this._keyId = keyId;
        this._region = region;
    }

    /** Get KMS configuration for future implementation */
    protected getKmsConfig(): { keyId: string; region: string } {
        return { keyId: this._keyId, region: this._region };
    }

    async getAddress(): Promise<string> {
        throw new SignerNotImplementedError(
            'kms',
            'Install @aws-sdk/client-kms and implement GetPublicKey → XRPL address derivation.',
        );
    }

    async signTx(_tx: Transaction): Promise<SignedTransaction> {
        throw new SignerNotImplementedError(
            'kms',
            'Install @aws-sdk/client-kms and implement KMS Sign → XRPL tx_blob construction.',
        );
    }

    async isReady(): Promise<boolean> {
        return false;
    }

    getReadinessReport(): SignerReadinessReport {
        return {
            type: 'kms',
            ready: false,
            reason: 'AWS KMS SDK not installed. Run: npm install @aws-sdk/client-kms',
            hasCredentials: !!this._keyId,
        };
    }
}

/**
 * Whether the runtime is targeting mainnet (live funds).
 * Checks both NODE_ENV and XRPL_NETWORK to prevent accidental mainnet
 * usage with development-only signers.
 */
function isMainnetContext(): boolean {
    return (
        process.env.XRPL_NETWORK === 'mainnet' ||
        process.env.NODE_ENV === 'production'
    );
}

/**
 * Create a signer based on environment configuration.
 *
 * Security gates:
 *   1. Mainnet context (XRPL_NETWORK=mainnet OR NODE_ENV=production)
 *      requires a non-seed signer (KMS, Xumm, or Ledger).
 *   2. Non-seed signers are scaffolds — createSignerFromEnv() will throw
 *      at startup rather than silently accepting an unusable signer.
 *      Set SIGNER_SKIP_READY_CHECK=true to bypass (for integration testing only).
 */
export function createSignerFromEnv(): Signer {
    const seed = process.env.XRPL_SEED;
    const secretNumbers = process.env.XRPL_SECRET_NUMBERS;
    const xummApiKey = process.env.XUMM_API_KEY;
    const kmsKeyId = process.env.KMS_KEY_ID;
    const ledgerEnabled = process.env.LEDGER_ENABLED === 'true';

    // Mainnet / production: require non-seed signer
    if (isMainnetContext()) {
        if (kmsKeyId) {
            return new KmsSigner(kmsKeyId, process.env.AWS_REGION);
        }
        if (xummApiKey) {
            return new XummSigner(
                xummApiKey,
                process.env.XUMM_API_SECRET || '',
                process.env.XUMM_USER_TOKEN
            );
        }
        if (ledgerEnabled) {
            return new LedgerSigner(process.env.LEDGER_DERIVATION_PATH);
        }
        throw new Error(
            'Mainnet/production requires KMS_KEY_ID, XUMM_API_KEY, or LEDGER_ENABLED=true. ' +
            'Seed-based signing is disabled on mainnet and in production.'
        );
    }

    // Development / testnet: allow seed signer
    if (secretNumbers) {
        return new SeedSigner(secretNumbers, true);
    }
    if (seed) {
        return new SeedSigner(seed, false);
    }

    throw new Error(
        'No signing credentials found. Set XRPL_SEED or XRPL_SECRET_NUMBERS ' +
        'for development, or KMS_KEY_ID/XUMM_API_KEY/LEDGER_ENABLED for production.'
    );
}

/**
 * Verify that a signer is operational before the bot starts trading.
 * Performs a multi-step readiness check:
 *   1. isReady() — basic connectivity/configuration check
 *   2. getAddress() — confirms the signer can derive an address
 *   3. (SeedSigner only) dry-run signing of a dummy Payment tx
 *
 * Non-seed signers will fail fast with a clear error explaining
 * which SDK needs to be installed.
 *
 * @throws SignerNotImplementedError if the signer backend is not available
 * @throws Error if the signer reports not-ready and skip is not set
 */
export async function assertSignerReady(signer: Signer): Promise<void> {
    if (process.env.SIGNER_SKIP_READY_CHECK === 'true') {
        return;
    }

    // Step 1: readiness report (if available)
    if (typeof signer.getReadinessReport === 'function') {
        const report = signer.getReadinessReport();
        if (!report.ready) {
            throw new SignerNotImplementedError(report.type, report.reason);
        }
    }

    // Step 2: isReady check
    if (typeof signer.isReady === 'function') {
        const ready = await signer.isReady();
        if (!ready) {
            throw new Error(
                `Signer type "${signer.type}" is not ready. ` +
                'The selected signing backend is not operational. ' +
                'Use a seed signer on testnet, or set SIGNER_SKIP_READY_CHECK=true to bypass.'
            );
        }
    }

    // Step 3: address derivation check
    try {
        const address = await signer.getAddress();
        if (!address || typeof address !== 'string' || address.length < 25) {
            throw new Error(`Signer returned invalid address: ${address}`);
        }
    } catch (err) {
        if (err instanceof SignerNotImplementedError) throw err;
        throw new Error(
            `Signer "${signer.type}" failed address derivation: ${err instanceof Error ? err.message : 'unknown'}`
        );
    }

    // Step 4: dry-run signing (SeedSigner only — non-seed signers may require
    // hardware interaction or network calls, so we skip for them)
    if (signer.type === 'seed') {
        try {
            const dummyTx: Transaction = {
                TransactionType: 'Payment',
                Account: await signer.getAddress(),
                Destination: await signer.getAddress(), // self-payment
                Amount: '1', // 1 drop
                Fee: '12',
                Sequence: 0,
            };
            const signed = await signer.signTx(dummyTx);
            if (!signed.tx_blob || typeof signed.tx_blob !== 'string') {
                throw new Error('Dry-run signing returned empty tx_blob');
            }
        } catch (err) {
            throw new Error(
                `Signer "${signer.type}" dry-run signing failed: ${err instanceof Error ? err.message : 'unknown'}`
            );
        }
    }
}

/**
 * Sign and submit a transaction.
 * Convenience function that handles the full flow.
 */
export async function signAndSubmit(
    client: Client,
    signer: Signer,
    tx: Omit<Transaction, 'Account'>
): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
        const address = await signer.getAddress();

        // Add account and autofill
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const prepared = await client.autofill({
            ...tx,
            Account: address,
        } as any);

        // Sign
        const signed = await signer.signTx(prepared);

        // Submit
        const result = await client.submitAndWait(signed.tx_blob);

        const meta = result.result.meta;
        if (meta && typeof meta === 'object' && 'TransactionResult' in meta) {
            if (meta.TransactionResult === 'tesSUCCESS') {
                return { success: true, ...(signed.hash ? { hash: signed.hash } : {}) };
            }
            return { success: false, ...(signed.hash ? { hash: signed.hash } : {}), error: meta.TransactionResult };
        }

        return { success: false, error: 'Unknown transaction result' };
    } catch (err: any) {
        return { success: false, error: err?.message || 'Transaction failed' };
    }
}
