import { Client } from 'xrpl';

const TESTNET_WSS = 'wss://s.altnet.rippletest.net:51233';

async function main(): Promise<void> {
    const client = new Client(TESTNET_WSS, { connectionTimeout: 15_000 });
    await client.connect();
    try {
        const { wallet, balance } = await client.fundWallet();
        // Output once; user must store securely.
        console.log('Testnet wallet created');
        console.log(`Address: ${wallet.classicAddress}`);
        console.log(`Seed: ${wallet.seed}`);
        console.log(`Balance (XRP): ${balance}`);
        console.warn('Store the seed securely. This will not be shown again.');
    } finally {
        await client.disconnect();
    }
}

main().catch((err) => {
    console.error('Failed to create testnet wallet', err);
    process.exit(1);
});
