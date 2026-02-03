import dotenv from 'dotenv';
import { Client, Wallet, TrustSet, AccountLinesRequest, AccountLinesTrustline, TxResponse } from 'xrpl';

dotenv.config();

const TESTNET_WSS = 'wss://s.altnet.rippletest.net:51233';
const RLUSD_ISSUER = 'rnEVYfAWYP5HpPaWQiPSJMyDeUiEJ6zhy2';
// RLUSD is 5 chars, so must be hex-encoded (40 hex chars, padded with zeros)
const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000'; // "RLUSD" in hex
const RLUSD_CURRENCY_DISPLAY = 'RLUSD';
const TRUST_LIMIT = '1000000';
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 2_000;

/**
 * Check if a currency code matches RLUSD (handles both hex and ASCII)
 */
function isRlusd(currency: string): boolean {
    if (currency === RLUSD_CURRENCY_DISPLAY) return true;
    if (currency.toUpperCase() === RLUSD_CURRENCY_HEX) return true;
    // Decode hex to check
    if (currency.length === 40 && /^[0-9A-Fa-f]+$/.test(currency)) {
        const decoded = Buffer.from(currency, 'hex').toString('utf8').replace(/\0/g, '');
        return decoded === RLUSD_CURRENCY_DISPLAY;
    }
    return false;
}

function requireSeed(): string {
    // Prefer secret numbers if available (usa wallet), then fall back to seed
    const secretNums = process.env.XRPL_SECRET_NUMBERS_TESTNET || process.env.XRPL_SECRET_NUMBERS;
    if (secretNums) {
        return secretNums; // Return as marker to use secret numbers
    }
    const seed = process.env.TESTNET_SEED || process.env.XRPL_SEED_TESTNET;
    if (!seed) {
        console.error('[env] TESTNET_SEED, XRPL_SEED_TESTNET, or XRPL_SECRET_NUMBERS is missing.');
        process.exit(1);
    }
    return seed;
}

function getWallet(): Wallet {
    // For testnet, prefer the dedicated testnet seed over secret numbers (which may be mainnet)
    const seed = process.env.TESTNET_SEED || process.env.XRPL_SEED_TESTNET;
    if (seed) {
        return Wallet.fromSeed(seed);
    }
    // Fallback to secret numbers only if explicitly for testnet
    const secretNums = process.env.XRPL_SECRET_NUMBERS_TESTNET;
    if (secretNums) {
        const { walletFromSecretNumbers } = require('xrpl/dist/npm/Wallet/walletFromSecretNumbers');
        const nums = secretNums.split(',').map((n: string) => n.trim());
        return walletFromSecretNumbers(nums);
    }
    console.error('[env] No testnet wallet credentials found (TESTNET_SEED or XRPL_SEED_TESTNET)');
    process.exit(1);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTrustline(client: Client, address: string): Promise<AccountLinesTrustline | undefined> {
    const request: AccountLinesRequest = {
        command: 'account_lines',
        account: address
    };
    const response = await client.request(request);
    return response.result.lines.find((line) => isRlusd(line.currency) && (line.account === RLUSD_ISSUER || (line as any).issuer === RLUSD_ISSUER));
}

async function ensureTrustline(client: Client, wallet: Wallet): Promise<string | undefined> {
    const existing = await getTrustline(client, wallet.address);
    if (existing) {
        console.log('[trustline] Existing RLUSD trustline found');
        return undefined;
    }

    const tx: TrustSet = {
        TransactionType: 'TrustSet',
        Account: wallet.address,
        LimitAmount: {
            currency: RLUSD_CURRENCY_HEX,
            issuer: RLUSD_ISSUER,
            value: TRUST_LIMIT
        }
    };

    console.log('[trustline] Submitting TrustSet...');
    const submit: TxResponse<TrustSet> = await client.submitAndWait(tx, { wallet });
    console.log('[trustline] TrustSet validated');
    return submit.result.hash;
}

async function callFaucet(address: string): Promise<void> {
    console.log('[faucet] Requesting RLUSD...');
    const res = await fetch('https://tryrlusd.com/api/faucet', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ address })
    });

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`[faucet] Failed (${res.status}): ${text}`);
    }
    console.log(`[faucet] Response (${res.status}): ${text}`);
}

async function pollBalances(client: Client, address: string): Promise<void> {
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
        const xrp = await client.getXrpBalance(address);
        const line = await getTrustline(client, address);
        const rlusdBalance = line?.balance ?? '0';
        console.log(`[balances] attempt ${attempt}/${POLL_ATTEMPTS} -> XRP: ${xrp}, RLUSD: ${rlusdBalance}`);
        if (Number(rlusdBalance) > 0) {
            return;
        }
        await delay(POLL_DELAY_MS);
    }
    console.warn('[balances] RLUSD not received after polling; check faucet status manually.');
}

async function main(): Promise<void> {
    const wallet = getWallet();

    const client = new Client(TESTNET_WSS, { connectionTimeout: 15_000 });
    console.log('[connect] Connecting to XRPL Testnet...');
    await client.connect();

    try {
        console.log(`[connect] Connected. Address: ${wallet.address}`);
        const xrpBalance = await client.getXrpBalance(wallet.address);
        console.log(`[balances] Current XRP: ${xrpBalance}`);

        const trustTxHash = await ensureTrustline(client, wallet);
        if (trustTxHash) {
            console.log(`[trustline] Tx hash: ${trustTxHash}`);
        }

        await callFaucet(wallet.address);
        await pollBalances(client, wallet.address);

        const finalXrp = await client.getXrpBalance(wallet.address);
        const finalLine = await getTrustline(client, wallet.address);
        const finalRlusd = finalLine?.balance ?? '0';
        console.log(`[final] XRP: ${finalXrp}, RLUSD: ${finalRlusd}`);
        if (finalLine) {
            console.log(`[final] Trust limit: ${finalLine.limit}`);
        }
    } finally {
        console.log('[connect] Disconnecting...');
        await client.disconnect();
    }
}

main().catch((err) => {
    console.error('[error]', err);
    process.exit(1);
});
