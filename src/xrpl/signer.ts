/**
 * Signer interface for XRPL transaction signing.
 *
 * This abstraction allows swapping between different signing methods:
 * - SeedSigner: Development only, uses plaintext seed
 * - XummSigner: Uses Xumm wallet for user signing
 * - LedgerSigner: Uses Ledger hardware wallet
 * - KmsSigner: Uses cloud KMS (AWS/GCP/Azure)
 */

import { Wallet, Transaction, Client, encode, encodeForSigning, hashes } from 'xrpl';
import { walletFromSecretNumbers } from 'xrpl/dist/npm/Wallet/walletFromSecretNumbers';
import { deriveAddress } from 'ripple-keypairs';
import { createHash } from 'crypto';

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
 * KmsSigner — Production-grade AWS KMS signing for XRPL.
 *
 * The KMS key MUST be:
 *   - Key spec: ECC_SECG_P256K1 (secp256k1)
 *   - Key usage: SIGN_VERIFY
 *   - Signing algorithm: ECDSA_SHA_256
 *
 * Flow:
 * 1. GetPublicKey → DER-encoded SubjectPublicKeyInfo
 * 2. Extract raw 33-byte compressed secp256k1 public key
 * 3. deriveAddress(compressedPubKeyHex) → XRPL classic address
 * 4. For signing: encodeForSigning(tx) → SHA-512Half → KMS Sign → DER sig → tx_blob
 */
export class KmsSigner implements Signer {
    readonly type = 'kms' as const;
    private _keyId: string;
    private _region: string;
    private _kmsClient: any | null = null;
    /** Cached compressed public key (33 bytes, hex-encoded) */
    private _compressedPubKeyHex: string | null = null;
    /** Cached XRPL classic address (KMS-derived or overridden via accountAddress) */
    private _address: string | null = null;
    /**
     * When set, getAddress() returns this address instead of the KMS-derived one.
     * Used for Regular Key mode: the KMS key signs on behalf of an existing account.
     */
    private _accountAddress: string | null;

    constructor(keyId: string, region = 'us-east-1', accountAddress?: string) {
        this._keyId = keyId;
        this._region = region;
        this._accountAddress = accountAddress ?? null;
    }

    /** Lazily create the KMS client (avoids import at module load time). */
    private async getKmsClient(): Promise<any> {
        if (this._kmsClient) return this._kmsClient;
        const { KMSClient } = await import('@aws-sdk/client-kms');
        this._kmsClient = new KMSClient({ region: this._region });
        return this._kmsClient;
    }

    /**
     * Fetch the public key from KMS and derive the XRPL address.
     *
     * KMS returns a DER-encoded SubjectPublicKeyInfo structure.
     * For ECC_SECG_P256K1, the raw public key is a 65-byte uncompressed
     * point (04 || x || y). We compress it to 33 bytes (02/03 || x).
     */
    /**
     * Ensure the KMS public key is fetched and cached.
     * Must be called before signing (signTx calls it automatically).
     */
    private async ensurePubKey(): Promise<void> {
        if (this._compressedPubKeyHex) return;

        const client = await this.getKmsClient();
        const { GetPublicKeyCommand } = await import('@aws-sdk/client-kms');

        const response = await client.send(new GetPublicKeyCommand({
            KeyId: this._keyId,
        }));

        if (!response.PublicKey) {
            throw new Error('KMS GetPublicKey returned no public key data');
        }

        // Validate key spec
        if (response.KeySpec !== 'ECC_SECG_P256K1') {
            throw new Error(
                `KMS key spec is "${response.KeySpec}", expected "ECC_SECG_P256K1". ` +
                'Create a new KMS key with Key spec: ECC_SECG_P256K1 (secp256k1).'
            );
        }

        // Parse the DER-encoded SubjectPublicKeyInfo to extract raw public key
        const derBytes = new Uint8Array(response.PublicKey);
        const rawPubKey = extractPublicKeyFromDer(derBytes);

        // Compress the public key (65 bytes uncompressed → 33 bytes compressed)
        const compressed = compressPublicKey(rawPubKey);
        this._compressedPubKeyHex = Buffer.from(compressed).toString('hex').toUpperCase();

        // Derive address from KMS key (used as fallback when no accountAddress)
        const kmsAddr = deriveAddress(this._compressedPubKeyHex);
        if (!this._accountAddress) {
            this._address = kmsAddr;
        } else {
            this._address = this._accountAddress;
        }
    }

    async getAddress(): Promise<string> {
        if (this._address) return this._address;
        await this.ensurePubKey();
        return this._address!;
    }

    /**
     * Sign an XRPL transaction using AWS KMS.
     *
     * XRPL signing flow:
     * 1. Serialize tx for signing via encodeForSigning()
     * 2. SHA-512 hash and take first 32 bytes (SHA-512Half)
     * 3. Send the 32-byte hash to KMS for ECDSA_SHA_256 signing
     *    (KMS signs the raw hash — we do NOT double-hash)
     * 4. Convert KMS DER signature to XRPL canonical form
     * 5. Attach SigningPubKey + TxnSignature, encode to tx_blob
     */
    async signTx(tx: Transaction): Promise<SignedTransaction> {
        // Ensure we have the public key cached
        await this.ensurePubKey();

        // Step 1: Serialize the transaction for signing
        const serializedHex = encodeForSigning(tx);
        const serializedBytes = Buffer.from(serializedHex, 'hex');

        // Step 2: SHA-512Half (first 32 bytes of SHA-512)
        const sha512 = createHash('sha512').update(serializedBytes).digest();
        const hashToSign = sha512.subarray(0, 32);

        // Step 3: Sign with KMS using ECDSA_SHA_256
        // We pass a pre-computed 32-byte hash. KMS with ECDSA_SHA_256
        // and MessageType=DIGEST signs the raw bytes directly.
        const client = await this.getKmsClient();
        const { SignCommand } = await import('@aws-sdk/client-kms');

        const signResponse = await client.send(new SignCommand({
            KeyId: this._keyId,
            Message: hashToSign,
            MessageType: 'DIGEST',
            SigningAlgorithm: 'ECDSA_SHA_256',
        }));

        if (!signResponse.Signature) {
            throw new Error('KMS Sign returned no signature data');
        }

        // Step 4: Convert DER signature to XRPL canonical hex
        const derSig = new Uint8Array(signResponse.Signature);
        const { r, s } = parseDerSignature(derSig);
        const canonicalSig = canonicalizeSignature(r, s);
        const sigHex = Buffer.from(canonicalSig).toString('hex').toUpperCase();

        // Step 5: Attach signature and public key to transaction
        const signedTx = {
            ...tx,
            SigningPubKey: this._compressedPubKeyHex!,
            TxnSignature: sigHex,
        };

        // Encode to tx_blob
        const txBlob = encode(signedTx);

        // Compute transaction hash
        const txHash = hashes.hashSignedTx(txBlob);

        return {
            tx_blob: txBlob,
            hash: txHash,
        };
    }

    async isReady(): Promise<boolean> {
        try {
            // Verify we can reach KMS and the key exists
            await this.ensurePubKey();
            return true;
        } catch {
            return false;
        }
    }

    getReadinessReport(): SignerReadinessReport {
        const mode = this._accountAddress ? 'regular-key' : 'direct';
        return {
            type: 'kms',
            ready: !!this._compressedPubKeyHex,
            reason: this._compressedPubKeyHex
                ? `KMS signer ready (${mode}), address: ${this._address}`
                : 'KMS signer not yet initialized — call isReady() to connect',
            hasCredentials: !!this._keyId,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DER / secp256k1 helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the raw public key bytes from a DER-encoded SubjectPublicKeyInfo.
 *
 * For secp256k1, the structure is:
 * SEQUENCE {
 *   SEQUENCE { OID ecPublicKey, OID secp256k1 }
 *   BIT STRING { 0x04 || x (32 bytes) || y (32 bytes) }
 * }
 *
 * The raw uncompressed public key (65 bytes) starts after the BIT STRING
 * tag, length, and unused-bits byte.
 */
function extractPublicKeyFromDer(der: Uint8Array): Uint8Array {
    let offset = 0;

    // Outer SEQUENCE
    if (der[offset] !== 0x30) throw new Error('Expected SEQUENCE tag in DER public key');
    offset++;
    offset += derLengthSize(der, offset);

    // Inner SEQUENCE (algorithm identifier) — skip it
    if (der[offset] !== 0x30) throw new Error('Expected inner SEQUENCE tag');
    offset++;
    const innerLen = derReadLength(der, offset);
    offset += derLengthSize(der, offset) + innerLen;

    // BIT STRING containing the public key
    if (der[offset] !== 0x03) throw new Error('Expected BIT STRING tag for public key');
    offset++;
    const bitStringLen = derReadLength(der, offset);
    offset += derLengthSize(der, offset);

    // First byte of BIT STRING is unused bits count (should be 0)
    const unusedBits = der[offset];
    if (unusedBits !== 0) throw new Error(`Unexpected unused bits: ${unusedBits}`);
    offset++;

    const rawKey = der.slice(offset, offset + bitStringLen - 1);

    if (rawKey.length !== 65 || rawKey[0] !== 0x04) {
        throw new Error(
            `Expected 65-byte uncompressed public key (04 || x || y), got ${rawKey.length} bytes ` +
            `starting with 0x${rawKey[0]?.toString(16)}`
        );
    }

    return rawKey;
}

/**
 * Compress a 65-byte uncompressed secp256k1 public key to 33 bytes.
 * Format: (02 if y is even, 03 if y is odd) || x
 */
function compressPublicKey(uncompressed: Uint8Array): Uint8Array {
    if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
        throw new Error('Expected 65-byte uncompressed key starting with 0x04');
    }
    const x = uncompressed.slice(1, 33);
    const yLastByte = uncompressed[64]!;
    const prefix = (yLastByte & 1) === 0 ? 0x02 : 0x03;
    const compressed = new Uint8Array(33);
    compressed[0] = prefix;
    compressed.set(x, 1);
    return compressed;
}

/**
 * Parse a DER-encoded ECDSA signature into r and s components.
 * DER format: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
 */
function parseDerSignature(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
    let offset = 0;

    if (der[offset] !== 0x30) throw new Error('Expected SEQUENCE tag in DER signature');
    offset++;
    offset += derLengthSize(der, offset); // skip length

    // R component
    if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for R');
    offset++;
    const rLen = der[offset]!;
    offset++;
    const r = der.slice(offset, offset + rLen);
    offset += rLen;

    // S component
    if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for S');
    offset++;
    const sLen = der[offset]!;
    offset++;
    const s = der.slice(offset, offset + sLen);

    return { r, s };
}

/**
 * The secp256k1 curve order N.
 * All ECDSA s-values must be in the lower half (s <= N/2) for XRPL.
 */
const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

/**
 * Ensure the ECDSA signature is in canonical (low-S) form as required by XRPL.
 * If s > N/2, replace s with N - s.
 * Returns the signature as a fixed 64-byte buffer (32 bytes r + 32 bytes s).
 */
function canonicalizeSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
    let rBig = bytesToBigInt(r);
    let sBig = bytesToBigInt(s);

    // Enforce low-S
    if (sBig > SECP256K1_HALF_ORDER) {
        sBig = SECP256K1_ORDER - sBig;
    }

    // Encode as fixed 32-byte big-endian values
    const result = new Uint8Array(64);
    bigIntToBytes32(rBig, result, 0);
    bigIntToBytes32(sBig, result, 32);
    return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    let hex = '';
    for (const b of bytes) {
        hex += b.toString(16).padStart(2, '0');
    }
    return hex.length > 0 ? BigInt('0x' + hex) : 0n;
}

function bigIntToBytes32(value: bigint, target: Uint8Array, offset: number): void {
    const hex = value.toString(16).padStart(64, '0');
    for (let i = 0; i < 32; i++) {
        target[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
}

/** Read a DER length value and return it. */
function derReadLength(buf: Uint8Array, offset: number): number {
    const first = buf[offset]!;
    if (first < 0x80) return first;
    const numBytes = first & 0x7f;
    let len = 0;
    for (let i = 0; i < numBytes; i++) {
        len = (len << 8) | (buf[offset + 1 + i] ?? 0);
    }
    return len;
}

/** Return the number of bytes used to encode a DER length at the given offset. */
function derLengthSize(buf: Uint8Array, offset: number): number {
    const first = buf[offset]!;
    if (first < 0x80) return 1;
    return 1 + (first & 0x7f);
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
    const seed = process.env.XRPL_SEED || process.env.XRPL_SECRET;
    const secretNumbers = process.env.XRPL_SECRET_NUMBERS;
    const xummApiKey = process.env.XUMM_API_KEY;
    const kmsKeyId = process.env.KMS_KEY_ID;
    const ledgerEnabled = process.env.LEDGER_ENABLED === 'true';

    // Mainnet / production: require non-seed signer
    if (isMainnetContext()) {
        if (kmsKeyId) {
            return new KmsSigner(kmsKeyId, process.env.AWS_REGION, process.env.KMS_ACCOUNT_ADDRESS);
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
        'No signing credentials found. Set XRPL_SECRET, XRPL_SEED, or XRPL_SECRET_NUMBERS ' +
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
