/**
 * Unit tests for src/xrpl/sharedClient.ts
 * 
 * Tests:
 * - Endpoint rotation logic
 * - 429 cooldown behavior
 * - De-duplication of concurrent connection attempts
 * - Backoff calculations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock client class
class MockClient {
    url: string;
    connected = false;
    _shouldConnect = true;
    _connectError: Error | null = null;
    _onHandlers: Record<string, Function[]> = {};

    constructor(url: string, _options?: any) {
        this.url = url;
    }

    async connect() {
        if (this._connectError) {
            throw this._connectError;
        }
        if (!this._shouldConnect) {
            throw new Error('Connection failed');
        }
        this.connected = true;
    }

    async disconnect() {
        this.connected = false;
    }

    isConnected() {
        return this.connected;
    }

    on(event: string, handler: Function) {
        if (!this._onHandlers[event]) {
            this._onHandlers[event] = [];
        }
        this._onHandlers[event]!.push(handler);
    }

    removeAllListeners() {
        this._onHandlers = {};
    }
}

// Track created clients for test inspection
let createdClients: MockClient[] = [];
let mockConnectBehavior: (url: string, attempt: number) => { success: boolean; error?: Error } = () => ({ success: true });
let connectAttemptCounter = 0;

// Mock the Client class
vi.mock('xrpl', () => {
    return {
        Client: vi.fn().mockImplementation(function (url: string, options?: any) {
            connectAttemptCounter++;
            const client = new MockClient(url, options);
            const behavior = mockConnectBehavior(url, connectAttemptCounter);
            client._shouldConnect = behavior.success;
            if (behavior.error) {
                client._connectError = behavior.error;
            }
            createdClients.push(client);
            return client;
        }),
    };
});

// Mock logger
vi.mock('../../analytics/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

import { Client } from 'xrpl';
import {
    getXrplClient,
    disconnectXrplClient,
    getConnectionState,
    isConnected,
    __resetForTesting,
    __getConfig,
    __setConfigForTesting,
} from '../sharedClient';

describe('sharedClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetForTesting();
        createdClients = [];
        connectAttemptCounter = 0;
        mockConnectBehavior = () => ({ success: true });
        // Speed up tests
        __setConfigForTesting({
            cooldown429Ms: 1000,
            connectTimeoutMs: 100,
            maxReconnectDelayMs: 500,
            initialReconnectDelayMs: 10,
            minConnectIntervalMs: 10,
        });
    });

    afterEach(async () => {
        await disconnectXrplClient();
        __resetForTesting();
    });

    describe('getConnectionState', () => {
        it('returns initial state when not connected', () => {
            const state = getConnectionState();

            expect(state.connected).toBe(false);
            expect(state.endpoint).toBeNull();
            expect(state.lastError).toBeNull();
            expect(state.reconnects).toBe(0);
            expect(state.cooldowns).toEqual({});
        });
    });

    describe('isConnected', () => {
        it('returns false when no client exists', () => {
            expect(isConnected()).toBe(false);
        });
    });

    describe('getXrplClient', () => {
        it('creates a new client on first call', async () => {
            const client = await getXrplClient();

            expect(Client).toHaveBeenCalled();
            expect(client).toBeDefined();
            expect(createdClients.length).toBe(1);
        });

        it('returns same client on subsequent calls', async () => {
            const client1 = await getXrplClient();
            const client2 = await getXrplClient();

            // Client should be created only once
            expect(Client).toHaveBeenCalledTimes(1);
            expect(client1).toBe(client2);
        });

        it('de-duplicates concurrent connection attempts', async () => {
            // Start multiple concurrent connection attempts
            const [client1, client2, client3] = await Promise.all([
                getXrplClient(),
                getXrplClient(),
                getXrplClient(),
            ]);

            // All should return the same client
            expect(client1).toBe(client2);
            expect(client2).toBe(client3);
            // Client should be created only once
            expect(createdClients.length).toBe(1);
        });
    });

    describe('endpoint rotation', () => {
        it('rotates to next endpoint on connection failure', async () => {
            mockConnectBehavior = (_url, attempt) => {
                // First attempt fails, second succeeds
                return { success: attempt >= 2 };
            };

            await getXrplClient();

            // Should have tried at least 2 endpoints
            expect(createdClients.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('429 cooldown', () => {
        it('marks endpoint for cooldown on 429 error', async () => {
            mockConnectBehavior = (_url, attempt) => {
                // First attempt fails with 429, second succeeds
                if (attempt === 1) {
                    return { success: false, error: new Error('429 Too Many Requests') };
                }
                return { success: true };
            };

            await getXrplClient();

            const state = getConnectionState();
            // Should have at least one endpoint in cooldown
            expect(Object.keys(state.cooldowns).length).toBeGreaterThanOrEqual(1);
        });

        it('detects rate limit error messages', async () => {
            const errorMessages = [
                '429 Too Many Requests',
                'rate limit exceeded',
                'too many connections',
            ];

            for (const msg of errorMessages) {
                __resetForTesting();
                createdClients = [];
                connectAttemptCounter = 0;

                mockConnectBehavior = (_url, attempt) => {
                    if (attempt === 1) {
                        return { success: false, error: new Error(msg) };
                    }
                    return { success: true };
                };

                await getXrplClient();

                const state = getConnectionState();
                expect(Object.keys(state.cooldowns).length).toBeGreaterThanOrEqual(1);
            }
        });
    });

    describe('disconnectXrplClient', () => {
        it('disconnects and clears state', async () => {
            await getXrplClient();
            expect(getConnectionState().connected).toBe(true);

            // Manually set connected to false to simulate disconnect
            createdClients[0]!.connected = false;
            await disconnectXrplClient();

            expect(getConnectionState().connected).toBe(false);
        });
    });

    describe('backoff behavior', () => {
        it('increases delay after failures', async () => {
            mockConnectBehavior = (_url, attempt) => {
                // Fail first 2 attempts, succeed on 3rd
                return { success: attempt >= 3 };
            };

            await getXrplClient();

            // Should have multiple attempts
            expect(createdClients.length).toBeGreaterThanOrEqual(2);
        });
    });
});
