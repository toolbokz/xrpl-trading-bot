/**
 * AES-256-GCM encryption for XRPL secret numbers.
 * Payload format: salt(16) | iv(12) | ciphertext | authTag(16) → base64
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_N = 2 ** 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return scryptSync(passphrase, salt, KEY_LENGTH, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
    });
}

/**
 * Encrypt plaintext secret numbers with a passphrase.
 * @returns base64-encoded payload: salt | iv | ciphertext | authTag
 */
export function encryptToBase64(plaintext: string, passphrase: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = deriveKey(passphrase, salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Payload: salt | iv | ciphertext | authTag
    const payload = Buffer.concat([salt, iv, encrypted, authTag]);
    return payload.toString('base64');
}

/**
 * Decrypt base64-encoded payload with a passphrase.
 * @throws Error if passphrase is wrong or payload is corrupt
 */
export function decryptFromBase64(payloadB64: string, passphrase: string): string {
    let payload: Buffer;
    try {
        payload = Buffer.from(payloadB64, 'base64');
    } catch {
        throw new Error('Failed to decrypt XRPL secret numbers (bad passphrase or corrupt payload)');
    }

    const minLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
    if (payload.length < minLength) {
        throw new Error('Failed to decrypt XRPL secret numbers (bad passphrase or corrupt payload)');
    }

    const salt = payload.subarray(0, SALT_LENGTH);
    const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = payload.subarray(payload.length - AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH, payload.length - AUTH_TAG_LENGTH);

    const key = deriveKey(passphrase, salt);

    try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]);
        return decrypted.toString('utf8');
    } catch {
        throw new Error('Failed to decrypt XRPL secret numbers (bad passphrase or corrupt payload)');
    }
}
