/**
 * Listener Leak Tests
 *
 * Validates that start/shutdown/reset cycles do not accumulate
 * event listeners on the shared XRPL Client or the XRPLWebSocket wrapper.
 *
 * Uses EventEmitter-backed fakes (no real XRPL connections).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import EventEmitter from 'events';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Fake underlying xrpl Client (EventEmitter)
class FakeClient extends EventEmitter {
    isConnected() { return true; }
    async request(_req: any) { return { result: { offers: [], ledger_index: 1 } }; }
    async disconnect() { /* no-op */ }
}

// Fake XRPLWebSocket (EventEmitter, mimics our wrapper)
class FakeXRPLWebSocket extends EventEmitter {
    private fakeClient: FakeClient;
    private _connected = true;

    constructor(client: FakeClient) {
        super();
        this.fakeClient = client;
    }
    async connect() { this._connected = true; }
    async disconnect() { this._connected = false; }
    isConnected() { return this._connected; }
    getClient() { return this.fakeClient; }
    getLedgerIndex() { return 1; }
    async subscribe() { /* no-op */ }
    getConnectionState() { return { connected: true, endpoint: 'fake' }; }
}

// Minimal mock for TradeTapeService
const makeFakeTradeTapeService = () => ({
    processTransaction: vi.fn(),
});

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Simulates what TradingRuntime.start() does with listeners, using
 * the stored-handler-reference pattern from PR1B.
 */
interface RuntimeListenerState {
    xrpl: FakeXRPLWebSocket;
    client: FakeClient;
    onXrplLedger: (() => void) | null;
    onXrplTransaction: ((tx: any) => void) | null;
    onXrplReconnect: (() => void) | null;
    onUnderlyingDisconnected: (() => void) | null;
    listenersAttached: boolean;
    tradeTapeService: ReturnType<typeof makeFakeTradeTapeService>;
}

function attachRuntimeListeners(state: RuntimeListenerState): void {
    if (state.listenersAttached) return;

    state.onXrplLedger = () => { /* ledger handler */ };
    state.onXrplTransaction = (tx: any) => {
        state.tradeTapeService.processTransaction(tx);
    };
    state.onXrplReconnect = () => { /* reconnect handler */ };
    state.onUnderlyingDisconnected = () => { /* disconnected handler */ };

    state.xrpl.on('ledger', state.onXrplLedger);
    state.xrpl.on('transaction', state.onXrplTransaction);
    state.xrpl.on('reconnect', state.onXrplReconnect);
    state.client.on('disconnected', state.onUnderlyingDisconnected);

    state.listenersAttached = true;
}

function detachRuntimeListeners(state: RuntimeListenerState): void {
    if (state.onXrplLedger) state.xrpl.off('ledger', state.onXrplLedger);
    if (state.onXrplTransaction) state.xrpl.off('transaction', state.onXrplTransaction);
    if (state.onXrplReconnect) state.xrpl.off('reconnect', state.onXrplReconnect);
    if (state.onUnderlyingDisconnected) state.client.off('disconnected', state.onUnderlyingDisconnected);

    state.onXrplLedger = null;
    state.onXrplTransaction = null;
    state.onXrplReconnect = null;
    state.onUnderlyingDisconnected = null;
    state.listenersAttached = false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Listener Leak Prevention', () => {
    let fakeClient: FakeClient;
    let fakeXrpl: FakeXRPLWebSocket;

    beforeEach(() => {
        fakeClient = new FakeClient();
        fakeXrpl = new FakeXRPLWebSocket(fakeClient);
    });

    describe('restart cycle does not increase listener count', () => {
        it('Client "disconnected" listenerCount stays at 1 across 5 restart cycles', () => {
            for (let i = 0; i < 5; i++) {
                const state: RuntimeListenerState = {
                    xrpl: fakeXrpl,
                    client: fakeClient,
                    onXrplLedger: null,
                    onXrplTransaction: null,
                    onXrplReconnect: null,
                    onUnderlyingDisconnected: null,
                    listenersAttached: false,
                    tradeTapeService: makeFakeTradeTapeService(),
                };

                // Simulate start()
                attachRuntimeListeners(state);
                expect(fakeClient.listenerCount('disconnected')).toBe(1);

                // Simulate shutdown() → reset()
                detachRuntimeListeners(state);
                expect(fakeClient.listenerCount('disconnected')).toBe(0);
            }
        });

        it('XRPLWebSocket listener counts stay at 1 per event across 5 restart cycles', () => {
            for (let i = 0; i < 5; i++) {
                const state: RuntimeListenerState = {
                    xrpl: fakeXrpl,
                    client: fakeClient,
                    onXrplLedger: null,
                    onXrplTransaction: null,
                    onXrplReconnect: null,
                    onUnderlyingDisconnected: null,
                    listenersAttached: false,
                    tradeTapeService: makeFakeTradeTapeService(),
                };

                attachRuntimeListeners(state);
                expect(fakeXrpl.listenerCount('ledger')).toBe(1);
                expect(fakeXrpl.listenerCount('transaction')).toBe(1);
                expect(fakeXrpl.listenerCount('reconnect')).toBe(1);

                detachRuntimeListeners(state);
                expect(fakeXrpl.listenerCount('ledger')).toBe(0);
                expect(fakeXrpl.listenerCount('transaction')).toBe(0);
                expect(fakeXrpl.listenerCount('reconnect')).toBe(0);
            }
        });
    });

    describe('single transaction after N restart cycles calls processTransaction once', () => {
        it('emitting transaction fires exactly one handler after 3 cycles', () => {
            let currentService = makeFakeTradeTapeService();
            const services: ReturnType<typeof makeFakeTradeTapeService>[] = [];

            for (let i = 0; i < 3; i++) {
                currentService = makeFakeTradeTapeService();
                services.push(currentService);

                const state: RuntimeListenerState = {
                    xrpl: fakeXrpl,
                    client: fakeClient,
                    onXrplLedger: null,
                    onXrplTransaction: null,
                    onXrplReconnect: null,
                    onUnderlyingDisconnected: null,
                    listenersAttached: false,
                    tradeTapeService: currentService,
                };

                attachRuntimeListeners(state);

                // Simulate reset on all but the last cycle
                if (i < 2) {
                    detachRuntimeListeners(state);
                }
            }

            // Emit a transaction — should fire exactly once (the current service)
            const fakeTx = { transaction: { TransactionType: 'Payment' } };
            fakeXrpl.emit('transaction', fakeTx);

            // Only the last (current) service should have been called
            expect(currentService.processTransaction).toHaveBeenCalledTimes(1);
            expect(currentService.processTransaction).toHaveBeenCalledWith(fakeTx);

            // Previous services should NOT have been called
            for (let i = 0; i < services.length - 1; i++) {
                expect(services[i].processTransaction).not.toHaveBeenCalled();
            }
        });
    });

    describe('after reset, listener counts on XRPLWebSocket are 0', () => {
        it('all runtime-owned events have 0 listeners after detach', () => {
            const state: RuntimeListenerState = {
                xrpl: fakeXrpl,
                client: fakeClient,
                onXrplLedger: null,
                onXrplTransaction: null,
                onXrplReconnect: null,
                onUnderlyingDisconnected: null,
                listenersAttached: false,
                tradeTapeService: makeFakeTradeTapeService(),
            };

            attachRuntimeListeners(state);
            expect(fakeXrpl.listenerCount('ledger')).toBe(1);
            expect(fakeXrpl.listenerCount('transaction')).toBe(1);
            expect(fakeXrpl.listenerCount('reconnect')).toBe(1);
            expect(fakeClient.listenerCount('disconnected')).toBe(1);

            detachRuntimeListeners(state);
            expect(fakeXrpl.listenerCount('ledger')).toBe(0);
            expect(fakeXrpl.listenerCount('transaction')).toBe(0);
            expect(fakeXrpl.listenerCount('reconnect')).toBe(0);
            expect(fakeClient.listenerCount('disconnected')).toBe(0);
        });

        it('handler references are null after detach', () => {
            const state: RuntimeListenerState = {
                xrpl: fakeXrpl,
                client: fakeClient,
                onXrplLedger: null,
                onXrplTransaction: null,
                onXrplReconnect: null,
                onUnderlyingDisconnected: null,
                listenersAttached: false,
                tradeTapeService: makeFakeTradeTapeService(),
            };

            attachRuntimeListeners(state);
            expect(state.onXrplLedger).not.toBeNull();
            expect(state.onXrplTransaction).not.toBeNull();

            detachRuntimeListeners(state);
            expect(state.onXrplLedger).toBeNull();
            expect(state.onXrplTransaction).toBeNull();
            expect(state.onXrplReconnect).toBeNull();
            expect(state.onUnderlyingDisconnected).toBeNull();
            expect(state.listenersAttached).toBe(false);
        });
    });

    describe('XRPLWebSocket.detachFromClient (PR1A pattern)', () => {
        it('removes only owned handlers from Client, not other consumers', () => {
            // Simulate another consumer on the same Client
            const otherHandler = vi.fn();
            fakeClient.on('disconnected', otherHandler);
            expect(fakeClient.listenerCount('disconnected')).toBe(1);

            // Our handler
            const ownedHandler = vi.fn();
            fakeClient.on('disconnected', ownedHandler);
            expect(fakeClient.listenerCount('disconnected')).toBe(2);

            // Remove only our handler by reference (not removeAllListeners)
            fakeClient.off('disconnected', ownedHandler);
            expect(fakeClient.listenerCount('disconnected')).toBe(1);

            // Other consumer still works
            fakeClient.emit('disconnected');
            expect(otherHandler).toHaveBeenCalledTimes(1);
            expect(ownedHandler).not.toHaveBeenCalled();
        });

        it('double detach is idempotent', () => {
            const state: RuntimeListenerState = {
                xrpl: fakeXrpl,
                client: fakeClient,
                onXrplLedger: null,
                onXrplTransaction: null,
                onXrplReconnect: null,
                onUnderlyingDisconnected: null,
                listenersAttached: false,
                tradeTapeService: makeFakeTradeTapeService(),
            };

            attachRuntimeListeners(state);
            detachRuntimeListeners(state);
            // Second detach should be safe (no-op)
            expect(() => detachRuntimeListeners(state)).not.toThrow();
            expect(fakeXrpl.listenerCount('ledger')).toBe(0);
            expect(fakeClient.listenerCount('disconnected')).toBe(0);
        });
    });
});
