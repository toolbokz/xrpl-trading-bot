import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from 'xrpl';
import {
    classifyReserveError,
    getNetworkReserves,
    hasAdequateReserves,
} from '../reserve';

const ORIGINAL_ENV = { ...process.env };

function createClientMock(overrides?: Partial<Client>): Client {
    const base = {
        isConnected: () => true,
        request: async () => ({
            result: {
                state: {
                    validated_ledger: {
                        reserve_base: 10_000_000,
                        reserve_inc: 2_000_000,
                    },
                },
                account_data: {
                    OwnerCount: 2,
                    Balance: '100000000',
                },
            },
        }),
    } as unknown as Client;
    return Object.assign(base, overrides);
}

describe('reserve checks', () => {
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('classifies timeout and malformed reserve errors', () => {
        const timeoutError = new Error('reserve-timeout:server_state:500ms');
        timeoutError.name = 'ReserveRequestTimeoutError';

        const timeoutClass = classifyReserveError(timeoutError);
        expect(timeoutClass.code).toBe('RESERVE_TIMEOUT');
        expect(timeoutClass.retryable).toBe(true);

        const malformedClass = classifyReserveError(new Error('Unable to fetch reserve values from server_state'));
        expect(malformedClass.code).toBe('MALFORMED_RESPONSE');
        expect(malformedClass.retryable).toBe(false);
    });

    it('applies timeout guard to reserve request when FEATURE_AUDIT_GUARDS=1', async () => {
        process.env.FEATURE_AUDIT_GUARDS = '1';
        process.env.XRPL_RESERVE_REQUEST_TIMEOUT_MS = '20';

        const hangingClient = createClientMock({
            request: () => new Promise(() => undefined),
        });

        await expect(getNetworkReserves(hangingClient)).rejects.toThrow(/reserve-timeout:server_state:500ms/);
    });

    it('skips reserve checks when client disconnected', async () => {
        const disconnectedClient = createClientMock({
            isConnected: () => false,
        });

        const result = await hasAdequateReserves(disconnectedClient, 'rExample', 5);
        expect(result.adequate).toBe(true);
        expect(result.requirement).toBeNull();
        expect(result.skipped).toBe(true);
    });
});
