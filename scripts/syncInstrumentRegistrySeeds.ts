import {
    SEED_INSTRUMENTS,
    SEED_ISSUERS,
    findInstrument,
    getIssuer,
    registerInstrument,
    registerIssuer,
    closeRegistry,
    getInstruments,
    listIssuers,
} from '../src/market/instrumentRegistry';

async function main(): Promise<void> {
    let addedIssuers = 0;
    let addedInstruments = 0;
    const skippedIssuers: Array<{ address: string; currency: string; reason: string }> = [];
    const skippedInstruments: Array<{ key: string; reason: string }> = [];

    for (const issuer of SEED_ISSUERS) {
        try {
            const existing = getIssuer(issuer.address, issuer.currency);
            if (!existing) {
                registerIssuer(issuer);
                addedIssuers += 1;
            }
        } catch (err) {
            skippedIssuers.push({
                address: issuer.address,
                currency: issuer.currency,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    for (const instrument of SEED_INSTRUMENTS) {
        try {
            const existing = findInstrument(instrument.key);
            if (!existing) {
                registerInstrument(instrument);
                addedInstruments += 1;
            }
        } catch (err) {
            skippedInstruments.push({
                key: instrument.key,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const totalInstruments = getInstruments().length;
    const totalIssuers = listIssuers().length;

    console.log(
        JSON.stringify(
            {
                ok: true,
                addedIssuers,
                addedInstruments,
                totalIssuers,
                totalInstruments,
                skippedIssuers,
                skippedInstruments,
            },
            null,
            2,
        ),
    );

    closeRegistry();
}

main().catch((err) => {
    console.error('Failed to sync instrument registry seeds:', err);
    process.exitCode = 1;
});
