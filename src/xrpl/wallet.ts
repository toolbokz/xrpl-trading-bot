import { Wallet } from 'xrpl';
import { Account } from 'xrpl-secret-numbers';
import { AppConfig } from '../config';

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
        throw new Error('XRPL_SECRET_NUMBERS is required when XRPL_SEED is not set');
    }

    const parts = raw
        .split(/[^0-9]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (parts.length !== SECRET_NUMBERS_COUNT) {
        throw new Error(`XRPL_SECRET_NUMBERS must contain exactly ${SECRET_NUMBERS_COUNT} numbers`);
    }

    // Validate each number
    parts.forEach((part, idx) => {
        if (!/^\d{1,6}$/.test(part)) {
            throw new Error(`XRPL_SECRET_NUMBERS entry ${idx + 1} must be 1-6 digits`);
        }
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0 || value > 999_999) {
            throw new Error(`XRPL_SECRET_NUMBERS entry ${idx + 1} must be an integer between 0 and 999999`);
        }
    });

    // Return space-separated format expected by xrpl-secret-numbers library
    return parts.map((p) => p.padStart(6, '0')).join(' ');
};

export const walletFromSecretNumbers = (secretNumbers?: string): Wallet => {
    const formatted = parseSecretNumbers(secretNumbers);
    const account = new Account(formatted);
    const keypair = account.getKeypair();

    // Create xrpl Wallet from the keypair
    return new Wallet(keypair.publicKey, keypair.privateKey);
};

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
 */
export const initWallet = (config: AppConfig): WalletContext => {
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
