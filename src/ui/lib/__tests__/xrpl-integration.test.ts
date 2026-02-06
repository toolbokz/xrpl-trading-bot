/**
 * Integration tests for XRPL interactions using mock client.
 * Tests WebSocket events, JSON-RPC responses, and error handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockXrplClient, createMockClientWithOrderBook } from './mocks/xrplClient';

describe('XRPL Integration Tests', () => {
    let mockClient: MockXrplClient;

    beforeEach(() => {
        mockClient = new MockXrplClient();
    });

    describe('Connection Management', () => {
        it('should connect successfully', async () => {
            await mockClient.connect();
            expect(mockClient.isConnected).toBe(true);
        });

        it('should emit connected event on connect', async () => {
            const connectedHandler = vi.fn();
            mockClient.on('connected', connectedHandler);

            await mockClient.connect();

            expect(connectedHandler).toHaveBeenCalledTimes(1);
        });

        it('should disconnect successfully', async () => {
            await mockClient.connect();
            await mockClient.disconnect();

            expect(mockClient.isConnected).toBe(false);
        });

        it('should emit disconnected event on disconnect', async () => {
            await mockClient.connect();

            const disconnectedHandler = vi.fn();
            mockClient.on('disconnected', disconnectedHandler);

            await mockClient.disconnect();

            expect(disconnectedHandler).toHaveBeenCalledTimes(1);
        });

        it('should fail connection when configured', async () => {
            mockClient.setConnectBehavior({ shouldFail: true });

            await expect(mockClient.connect()).rejects.toThrow('Mock connection failed');
            expect(mockClient.isConnected).toBe(false);
        });

        it('should simulate connection delay', async () => {
            mockClient.setConnectBehavior({ delay: 50 });

            const start = Date.now();
            await mockClient.connect();
            const elapsed = Date.now() - start;

            expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
        });
    });

    describe('Request/Response', () => {
        beforeEach(async () => {
            await mockClient.connect();
        });

        it('should throw when not connected', async () => {
            await mockClient.disconnect();

            await expect(mockClient.request({ command: 'server_info' })).rejects.toThrow(
                'Client is not connected'
            );
        });

        it('should return default server_info response', async () => {
            const response = await mockClient.request({ command: 'server_info' });

            expect(response.result).toBeDefined();
            const info = (response.result as any).info;
            expect(info.server_state).toBe('full');
            expect(info.validated_ledger).toBeDefined();
        });

        it('should return default account_info response', async () => {
            const response = await mockClient.request({
                command: 'account_info',
                account: 'rTestAccount',
            });

            const accountData = (response.result as any).account_data;
            expect(accountData.Account).toBe('rTestAccount');
            expect(accountData.Balance).toBeDefined();
        });

        it('should return mock response when configured', async () => {
            mockClient.setMockResponse('account_info', {
                account_data: {
                    Account: 'rCustomAccount',
                    Balance: '500000000',
                    Sequence: 42,
                    OwnerCount: 5,
                },
                ledger_index: 2000000,
            });

            const response = await mockClient.request({
                command: 'account_info',
                account: 'rCustomAccount',
            });

            const accountData = (response.result as any).account_data;
            expect(accountData.Balance).toBe('500000000');
            expect(accountData.Sequence).toBe(42);
        });

        it('should record request history', async () => {
            await mockClient.request({ command: 'server_info' });
            await mockClient.request({ command: 'account_info', account: 'rTest' });

            const history = mockClient.getRequestHistory();
            expect(history).toHaveLength(2);
            expect(history[0]?.command).toBe('server_info');
            expect(history[1]?.command).toBe('account_info');
            expect(history[1]?.params.account).toBe('rTest');
        });

        it('should simulate request delay', async () => {
            mockClient.setRequestDelay(50);

            const start = Date.now();
            await mockClient.request({ command: 'server_info' });
            const elapsed = Date.now() - start;

            expect(elapsed).toBeGreaterThanOrEqual(45);
        });
    });

    describe('Subscriptions', () => {
        beforeEach(async () => {
            await mockClient.connect();
        });

        it('should track subscriptions', async () => {
            await mockClient.request({
                command: 'subscribe',
                streams: ['ledger', 'transactions'],
            });

            expect(mockClient.isSubscribedTo('ledger')).toBe(true);
            expect(mockClient.isSubscribedTo('transactions')).toBe(true);
            expect(mockClient.isSubscribedTo('validations')).toBe(false);
        });

        it('should handle unsubscribe', async () => {
            await mockClient.request({
                command: 'subscribe',
                streams: ['ledger', 'transactions'],
            });

            await mockClient.request({
                command: 'unsubscribe',
                streams: ['ledger'],
            });

            expect(mockClient.isSubscribedTo('ledger')).toBe(false);
            expect(mockClient.isSubscribedTo('transactions')).toBe(true);
        });

        it('should clear subscriptions on disconnect', async () => {
            await mockClient.request({
                command: 'subscribe',
                streams: ['ledger'],
            });

            await mockClient.disconnect();

            expect(mockClient.isSubscribedTo('ledger')).toBe(false);
        });
    });

    describe('WebSocket Events', () => {
        beforeEach(async () => {
            await mockClient.connect();
        });

        it('should simulate ledger close events', () => {
            const handler = vi.fn();
            mockClient.on('ledgerClosed', handler);

            mockClient.simulateLedgerClose(1000001);

            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0]?.[0]).toMatchObject({
                ledger_index: 1000001,
            });
        });

        it('should simulate transaction events', () => {
            const handler = vi.fn();
            mockClient.on('transaction', handler);

            mockClient.simulateTransaction({
                hash: 'TX_HASH_123',
                account: 'rSender',
                type: 'OfferCreate',
                result: 'tesSUCCESS',
            });

            expect(handler).toHaveBeenCalledTimes(1);
            const event = handler.mock.calls[0]?.[0];
            expect(event?.transaction?.hash).toBe('TX_HASH_123');
            expect(event?.transaction?.TransactionType).toBe('OfferCreate');
        });

        it('should throw when simulating events while disconnected', async () => {
            await mockClient.disconnect();

            expect(() => mockClient.simulateLedgerClose(1000001)).toThrow(
                'Cannot emit events when not connected'
            );
        });
    });

    describe('Order Book Scenarios', () => {
        it('should create mock client with order book data', async () => {
            const client = createMockClientWithOrderBook({
                askPrice: 0.5,
                bidPrice: 0.49,
                askVolume: 1000,
                bidVolume: 2000,
            });

            await client.connect();

            const response = await client.request({ command: 'book_offers' });
            const offers = (response.result as any).offers;

            expect(offers).toHaveLength(1);
            expect(offers[0]?.TakerGets).toBe('1000000000'); // 1000 XRP in drops
        });

        it('should return empty offers by default', async () => {
            await mockClient.connect();

            const response = await mockClient.request({
                command: 'book_offers',
                taker_gets: { currency: 'XRP' },
                taker_pays: { currency: 'USD', issuer: 'rIssuer' },
            });

            const offers = (response.result as any).offers;
            expect(offers).toEqual([]);
        });

        it('should support custom order book responses', async () => {
            await mockClient.connect();

            mockClient.setMockResponse('book_offers', {
                offers: [
                    {
                        TakerGets: '500000000',
                        TakerPays: { currency: 'USD', issuer: 'rIssuer', value: '250' },
                        Account: 'rMaker1',
                        Sequence: 1,
                    },
                    {
                        TakerGets: '300000000',
                        TakerPays: { currency: 'USD', issuer: 'rIssuer', value: '151.5' },
                        Account: 'rMaker2',
                        Sequence: 2,
                    },
                ],
                ledger_index: 1000000,
            });

            const response = await mockClient.request({ command: 'book_offers' });
            const offers = (response.result as any).offers;

            expect(offers).toHaveLength(2);
        });
    });

    describe('Transaction Submission', () => {
        beforeEach(async () => {
            await mockClient.connect();
        });

        it('should return success for submit by default', async () => {
            const response = await mockClient.request({
                command: 'submit',
                tx_blob: 'MOCK_BLOB',
            });

            expect((response.result as any).engine_result).toBe('tesSUCCESS');
        });

        it('should support custom submit response', async () => {
            mockClient.setMockResponse('submit', {
                engine_result: 'tecUNFUNDED_OFFER',
                tx_json: { Account: 'rTest' },
                tx_blob: 'BLOB',
            });

            const response = await mockClient.request({
                command: 'submit',
                tx_blob: 'MOCK_BLOB',
            });

            expect((response.result as any).engine_result).toBe('tecUNFUNDED_OFFER');
        });

        it('should return validated tx by default', async () => {
            const response = await mockClient.request({
                command: 'tx',
                transaction: 'TX_HASH',
            });

            expect((response.result as any).validated).toBe(true);
            expect((response.result as any).meta.TransactionResult).toBe('tesSUCCESS');
        });
    });

    describe('Reset and Cleanup', () => {
        it('should reset all state', async () => {
            await mockClient.connect();
            mockClient.setMockResponse('account_info', {
                account_data: {
                    Account: 'rCustom',
                    Balance: '1',
                    Sequence: 1,
                    OwnerCount: 1,
                },
                ledger_index: 1,
            });
            await mockClient.request({ command: 'server_info' });
            await mockClient.request({
                command: 'subscribe',
                streams: ['ledger'],
            });

            mockClient.reset();

            expect(mockClient.isConnected).toBe(false);
            expect(mockClient.getRequestHistory()).toHaveLength(0);
            expect(mockClient.isSubscribedTo('ledger')).toBe(false);

            // Mock response should be cleared
            await mockClient.connect();
            const response = await mockClient.request({
                command: 'account_info',
                account: 'rTest',
            });
            expect((response.result as any).account_data.Account).toBe('rTest');
        });
    });
});
