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
        // Block production usage
        if (process.env.NODE_ENV === 'production') {
            throw new Error(
                'SeedSigner is disabled in production. ' +
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
}

/**
 * XummSigner - Uses Xumm wallet for signing.
 *
 * This is a scaffold implementation. Full implementation requires:
 * - Xumm SDK integration
 * - WebSocket for sign request/response
 * - User approval flow
 */
export class XummSigner implements Signer {
    readonly type = 'xumm' as const;
    private apiKey: string;
    private apiSecret: string;
    private userToken?: string;

    constructor(apiKey: string, apiSecret: string, userToken?: string) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.userToken = userToken;
    }

    async getAddress(): Promise<string> {
        // TODO: Implement Xumm SDK call to get linked account
        throw new Error('XummSigner.getAddress() not implemented. Requires Xumm SDK.');
    }

    async signTx(tx: Transaction): Promise<SignedTransaction> {
        // TODO: Implement Xumm sign request flow
        // 1. Create sign request via Xumm API
        // 2. Wait for user approval (WebSocket or polling)
        // 3. Return signed tx_blob
        throw new Error('XummSigner.signTx() not implemented. Requires Xumm SDK.');
    }

    async isReady(): Promise<boolean> {
        return !!this.userToken;
    }
}

/**
 * LedgerSigner - Uses Ledger hardware wallet.
 *
 * This is a scaffold implementation. Full implementation requires:
 * - @ledgerhq/hw-transport-node-hid or WebUSB transport
 * - XRP app communication protocol
 */
export class LedgerSigner implements Signer {
    readonly type = 'ledger' as const;
    private derivationPath: string;

    constructor(derivationPath = "44'/144'/0'/0/0") {
        this.derivationPath = derivationPath;
    }

    async getAddress(): Promise<string> {
        // TODO: Implement Ledger HID communication
        throw new Error('LedgerSigner.getAddress() not implemented. Requires Ledger HW library.');
    }

    async signTx(tx: Transaction): Promise<SignedTransaction> {
        // TODO: Implement Ledger signing
        // 1. Connect to Ledger device
        // 2. Open XRP app
        // 3. Send transaction for signing
        // 4. Wait for user confirmation on device
        // 5. Return signed tx_blob
        throw new Error('LedgerSigner.signTx() not implemented. Requires Ledger HW library.');
    }

    async isReady(): Promise<boolean> {
        // TODO: Check if Ledger is connected and XRP app is open
        return false;
    }
}

/**
 * KmsSigner - Uses cloud Key Management Service.
 *
 * This is a scaffold for AWS KMS. Similar patterns for GCP/Azure.
 * Requires the private key to be stored in KMS with sign permissions.
 */
export class KmsSigner implements Signer {
    readonly type = 'kms' as const;
    private keyId: string;
    private region: string;

    constructor(keyId: string, region = 'us-east-1') {
        this.keyId = keyId;
        this.region = region;
    }

    async getAddress(): Promise<string> {
        // TODO: Implement - derive address from KMS public key
        // 1. Call KMS GetPublicKey
        // 2. Derive XRPL address from public key
        throw new Error('KmsSigner.getAddress() not implemented. Requires AWS SDK.');
    }

    async signTx(tx: Transaction): Promise<SignedTransaction> {
        // TODO: Implement KMS signing
        // 1. Serialize transaction for signing
        // 2. Call KMS Sign with ECDSA_SHA_256
        // 3. Construct signed transaction blob
        throw new Error('KmsSigner.signTx() not implemented. Requires AWS SDK.');
    }

    async isReady(): Promise<boolean> {
        // TODO: Check KMS key accessibility
        return false;
    }
}

/**
 * Create a signer based on environment configuration.
 */
export function createSignerFromEnv(): Signer {
    const seed = process.env.XRPL_SEED;
    const secretNumbers = process.env.XRPL_SECRET_NUMBERS;
    const xummApiKey = process.env.XUMM_API_KEY;
    const kmsKeyId = process.env.KMS_KEY_ID;

    // Production: require non-seed signer
    if (process.env.NODE_ENV === 'production') {
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
        throw new Error(
            'Production requires KMS_KEY_ID or XUMM_API_KEY. ' +
            'Seed-based signing is disabled in production.'
        );
    }

    // Development: allow seed signer
    if (secretNumbers) {
        return new SeedSigner(secretNumbers, true);
    }
    if (seed) {
        return new SeedSigner(seed, false);
    }

    throw new Error(
        'No signing credentials found. Set XRPL_SEED or XRPL_SECRET_NUMBERS ' +
        'for development, or KMS_KEY_ID/XUMM_API_KEY for production.'
    );
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
        const prepared = await client.autofill({
            ...tx,
            Account: address,
        } as Transaction);

        // Sign
        const signed = await signer.signTx(prepared);

        // Submit
        const result = await client.submitAndWait(signed.tx_blob);

        const meta = result.result.meta;
        if (meta && typeof meta === 'object' && 'TransactionResult' in meta) {
            if (meta.TransactionResult === 'tesSUCCESS') {
                return { success: true, hash: signed.hash };
            }
            return { success: false, hash: signed.hash, error: meta.TransactionResult };
        }

        return { success: false, error: 'Unknown transaction result' };
    } catch (err: any) {
        return { success: false, error: err?.message || 'Transaction failed' };
    }
}
