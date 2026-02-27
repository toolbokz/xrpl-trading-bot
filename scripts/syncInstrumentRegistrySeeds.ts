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

const normalize = (value: string | undefined | null): string => (value ?? '').trim();

function sameInstrumentIdentity(
    existing: ReturnType<typeof findInstrument>,
    seed: (typeof SEED_INSTRUMENTS)[number],
): boolean {
    if (!existing) return false;
    return (
        normalize(existing.base.currency).toUpperCase() === normalize(seed.base.currency).toUpperCase()
        && normalize(existing.base.issuer) === normalize(seed.base.issuer)
        && normalize(existing.quote.currency).toUpperCase() === normalize(seed.quote.currency).toUpperCase()
        && normalize(existing.quote.issuer) === normalize(seed.quote.issuer)
    );
}

async function main(): Promise<void> {
    const reconcile = process.argv.includes('--reconcile');
    let addedIssuers = 0;
    let addedInstruments = 0;
    let reconciledInstruments = 0;
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

    // Registry keys are unique in SQLite; if seeds contain duplicate keys,
    // keep the last declaration to match upsert semantics.
    const uniqueSeedInstruments = new Map<string, (typeof SEED_INSTRUMENTS)[number]>();
    for (const instrument of SEED_INSTRUMENTS) {
        uniqueSeedInstruments.set(instrument.key, instrument);
    }

    for (const instrument of uniqueSeedInstruments.values()) {
        try {
            const existing = findInstrument(instrument.key);
            if (!existing) {
                registerInstrument(instrument);
                addedInstruments += 1;
            } else if (reconcile && !sameInstrumentIdentity(existing, instrument)) {
                registerInstrument({
                    ...existing,
                    base: { ...instrument.base },
                    quote: { ...instrument.quote },
                    description: instrument.description,
                    network: instrument.network,
                    updatedAt: new Date().toISOString(),
                });
                reconciledInstruments += 1;
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
                reconcile,
                addedIssuers,
                addedInstruments,
                reconciledInstruments,
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
