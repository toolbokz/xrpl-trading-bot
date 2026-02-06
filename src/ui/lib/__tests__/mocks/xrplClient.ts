/**
 * Mock XRPL Client for testing.
 * Simulates WebSocket events and JSON-RPC responses.
 */

import { EventEmitter } from 'events';

export interface MockOffer {
    TakerGets: string | { currency: string; issuer: string; value: string };
    TakerPays: string | { currency: string; issuer: string; value: string };
    Account: string;
    Sequence: number;
}

export interface MockBookOffersResponse {
    offers: MockOffer[];
    ledger_index: number;
}

export interface MockAccountInfoResponse {
    account_data: {
        Account: string;
        Balance: string;
        Sequence: number;
        OwnerCount: number;
    };
    ledger_index: number;
}

export interface MockAccountLinesResponse {
    account: string;
    lines: Array<{
        account: string;
        balance: string;
        currency: string;
        limit: string;
        limit_peer: string;
    }>;
}

export interface MockServerInfoResponse {
    info: {
        build_version: string;
        complete_ledgers: string;
        hostid: string;
        io_latency_ms: number;
        last_close: {
            converge_time_s: number;
            proposers: number;
        };
        load_factor: number;
        peers: number;
        pubkey_node: string;
        server_state: string;
        validated_ledger: {
            age: number;
            base_fee_xrp: number;
            hash: string;
            reserve_base_xrp: number;
            reserve_inc_xrp: number;
            seq: number;
        };
    };
}

export interface MockTxResponse {
    meta: {
        TransactionResult: string;
        delivered_amount?: string;
    };
    validated: boolean;
    hash: string;
}

type MockResponses = {
    book_offers?: MockBookOffersResponse;
    account_info?: MockAccountInfoResponse;
    account_lines?: MockAccountLinesResponse;
    server_info?: MockServerInfoResponse;
    submit?: { engine_result: string; tx_json: Record<string, unknown>; tx_blob: string };
    tx?: MockTxResponse;
};

/**
 * Mock XRPL Client that simulates real client behavior.
 */
export class MockXrplClient extends EventEmitter {
    private _isConnected = false;
    private _mockResponses: MockResponses = {};
    private _requestHistory: Array<{ command: string; params: Record<string, unknown> }> = [];
    private _subscriptions: Set<string> = new Set();
    private _shouldFailConnect = false;
    private _connectDelay = 0;
    private _requestDelay = 0;

    constructor() {
        super();
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    /**
     * Configure mock responses for specific commands.
     */
    setMockResponse<K extends keyof MockResponses>(command: K, response: MockResponses[K]): void {
        this._mockResponses[command] = response;
    }

    /**
     * Configure connection behavior.
     */
    setConnectBehavior(options: { shouldFail?: boolean; delay?: number }): void {
        this._shouldFailConnect = options.shouldFail ?? false;
        this._connectDelay = options.delay ?? 0;
    }

    /**
     * Configure request delay for simulating network latency.
     */
    setRequestDelay(ms: number): void {
        this._requestDelay = ms;
    }

    /**
     * Get history of all requests made.
     */
    getRequestHistory(): Array<{ command: string; params: Record<string, unknown> }> {
        return [...this._requestHistory];
    }

    /**
     * Clear request history.
     */
    clearRequestHistory(): void {
        this._requestHistory = [];
    }

    /**
     * Simulate connecting to XRPL.
     */
    async connect(): Promise<void> {
        if (this._connectDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, this._connectDelay));
        }

        if (this._shouldFailConnect) {
            throw new Error('Mock connection failed');
        }

        this._isConnected = true;
        this.emit('connected');
    }

    /**
     * Simulate disconnecting from XRPL.
     */
    async disconnect(): Promise<void> {
        this._isConnected = false;
        this._subscriptions.clear();
        this.emit('disconnected');
    }

    /**
     * Simulate a request to XRPL.
     */
    async request(req: { command: string;[key: string]: unknown }): Promise<{ result: unknown }> {
        if (!this._isConnected) {
            throw new Error('Client is not connected');
        }

        this._requestHistory.push({
            command: req.command,
            params: { ...req },
        });

        if (this._requestDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, this._requestDelay));
        }

        const commandStr = req.command;

        // Handle subscribe command specially
        if (commandStr === 'subscribe') {
            const streams = req.streams as string[] | undefined;
            if (streams) {
                streams.forEach((s) => this._subscriptions.add(s));
            }
            return { result: {} };
        }

        // Handle unsubscribe command
        if (commandStr === 'unsubscribe') {
            const streams = req.streams as string[] | undefined;
            if (streams) {
                streams.forEach((s) => this._subscriptions.delete(s));
            }
            return { result: {} };
        }

        // Return mock response if configured
        const command = commandStr as keyof MockResponses;
        if (this._mockResponses[command]) {
            return { result: this._mockResponses[command] };
        }

        // Default responses for common commands
        return { result: this.getDefaultResponse(command, req) };
    }

    /**
     * Get default mock response for a command.
     */
    private getDefaultResponse(command: string, req: Record<string, unknown>): unknown {
        switch (command) {
            case 'book_offers':
                return {
                    offers: [],
                    ledger_index: 1000000,
                };

            case 'account_info':
                return {
                    account_data: {
                        Account: req.account || 'rTestAddress123',
                        Balance: '100000000', // 100 XRP in drops
                        Sequence: 1,
                        OwnerCount: 0,
                    },
                    ledger_index: 1000000,
                };

            case 'account_lines':
                return {
                    account: req.account || 'rTestAddress123',
                    lines: [],
                };

            case 'server_info':
                return {
                    info: {
                        build_version: '1.9.4',
                        complete_ledgers: '32570-1000000',
                        hostid: 'TEST',
                        io_latency_ms: 1,
                        last_close: { converge_time_s: 3, proposers: 35 },
                        load_factor: 1,
                        peers: 50,
                        pubkey_node: 'nMockPubKey',
                        server_state: 'full',
                        validated_ledger: {
                            age: 2,
                            base_fee_xrp: 0.00001,
                            hash: 'ABCD1234',
                            reserve_base_xrp: 10,
                            reserve_inc_xrp: 2,
                            seq: 1000000,
                        },
                    },
                };

            case 'submit':
                return {
                    engine_result: 'tesSUCCESS',
                    tx_json: {},
                    tx_blob: '',
                };

            case 'tx':
                return {
                    meta: { TransactionResult: 'tesSUCCESS' },
                    validated: true,
                    hash: 'MOCK_TX_HASH',
                };

            case 'ledger':
                return {
                    ledger: {
                        ledger_index: 1000000,
                        ledger_hash: 'MOCK_LEDGER_HASH',
                        close_time: Math.floor(Date.now() / 1000),
                    },
                };

            default:
                return {};
        }
    }

    /**
     * Simulate receiving a WebSocket event.
     */
    simulateEvent(
        event:
            | 'ledgerClosed'
            | 'transaction'
            | 'validationReceived'
            | 'manifestReceived'
            | 'peerStatusChange',
        data: Record<string, unknown>
    ): void {
        if (!this._isConnected) {
            throw new Error('Cannot emit events when not connected');
        }
        this.emit(event, data);
    }

    /**
     * Simulate a ledger close event.
     */
    simulateLedgerClose(ledgerIndex: number, closeTime?: number): void {
        this.simulateEvent('ledgerClosed', {
            ledger_index: ledgerIndex,
            ledger_hash: `HASH_${ledgerIndex}`,
            ledger_time: closeTime ?? Math.floor(Date.now() / 1000),
            txn_count: Math.floor(Math.random() * 100),
            validated_ledgers: `32570-${ledgerIndex}`,
        });
    }

    /**
     * Simulate a transaction event.
     */
    simulateTransaction(options: {
        hash?: string;
        account?: string;
        type?: string;
        result?: string;
    }): void {
        this.simulateEvent('transaction', {
            engine_result: options.result ?? 'tesSUCCESS',
            engine_result_code: 0,
            ledger_hash: 'MOCK_LEDGER_HASH',
            ledger_index: 1000000,
            status: 'closed',
            type: 'transaction',
            validated: true,
            transaction: {
                Account: options.account ?? 'rTestAccount',
                TransactionType: options.type ?? 'Payment',
                hash: options.hash ?? 'MOCK_TX_HASH',
            },
            meta: {
                TransactionResult: options.result ?? 'tesSUCCESS',
            },
        });
    }

    /**
     * Check if subscribed to a stream.
     */
    isSubscribedTo(stream: string): boolean {
        return this._subscriptions.has(stream);
    }

    /**
     * Reset all mock state.
     */
    reset(): void {
        this._isConnected = false;
        this._mockResponses = {};
        this._requestHistory = [];
        this._subscriptions.clear();
        this._shouldFailConnect = false;
        this._connectDelay = 0;
        this._requestDelay = 0;
        this.removeAllListeners();
    }
}

/**
 * Create a mock client with preconfigured order book data.
 */
export function createMockClientWithOrderBook(options: {
    askPrice: number;
    bidPrice: number;
    askVolume?: number;
    bidVolume?: number;
}): MockXrplClient {
    const client = new MockXrplClient();

    const askVolume = options.askVolume ?? 1000;
    const bidVolume = options.bidVolume ?? 1000;

    // Configure asks (selling XRP for USD)
    client.setMockResponse('book_offers', {
        offers: [
            {
                TakerGets: String(askVolume * 1_000_000), // XRP in drops
                TakerPays: {
                    currency: 'USD',
                    issuer: 'rIssuer123',
                    value: String(askVolume * options.askPrice),
                },
                Account: 'rSeller1',
                Sequence: 1,
            },
        ],
        ledger_index: 1000000,
    });

    return client;
}

/**
 * Create a mock client factory for dependency injection.
 */
export function createMockClientFactory(): {
    create: () => MockXrplClient;
    getLastClient: () => MockXrplClient | null;
} {
    let lastClient: MockXrplClient | null = null;

    return {
        create: () => {
            lastClient = new MockXrplClient();
            return lastClient;
        },
        getLastClient: () => lastClient,
    };
}
