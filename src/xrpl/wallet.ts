import { Wallet } from 'xrpl';
import { Account } from 'xrpl-secret-numbers';
import { AppConfig } from '../config';
import { decryptFromBase64 } from '../security/secretBox';
import { promptHidden } from '../security/promptPassphrase';
import { logger } from '../analytics/logger';

type WalletNetwork = 'mainnet' | 'testnet';

interface WalletContext {
    wallet: Wallet;
    address: string;
    network: WalletNetwork;
}

let ctx: WalletContext | null = null;

const SECRET_NUMBERS_COUNT = 8;

const parseSecretNumbers = (raw: string | undefined): string => {
    if (!raw) {
        throw new Error('Secret numbers are required');
    }

    const parts = raw
        .split(/[^0-9]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (parts.length !== SECRET_NUMBERS_COUNT) {
        throw new Error(`Secret numbers must contain exactly ${SECRET_NUMBERS_COUNT} groups`);
    }

    // Pad each part to 6 digits (preserves leading zeros like 002806)
    const padded = parts.map((part, idx) => {
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0 || value > 999_999) {
            throw new Error(`Secret number group ${idx + 1} must be 0-999999`);
        }
        // Keep as string with leading zeros
        return part.padStart(6, '0');
    });

    // Validate padded format
    padded.forEach((part, idx) => {
        if (!/^\d{6}$/.test(part)) {
            throw new Error(`Secret number group ${idx + 1} has invalid format`);
        }
    });

    // Return space-separated format expected by xrpl-secret-numbers library
    return padded.join(' ');
};

export const walletFromSecretNumbers = (secretNumbers?: string): Wallet => {
    const formatted = parseSecretNumbers(secretNumbers);
    const account = new Account(formatted);
    const keypair = account.getKeypair();

    // Create xrpl Wallet from the keypair
    return new Wallet(keypair.publicKey, keypair.privateKey);
};

/**
 * Get mainnet secret numbers from environment, decrypting if necessary.
 * Prefers encrypted version (XRPL_SECRET_NUMBERS_MAINNET_ENC) over plaintext.
 */
async function getMainnetSecretNumbersFromEnv(): Promise<string | undefined> {
    const enc = process.env.XRPL_SECRET_NUMBERS_MAINNET_ENC;
    if (enc) {
        const pass =
            process.env.XRPL_SECRET_PASSPHRASE ??
            (await promptHidden('Enter passphrase to decrypt XRPL secret numbers: '));
        return decryptFromBase64(enc, pass);
    }

    // Fall back to plaintext (legacy)
    const plaintext = process.env.XRPL_SECRET_NUMBERS_MAINNET;
    if (plaintext) {
        logger.warn('Using plaintext XRPL_SECRET_NUMBERS_MAINNET. Consider encrypting with: npm run encrypt:mainnet-secret');
    }
    return plaintext;
}

/**
 * Resolve wallet from config, with async support for encrypted mainnet secrets.
 */
async function resolveWalletAsync(config: AppConfig): Promise<Wallet> {
    const isMainnet = config.xrpl.network === 'mainnet';

    // For mainnet, check for encrypted or plaintext secret numbers in env
    if (isMainnet) {
        const secretNumbers = await getMainnetSecretNumbersFromEnv();
        if (secretNumbers) {
            return walletFromSecretNumbers(secretNumbers);
        }
    }

    // Use config values (handles testnet and seed-based wallets)
    if (config.walletSecretNumbers) {
        return walletFromSecretNumbers(config.walletSecretNumbers);
    }
    if (config.walletSeed) {
        return Wallet.fromSeed(config.walletSeed);
    }

    throw new Error('No wallet credentials found. Set XRPL_SECRET_NUMBERS_MAINNET_ENC, XRPL_SECRET_NUMBERS_MAINNET, or XRPL_SEED.');
}

const resolveWallet = (config: AppConfig): Wallet => {
    if (config.walletSecretNumbers) {
        return walletFromSecretNumbers(config.walletSecretNumbers);
    }
    if (config.walletSeed) {
        return Wallet.fromSeed(config.walletSeed);
    }
    throw new Error('XRPL_SECRET_NUMBERS or XRPL_SEED is required for runtime');
};

const assertFaucetSafety = (network: string, enableTestnetFaucet: boolean): void => {
    if (network === 'mainnet' && enableTestnetFaucet) {
        throw new Error('ENABLE_TESTNET_FAUCET must be false on mainnet');
    }
};

/**
 * Initializes wallet context once for the process. Must be called before trading logic.
 * Now async to support encrypted secret numbers with passphrase prompt.
 */
export const initWallet = async (config: AppConfig): Promise<WalletContext> => {
    if (ctx) return ctx;

    const network = config.xrpl.network === 'mainnet' ? 'mainnet' : 'testnet';
    assertFaucetSafety(network, config.enableTestnetFaucet);

    const wallet = await resolveWalletAsync(config);

    ctx = { wallet, address: wallet.classicAddress, network };
    return ctx;
};

/**
 * @deprecated Use initWallet (async) instead. This sync version doesn't support encrypted secrets.
 */
export const initWalletSync = (config: AppConfig): WalletContext => {
    if (ctx) return ctx;

    const network = config.xrpl.network === 'mainnet' ? 'mainnet' : 'testnet';
    assertFaucetSafety(network, config.enableTestnetFaucet);

    const wallet = resolveWallet(config);

    ctx = { wallet, address: wallet.classicAddress, network };
    return ctx;
};

export const getWallet = (): Wallet => {
    if (!ctx) throw new Error('Wallet not initialized');
    return ctx.wallet;
};

export const getWalletAddress = (): string => {
    if (!ctx) throw new Error('Wallet not initialized');
    return ctx.address;
};

export const getWalletType = (): WalletNetwork => {
    if (!ctx) throw new Error('Wallet not initialized');
    return ctx.network;
};
