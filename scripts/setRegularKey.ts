#!/usr/bin/env ts-node
/**
 * Set a Regular Key on the current XRPL account.
 *
 * This authorises the KMS-derived key to sign transactions on behalf of
 * the existing account, so you keep your address, XRP, and trustlines.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/setRegularKey.ts
 *
 * Prerequisites:
 *   - .env.mainnet (or env vars) with encrypted secret numbers + passphrase
 *   - KMS_KEY_ID and AWS_REGION set (to derive the regular key address)
 *   - Account must be funded on mainnet
 */

import 'dotenv/config';
import { Client, Wallet } from 'xrpl';
import { Account } from 'xrpl-secret-numbers';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { deriveAddress } from 'ripple-keypairs';
import { decryptFromBase64 } from '../src/security/secretBox';

// ── helpers ──────────────────────────────────────────────────────────────────

function compressPubKey(raw65: Uint8Array): Buffer {
    const x = raw65.slice(1, 33);
    const yLastByte = raw65[64]!;
    const prefix = (yLastByte & 1) === 0 ? 0x02 : 0x03;
    return Buffer.concat([Buffer.from([prefix]), x]);
}

async function deriveKmsAddress(): Promise<string> {
    const keyId = process.env.KMS_KEY_ID;
    const region = process.env.AWS_REGION ?? 'us-east-1';
    if (!keyId) throw new Error('KMS_KEY_ID not set');

    const client = new KMSClient({ region });
    const res = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!res.PublicKey) throw new Error('KMS returned no public key');
    if (res.KeySpec !== 'ECC_SECG_P256K1') {
        throw new Error(`KMS key spec is "${res.KeySpec}", expected ECC_SECG_P256K1`);
    }

    const der = new Uint8Array(res.PublicKey);
    const raw = der.slice(der.length - 65);
    const compressed = compressPubKey(raw);
    return deriveAddress(compressed.toString('hex').toUpperCase());
}

async function loadCurrentWallet(): Promise<Wallet> {
    const enc = process.env.XRPL_SECRET_NUMBERS_MAINNET_ENC;
    const pass = process.env.XRPL_SECRET_PASSPHRASE;

    if (enc && pass) {
        const secretNumbers = decryptFromBase64(enc, pass);
        const parts = secretNumbers
            .split(/[^0-9]+/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
            .map((p) => p.padStart(6, '0'));
        const formatted = parts.join(' ');
        const account = new Account(formatted);
        const kp = account.getKeypair();
        return new Wallet(kp.publicKey, kp.privateKey);
    }

    const seed = process.env.XRPL_SEED ?? process.env.XRPL_SECRET;
    if (seed) return Wallet.fromSeed(seed);

    throw new Error('No wallet credentials found in env');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== SetRegularKey: authorise KMS signer on existing account ===\n');

    const wallet = await loadCurrentWallet();
    console.log('Current account:', wallet.classicAddress);

    const regularKeyAddr = await deriveKmsAddress();
    console.log('KMS regular key:', regularKeyAddr);

    const wssUrl = process.env.XRPL_WSS_URL ?? 'wss://s1.ripple.com';
    console.log(`\nConnecting to ${wssUrl} ...`);
    const client = new Client(wssUrl);
    await client.connect();

    // Check if a regular key is already set
    const info = await client.request({
        command: 'account_info',
        account: wallet.classicAddress,
        ledger_index: 'validated',
    });
    const existing = (info.result.account_data as any).RegularKey;
    if (existing === regularKeyAddr) {
        console.log('\n✅ Regular key is already set to this KMS address. Nothing to do.');
        await client.disconnect();
        return;
    }
    if (existing) {
        console.log(`⚠️  Existing regular key: ${existing}`);
        console.log(`   Will be REPLACED with: ${regularKeyAddr}\n`);
    }

    // Build SetRegularKey transaction
    const prepared = await client.autofill({
        TransactionType: 'SetRegularKey',
        Account: wallet.classicAddress,
        RegularKey: regularKeyAddr,
    });

    const signed = wallet.sign(prepared);
    console.log(`\nSubmitting SetRegularKey tx: ${signed.hash}`);

    const result = await client.submitAndWait(signed.tx_blob);
    const meta = result.result.meta as any;
    const resultCode = meta?.TransactionResult ?? 'UNKNOWN';
    console.log(`Result: ${resultCode}`);

    if (resultCode === 'tesSUCCESS') {
        console.log(`\n✅ Regular key set successfully!`);
        console.log(`   Account:     ${wallet.classicAddress}`);
        console.log(`   Regular key: ${regularKeyAddr}`);
        console.log(`\n   The KMS signer can now sign transactions for this account.`);
        console.log(`   Add to .env.mainnet:`);
        console.log(`   KMS_ACCOUNT_ADDRESS=${wallet.classicAddress}`);
    } else {
        console.error(`\n❌ Transaction failed: ${resultCode}`);
    }

    await client.disconnect();
}

main().catch((err) => {
    console.error('Fatal:', err.message ?? err);
    process.exit(1);
});
