import { Wallet, isValidClassicAddress, Client, TransactionStream } from 'xrpl';
import { AppConfig, TradingPair, FlowConfig, loadConfig } from '../config';
import { TRADING_PAIRS, isValidPairKey } from '../config/tradingPairs';
import { runtimeLog as logger } from '../analytics/logger';
import { XRPLWebSocket } from '../xrpl/client';
import { OrderBookTracker } from '../market/orderBookTracker';
import { RiskEngine } from '../risk/riskEngine';
import { OfferExecutor } from '../execution/offerExecutor';
import { ScalperStrategy } from '../strategies/scalper';
import { AMMService } from '../market/amm';
import { AMMArbitrageStrategy } from '../strategies/ammArbitrage';
import { PathArbitrageStrategy } from '../strategies/pathArbitrage';
import { Strategy, StrategyRegimePolicyContext } from '../strategies/types';
import { getWallet, initWallet } from '../xrpl/wallet';
import { ExecutionResult } from '../utils/types';
import { closeBreakerStore } from '../persistence/breakerStore';
import { enforceLocalOnly } from '../security/localOnly';
import { throttleStrategy } from '../utils/rateLimiter';
import { isCpuHealthy, startCpuWatchdog, CpuWatchdog } from '../monitoring/cpuWatchdog';
import { TradeTape, setGlobalTradeTape } from '../market/tradeTape';
import { TradeTapeService } from '../market/tradeTapeService';
import { BackendHttpServer, startBackendHttpServer, stopBackendHttpServer } from '../server/httpServer';
import { FlowMetrics, computeFlowMetrics, FlowRegime } from '../market/flowMetrics';
import {
    NormalizedTrade,
    OrderBookSnapshot,
    computeMarketHealth,
    normalizeOrderBookSnapshot,
    normalizeTrade,
} from '../market/models';
import { feedbackEngine } from '../analytics/feedbackEngine';
import {
    isAdaptiveEnabled,
    getAdaptiveTuning,
    isRegimeDisabled,
} from '../analytics/adaptiveConfig';
import {
    startAdaptiveScheduler,
    stopAdaptiveScheduler,
} from '../analytics/adaptiveScheduler';
import {
    CapitalProtectionEngine,
    CapitalProtectionDecision,
    CapitalProtectionConfig,
    loadCapitalProtectionConfig,
} from '../risk/capitalProtection';
import {
    RegimePolicyEngine,
    RegimePolicy,
    loadRegimePolicyConfig,
    getRegimePolicyEngine,
} from '../analytics/regimePolicy';
import {
    computeMarketDataHealth,
    MarketHealthResult,
    MarketHealthConfig,
    DEFAULT_HEALTH_CONFIG,
    buildBookSignalFromState,
    TapeSignalInput,
    LedgerSignalInput,
    BalanceSignalInput,
} from '../market/marketDataHealth';
import {
    evaluateExecutionGate,
    ExecutionGateResult,
    ExecutionGateConfig,
    DEFAULT_GATE_CONFIG,
} from '../execution/executionGate';
import {
    FeedStallRecovery,
    FeedStallState,
} from '../market/feedStallRecovery';

const cloneConfig = (cfg: AppConfig): AppConfig => ({
    xrpl: { ...cfg.xrpl },
    tradingPair: { ...cfg.tradingPair },
    tradingPairs: cfg.tradingPairs.map((p) => ({ ...p })),
    walletSeed: cfg.walletSeed,
    walletSecretNumbers: cfg.walletSecretNumbers,
    enableTestnetFaucet: cfg.enableTestnetFaucet,
    paperTrading: cfg.paperTrading,
    risk: { ...cfg.risk, issuerBlacklist: new Set(cfg.risk.issuerBlacklist) },
    strategy: { ...cfg.strategy },
    flow: { ...cfg.flow },
    analytics: { ...cfg.analytics },
});

export const validateTradingPair = (pair: TradingPair): void => {
    const isXRP = (c: string) => c.toUpperCase() === 'XRP';
    if (!isXRP(pair.baseCurrency)) {
        const issuer = pair.baseIssuer || pair.issuer;
        if (!issuer || !isValidClassicAddress(issuer)) {
            throw new Error('Base issued currency requires a valid classic issuer address');
        }
    }
    if (!isXRP(pair.quoteCurrency)) {
        const issuer = pair.quoteIssuer || pair.issuer;
        if (!issuer || !isValidClassicAddress(issuer)) {
            throw new Error('Quote issued currency requires a valid classic issuer address');
        }
    }
    if (pair.baseCurrency.toUpperCase() === pair.quoteCurrency.toUpperCase()) {
        throw new Error('Base and quote currency must differ');
    }
};

/**
 * Validate that a trading pair is in the allowed TRADING_PAIRS list.
 * This provides a runtime guard against invalid/unapproved pairs.
 */
export const assertAllowedPair = (pair: TradingPair): void => {
    const pairKey = `${pair.baseCurrency}/${pair.quoteCurrency}`;
    if (!isValidPairKey(pairKey)) {
        const allowedKeys = TRADING_PAIRS.map((p) => p.key).join(', ');
        throw new Error(
            `Trading pair "${pairKey}" is not allowed. Only these pairs are supported: ${allowedKeys}`
        );
    }
};

/** Pair-switch FSM states */
export type PairSwitchState = 'IDLE' | 'SWITCHING' | 'SYNCING' | 'READY' | 'FAILED';

/** Structured pair-switch lifecycle event for observability */
export interface PairSwitchEvent {
    event: string;
    pairKey: string;
    previousPairKey?: string | undefined;
    timestamp: number;
    switchState: PairSwitchState;
    detail?: string | undefined;
}

export class TradingRuntime {
    private xrpl: XRPLWebSocket | null = null;
    private tracker: OrderBookTracker | null = null;
    private risk: RiskEngine | null = null;
    private executor: OfferExecutor | null = null;
    private strategies: Strategy[] = [];
    private walletAddress: string | null = null;
    private tickInFlight = false;
    private started = false;
    private shutdownInProgress = false;
    private pairSwitchState: PairSwitchState = 'IDLE';
    private cpuWatchdog: CpuWatchdog | null = null;
    private tradeTape: TradeTape | null = null;
    private tradeTapeService: TradeTapeService | null = null;
    private httpServer: BackendHttpServer | null = null;
    private currentFlowMetrics: FlowMetrics | null = null;
    private capitalProtection: CapitalProtectionEngine | null = null;
    private capitalProtectionConfig: CapitalProtectionConfig | null = null;
    private lastGovernanceDecision: CapitalProtectionDecision | null = null;
    private regimePolicyEngine: RegimePolicyEngine | null = null;
    private readonly baseConfig: AppConfig;
    private marketSnapshotSequence = 0;
    private currentOrderBookSnapshot: OrderBookSnapshot | null = null;
    private currentNormalizedTrade: NormalizedTrade | null = null;
    private currentMarketHealthScore = 0;
    private lastLedgerCloseMs = 0;
    private previousLedgerIndex = 0;
    private lastBalanceSnapshotMs = 0;
    private lastBalanceLedgerIndex = 0;
    private feedStallRecovery: FeedStallRecovery | null = null;
    private lastMarketDataHealth: MarketHealthResult | null = null;
    private lastExecutionGateResult: ExecutionGateResult | null = null;
    private healthConfig: MarketHealthConfig = DEFAULT_HEALTH_CONFIG;
    private gateConfig: ExecutionGateConfig = DEFAULT_GATE_CONFIG;

    constructor(config?: AppConfig) {
        // Security gate: enforce local-only execution on construction
        try {
            enforceLocalOnly('TradingRuntime');
        } catch (err) {
            logger.error({ err }, 'Local-only security check failed');
            throw err;
        }

        this.baseConfig = config ?? loadConfig();
    }

    /**
     * Emit a structured pair-switch lifecycle event for observability.
     */
    private emitSwitchEvent(event: string, pairKey: string, previousPairKey?: string, detail?: string): void {
        const evt: PairSwitchEvent = {
            event,
            pairKey,
            previousPairKey,
            timestamp: Date.now(),
            switchState: this.pairSwitchState,
            detail,
        };
        logger.info(evt, `PAIR_SWITCH: ${event}`);
    }

    /**
     * Get the current pair-switch FSM state.
     */
    getPairSwitchState(): PairSwitchState {
        return this.pairSwitchState;
    }

    /**
     * Invalidate all cached market data snapshots.
     * Must be called on every pair switch to prevent stale cross-pair data.
     */
    private invalidateMarketCaches(): void {
        this.currentFlowMetrics = null;
        this.currentOrderBookSnapshot = null;
        this.currentNormalizedTrade = null;
        this.currentMarketHealthScore = 0;
        this.marketSnapshotSequence = 0;
    }

    async start(): Promise<void> {
        // Security gate: re-check on start
        enforceLocalOnly('TradingRuntime.start');

        if (this.started) return;
        const config = cloneConfig(this.baseConfig);

        // Validate trading pair structure
        validateTradingPair(config.tradingPair);

        // Runtime guard: ensure pair is in allowed list
        assertAllowedPair(config.tradingPair);

        // Wallet init is required for network safety checks even in paper mode.
        // Now async to support encrypted mainnet secrets with passphrase prompt.
        let walletCtx: Awaited<ReturnType<typeof initWallet>>;
        try {
            walletCtx = await initWallet(config);
        } catch (err) {
            logger.error({ err }, 'Wallet initialization failed');
            throw err instanceof Error ? err : new Error('Wallet initialization failed');
        }
        if (walletCtx.network === 'mainnet' && config.xrpl.network !== 'mainnet') {
            throw new Error('Wallet network mismatch: mainnet wallet with non-mainnet config');
        }
        if (walletCtx.network === 'testnet' && config.xrpl.network === 'mainnet') {
            throw new Error('Wallet network mismatch: testnet wallet with mainnet config');
        }

        const xrpl = new XRPLWebSocket(config.xrpl);
        try {
            await xrpl.connect();
            await xrpl.subscribe(config.tradingPair);

            const client = xrpl.getClient();
            const wallet: Wallet | null = config.paperTrading ? null : getWallet();

            const tracker = new OrderBookTracker(xrpl, config.tradingPair);
            const risk = new RiskEngine(config.risk, client);
            const executor = new OfferExecutor(client, wallet, risk, config.paperTrading, config.tradingPair, config.strategy);
            const amm = new AMMService(client);

            // Initialize trade tape for capturing executed trades
            const tradeTape = new TradeTape(config.tradingPair);
            const tradeTapeService = new TradeTapeService(tradeTape, config.tradingPair, wallet?.classicAddress ?? null);

            // Set global reference for API routes
            setGlobalTradeTape(tradeTape);

            this.tradeTape = tradeTape;
            this.tradeTapeService = tradeTapeService;

            // Track ledger close time for health scoring
            xrpl.on('ledger', () => {
                this.lastLedgerCloseMs = Date.now();
                this.previousLedgerIndex = this.xrpl?.getLedgerIndex() ?? 0;
                // Inform stall recovery that the book feed is alive
                // (ledger events prove the WS is active even if no trades)
                this.feedStallRecovery?.recordBookEvent();
            });

            let txCount = 0;
            xrpl.on('transaction', (tx: TransactionStream) => {
                txCount += 1;
                if (txCount % 5000 === 0) {
                    logger.info({ txCount, lastTxType: tx.transaction?.TransactionType }, 'TradeTape: Transaction stream active');
                }
                this.tradeTapeService?.processTransaction(tx);
                // Inform stall recovery that the tape feed is alive
                this.feedStallRecovery?.recordTapeEvent();
            });

            this.strategies = [
                new ScalperStrategy(tracker, config.strategy, config.tradingPair, executor, risk, config.flow),
                new AMMArbitrageStrategy(amm, config.strategy, config.tradingPair, executor, risk, config.flow),
                new PathArbitrageStrategy(client, config.strategy, config.tradingPair, executor, config.paperTrading, risk, config.flow),
            ];

            this.xrpl = xrpl;
            this.tracker = tracker;
            this.risk = risk;
            this.executor = executor;
            this.walletAddress = wallet?.classicAddress ?? null;
            this.started = true;

            // Initialize capital protection engine
            const cpConfig = loadCapitalProtectionConfig();
            this.capitalProtectionConfig = cpConfig;
            this.capitalProtection = new CapitalProtectionEngine({
                feedbackEngine,
                riskEngine: risk,
                config: cpConfig,
            });
            logger.info({ enabled: cpConfig.enabled }, 'Capital protection engine initialized');

            // Initialize regime policy engine
            const rpConfig = loadRegimePolicyConfig();
            if (rpConfig.enabled) {
                this.regimePolicyEngine = getRegimePolicyEngine();
                // Initial policy computation (non-blocking, best-effort)
                try {
                    this.regimePolicyEngine.recompute();
                } catch (err) {
                    logger.warn({ err }, 'Initial regime policy computation failed');
                }
                logger.info({ enabled: true }, 'Regime policy engine initialized');
            }

            // Initialize feed stall recovery
            this.feedStallRecovery = new FeedStallRecovery({
                softReconnect: async () => {
                    logger.info('Feed stall recovery: soft reconnect — re-subscribing streams');
                    await this.xrpl?.subscribe(this.baseConfig.tradingPair);
                },
                hardResubscribe: async () => {
                    logger.info('Feed stall recovery: hard resubscribe — reconnecting WebSocket');
                    await this.xrpl?.disconnect();
                    await this.xrpl?.connect();
                    await this.xrpl?.subscribe(this.baseConfig.tradingPair);
                },
                fullClientRebuild: async () => {
                    logger.warn('Feed stall recovery: full client rebuild');
                    await this.xrpl?.disconnect();
                    const { disconnectXrplClient } = await import('../xrpl/sharedClient');
                    await disconnectXrplClient();
                    await this.xrpl?.connect();
                    await this.xrpl?.subscribe(this.baseConfig.tradingPair);
                },
            });

            // Start CPU watchdog to prevent runaway CPU usage
            this.cpuWatchdog = startCpuWatchdog(() => {
                logger.warn('CPU watchdog triggered - trading paused due to high CPU');
            });

            // Start backend HTTP server for SSE streaming
            this.httpServer = await startBackendHttpServer();
            logger.info({ httpPort: this.httpServer.getPort() }, 'Backend HTTP server for trade streaming ready');

            // Start adaptive learning scheduler
            const pairKey = `${config.tradingPair.baseCurrency}/${config.tradingPair.quoteCurrency}`;
            const strategyNames = this.strategies.map(s => s.name);
            startAdaptiveScheduler({
                pairKeys: [pairKey],
                strategies: strategyNames,
            });

            logger.info('Trading runtime started');
        } catch (err) {
            await xrpl.disconnect().catch(() => undefined);
            this.reset();
            throw err;
        }
    }

    async tick(): Promise<void> {
        // Silently skip if runtime not ready or shutting down
        if (!this.started || this.shutdownInProgress) {
            return;
        }
        // Block ticks during pair switching to prevent mixed-pair execution
        if (this.pairSwitchState === 'SWITCHING' || this.pairSwitchState === 'SYNCING') {
            logger.debug({ pairSwitchState: this.pairSwitchState }, 'Skipping tick - pair switch in progress');
            return;
        }
        if (!this.xrpl || !this.tracker || !this.risk) {
            return;
        }
        if (this.tickInFlight) return; // avoid overlapping ticks

        // Skip tick if XRPL client is disconnected (will reconnect automatically)
        if (!this.xrpl.isConnected()) {
            logger.debug('Skipping tick - XRPL client reconnecting');
            return;
        }

        // CPU safety: skip tick if CPU is overloaded
        if (!isCpuHealthy()) {
            logger.debug('Skipping tick - CPU watchdog paused trading');
            return;
        }

        this.tickInFlight = true;
        try {
            // Re-check after acquiring tickInFlight lock (state may have changed)
            if (!this.tracker || !this.risk || !this.xrpl) {
                return;
            }

            // Check for daily loss reset at UTC midnight
            this.risk.checkAndResetDaily();

            if (this.risk.isShutdown()) return;
            if (this.walletAddress) {
                const reservesOk = await this.risk.checkReserves(this.walletAddress);
                if (!reservesOk) return;
                // Track balance snapshot freshness for health scoring
                this.lastBalanceSnapshotMs = Date.now();
                this.lastBalanceLedgerIndex = this.xrpl?.getLedgerIndex() ?? 0;
            }
            await this.tracker.refresh();

            // Final null check before accessing state (may have been killed during refresh)
            if (!this.tracker || !this.xrpl) {
                return;
            }

            // Build strategy context with trade tape data
            const orderBookState = this.tracker.getState();
            const pairKey = `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
            const nowMs = Date.now();
            this.marketSnapshotSequence += 1;

            this.currentOrderBookSnapshot = normalizeOrderBookSnapshot(
                pairKey,
                orderBookState,
                nowMs,
                this.marketSnapshotSequence,
            );

            const latestTrade = this.tradeTape?.getAll().at(-1) ?? null;
            this.currentNormalizedTrade = latestTrade
                ? normalizeTrade(latestTrade, nowMs, latestTrade.ts, 'tape', false)
                : null;

            this.currentMarketHealthScore = computeMarketHealth({
                trade: this.currentNormalizedTrade,
                book: this.currentOrderBookSnapshot,
                amm: null,
            });

            // ─────────────────────────────────────────────────────────────────
            // Feed Stall Recovery — evaluate and trigger staged reconnect
            // ─────────────────────────────────────────────────────────────────
            if (this.feedStallRecovery) {
                await this.feedStallRecovery.evaluate();
            }

            // ─────────────────────────────────────────────────────────────────
            // Market Data Health Quorum — multi-signal truth enforcement
            // ─────────────────────────────────────────────────────────────────
            const tapeSignal: TapeSignalInput = {
                lastEventMs: latestTrade?.ts ?? 0,
                eventCount: this.tradeTape?.getRecent(60_000).length ?? 0,
                isMonotonic: true, // TradeTape.insertSorted guarantees monotonicity
                lastPrice: latestTrade?.price ?? 0,
            };
            const ledgerSignal: LedgerSignalInput = {
                ledgerIndex: this.xrpl.getLedgerIndex(),
                previousLedgerIndex: this.previousLedgerIndex,
                lastCloseMs: this.lastLedgerCloseMs,
            };
            const balanceSignal: BalanceSignalInput = {
                lastSnapshotMs: this.lastBalanceSnapshotMs,
                snapshotLedgerIndex: this.lastBalanceLedgerIndex,
                currentLedgerIndex: this.xrpl.getLedgerIndex(),
            };
            const bookSignal = buildBookSignalFromState(orderBookState);
            const marketDataHealth = computeMarketDataHealth(
                { tape: tapeSignal, book: bookSignal, ledger: ledgerSignal, balance: balanceSignal },
                this.healthConfig,
                this.gateConfig.minHealthScore,
                nowMs,
            );
            this.lastMarketDataHealth = marketDataHealth;

            // ─────────────────────────────────────────────────────────────────
            // Execution Gate — block strategies if data truth quorum fails
            // ─────────────────────────────────────────────────────────────────
            const gateResult = evaluateExecutionGate({
                health: marketDataHealth,
                isConnected: this.xrpl.isConnected(),
                isReconnecting: this.xrpl.isReconnecting(),
                pairSwitchState: this.pairSwitchState,
                isShuttingDown: this.shutdownInProgress,
                isInRecovery: this.feedStallRecovery?.isRecovering() ?? false,
                ledgerIndex: this.xrpl.getLedgerIndex(),
                lastLedgerCloseMs: this.lastLedgerCloseMs,
            }, this.gateConfig);
            this.lastExecutionGateResult = gateResult;

            if (gateResult.verdict === 'BLOCK') {
                logger.debug({
                    verdict: gateResult.verdict,
                    healthScore: gateResult.healthScore,
                    reasons: gateResult.reasons,
                }, 'Execution gate BLOCKED tick');
                return;
            }

            // Compute flow metrics from trade tape and order book
            const flowMetrics = computeFlowMetrics(this.tradeTape, orderBookState, this.baseConfig.flow);
            this.currentFlowMetrics = flowMetrics;

            // Record market snapshot for analytics (non-blocking, best-effort)
            try {
                feedbackEngine.recordSnapshot({
                    pairKey,
                    ledgerIndex: this.xrpl.getLedgerIndex(),
                    orderBook: orderBookState,
                    flow: flowMetrics,
                });
            } catch {
                // Feedback recording should never crash trading
            }

            // ─────────────────────────────────────────────────────────────────
            // Capital Protection Gate
            // ─────────────────────────────────────────────────────────────────
            let governanceDecision: CapitalProtectionDecision | undefined;
            let globalSizeMultiplier = 1.0;
            let globalCooldownMs = 0;

            if (this.capitalProtection) {
                governanceDecision = this.capitalProtection.evaluate(pairKey);
                this.lastGovernanceDecision = governanceDecision;

                // Handle SHUTDOWN - initiate graceful shutdown
                if (governanceDecision.mode === 'SHUTDOWN') {
                    logger.error({
                        reasons: governanceDecision.reasons,
                        metrics: governanceDecision.metrics,
                    }, 'Capital protection triggered SHUTDOWN');
                    // Set emergency shutdown flag and exit tick
                    if (this.risk) {
                        // Mirror the shutdown state to RiskEngine for consistency
                        this.baseConfig.risk.emergencyShutdown = true;
                    }
                    return;
                }

                // Handle PAUSE - skip all strategies
                if (governanceDecision.mode === 'PAUSE') {
                    logger.info({
                        reasons: governanceDecision.reasons,
                        cooldownMs: governanceDecision.cooldownMs,
                    }, 'Capital protection: PAUSE - skipping strategies');
                    return;
                }

                // Handle THROTTLE - apply global size multiplier and cooldown
                if (governanceDecision.mode === 'THROTTLE') {
                    globalSizeMultiplier = governanceDecision.sizeMultiplier;
                    globalCooldownMs = governanceDecision.cooldownMs;
                    logger.debug({
                        reasons: governanceDecision.reasons,
                        sizeMultiplier: globalSizeMultiplier,
                        cooldownMs: globalCooldownMs,
                    }, 'Capital protection: THROTTLE active');
                }

                // Apply governance cooldown if any
                if (globalCooldownMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, globalCooldownMs));
                }
            }

            const ctx = {
                orderBook: orderBookState,
                ledgerIndex: this.xrpl.getLedgerIndex(),
                trades: this.tradeTape?.getRecent(60_000),
                tradeStats: this.tradeTape?.getAggression(10_000),
                vwap: this.tradeTape?.getVWAP(60_000),
                flow: flowMetrics,
                governance: governanceDecision,
                globalSizeMultiplier,
                globalCooldownMs,
                // regimePolicy will be set per-strategy below
            };

            const regime: FlowRegime = flowMetrics.regime;

            // Get current regime policy (cached, fast)
            const regimePolicy = this.regimePolicyEngine?.getCurrentPolicy() ?? null;

            for (const strategy of this.strategies) {
                // Rate limit strategy execution to prevent CPU spikes
                await throttleStrategy();

                // Check if strategy is disabled by governance
                if (governanceDecision?.disabledStrategies?.includes(strategy.name)) {
                    logger.debug({
                        strategy: strategy.name,
                        reasons: governanceDecision.reasons,
                    }, 'Skipping strategy - disabled by capital protection');
                    continue;
                }

                // Check if regime is disabled by governance (capital protection)
                if (governanceDecision?.disabledRegimes?.includes(regime)) {
                    logger.debug({
                        strategy: strategy.name,
                        regime,
                        reasons: governanceDecision.reasons,
                    }, 'Skipping strategy - regime disabled by capital protection');
                    continue;
                }

                // ─────────────────────────────────────────────────────────────
                // Regime Policy Gate
                // ─────────────────────────────────────────────────────────────
                let regimePolicyContext: StrategyRegimePolicyContext | undefined;

                if (this.regimePolicyEngine && regimePolicy) {
                    const isRegimeDisabledGlobal = regimePolicy.global.disabledRegimes.includes(regime);
                    const strategyPolicy = regimePolicy.strategies[strategy.name];
                    const isRegimeDisabledStrategy = strategyPolicy?.disabledRegimes.includes(regime) ?? false;
                    const isDisabled = isRegimeDisabledGlobal || isRegimeDisabledStrategy;

                    // Get size multiplier from regime policy
                    const regimeSizeMultiplier = this.regimePolicyEngine.getEffectiveSizeMultiplier(strategy.name, regime);
                    const currentRegimeSizePolicy = strategyPolicy?.sizeByRegime[regime]
                        ?? regimePolicy.global.sizeByRegime[regime]
                        ?? null;

                    regimePolicyContext = {
                        currentRegime: regime,
                        isRegimeDisabledGlobal,
                        isRegimeDisabledStrategy,
                        isRegimeDisabled: isDisabled,
                        regimeSizeMultiplier,
                        policy: regimePolicy,
                        currentRegimeSizePolicy,
                    };

                    // Skip strategy if regime is disabled by regime policy
                    if (isDisabled) {
                        logger.debug({
                            strategy: strategy.name,
                            regime,
                            global: isRegimeDisabledGlobal,
                            strategySpecific: isRegimeDisabledStrategy,
                        }, 'Skipping strategy - regime disabled by regime policy');
                        continue;
                    }

                    // Apply regime policy size multiplier to executor (multiplied with governance multiplier)
                    if (this.executor && regimeSizeMultiplier < 1.0) {
                        const combinedMultiplier = globalSizeMultiplier * regimeSizeMultiplier;
                        this.executor.setRegimePolicySizeMultiplier(combinedMultiplier);
                    }
                }

                // Apply governance size multiplier to executor
                if (this.executor && globalSizeMultiplier < 1.0) {
                    this.executor.setGovernanceSizeMultiplier(globalSizeMultiplier);
                }

                // Apply adaptive learning gates and tunings
                if (isAdaptiveEnabled() && this.executor) {
                    // Check if this regime is disabled for this strategy
                    if (isRegimeDisabled(pairKey, strategy.name, regime)) {
                        logger.debug({
                            strategy: strategy.name,
                            regime,
                        }, 'Skipping strategy - regime disabled by adaptive learning');
                        continue;
                    }

                    // Get tuning for this strategy+regime
                    const tuning = getAdaptiveTuning(pairKey, strategy.name, regime);
                    if (tuning) {
                        // Apply tuning overrides to executor
                        this.executor.setAdaptiveMaxSlippageBps(tuning.maxSlippageBps);
                        this.executor.setAdaptiveSizeMultiplier(tuning.sizeMultiplier);
                        this.executor.setAdaptiveMinEdgeBps(tuning.minEdgeBpsToTrade);

                        // Apply cooldown if set
                        if (tuning.coolDownMs > 0) {
                            await new Promise(resolve => setTimeout(resolve, tuning.coolDownMs));
                        }
                    } else {
                        // No tuning - clear overrides
                        this.executor.clearAdaptiveOverrides();
                    }
                }

                // Build strategy-specific context with regime policy
                const strategyCtx = {
                    ...ctx,
                    regimePolicy: regimePolicyContext,
                };

                await strategy.tick(strategyCtx);

                // Clear overrides after each strategy to avoid cross-contamination
                if (this.executor) {
                    this.executor.clearAdaptiveOverrides();
                    this.executor.clearGovernanceOverrides();
                    this.executor.clearRegimePolicyOverrides();
                }
            }
        } finally {
            this.tickInFlight = false;
        }
    }

    async pause(): Promise<void> {
        if (!this.started) return;
        logger.info('Trading runtime paused');
    }

    async kill(): Promise<void> {
        if (this.xrpl) {
            await this.xrpl.disconnect().catch((err) => logger.warn({ err }, 'XRPL disconnect failed'));
        }
        this.reset();
        logger.info('Trading runtime stopped');
    }

    /**
     * Get the current flow metrics. Returns null if not started or no metrics computed yet.
     */
    getFlowMetrics(): FlowMetrics | null {
        return this.currentFlowMetrics;
    }

    getMarketHealth(): {
        score: number;
        orderBook: OrderBookSnapshot | null;
        lastTrade: NormalizedTrade | null;
    } {
        return {
            score: this.currentMarketHealthScore,
            orderBook: this.currentOrderBookSnapshot,
            lastTrade: this.currentNormalizedTrade,
        };
    }

    /**
     * Get the current governance decision from capital protection layer.
     * Returns null if not started or capital protection is disabled.
     */
    getGovernanceStatus(): { decision: CapitalProtectionDecision | null; config: CapitalProtectionConfig | null } {
        return {
            decision: this.lastGovernanceDecision,
            config: this.capitalProtectionConfig,
        };
    }

    /**
     * Get the current regime policy.
     * Returns null if regime policy is disabled or not initialized.
     */
    getRegimePolicy(): RegimePolicy | null {
        return this.regimePolicyEngine?.getCurrentPolicy() ?? null;
    }

    /**
     * Recompute the regime policy (trigger manual update).
     * Returns the new policy or null if regime policy is disabled.
     */
    recomputeRegimePolicy(): RegimePolicy | null {
        return this.regimePolicyEngine?.recompute() ?? null;
    }

    /**
     * Get the flow configuration.
     */
    getFlowConfig(): FlowConfig {
        return this.baseConfig.flow;
    }

    /**
     * Get the latest market data health quorum result.
     */
    getMarketDataHealth(): MarketHealthResult | null {
        return this.lastMarketDataHealth;
    }

    /**
     * Get the latest execution gate result.
     */
    getExecutionGateResult(): ExecutionGateResult | null {
        return this.lastExecutionGateResult;
    }

    /**
     * Get the current feed stall recovery state.
     */
    getFeedStallState(): FeedStallState | null {
        return this.feedStallRecovery?.getState() ?? null;
    }

    /**
     * Graceful shutdown: cancel open offers, stop strategies, disconnect.
     * Called on SIGTERM/SIGINT for clean process exit.
     * 
     * Idempotent: calling multiple times is safe.
     * Uses LIFO (Last-In-First-Out) order for strategy teardown.
     */
    async shutdown(): Promise<void> {
        // Idempotency guard: prevent concurrent/duplicate shutdown
        if (this.shutdownInProgress) {
            logger.debug('Shutdown already in progress, skipping duplicate call');
            return;
        }
        this.shutdownInProgress = true;

        const totalSteps = 7;
        let currentStep = 0;

        const logStep = (description: string) => {
            currentStep++;
            logger.info({ step: currentStep, totalSteps }, `[Shutdown ${currentStep}/${totalSteps}] ${description}`);
        };

        logger.info('Starting graceful shutdown sequence...');

        // Step 1: Stop accepting new ticks
        logStep('Stopping tick processing');
        this.tickInFlight = true;

        // Step 2: Cancel all open offers created by the bot (best-effort)
        logStep('Cancelling open offers');
        if (this.executor && this.walletAddress && this.xrpl?.getClient()?.isConnected()) {
            try {
                await this.cancelAllOpenOffers();
            } catch (err) {
                logger.warn({ err }, 'Failed to cancel some offers during shutdown');
            }
        }

        // Step 3: Stop strategies in LIFO order (reverse of initialization)
        logStep('Stopping strategies (LIFO order)');
        for (let i = this.strategies.length - 1; i >= 0; i--) {
            const strategy = this.strategies[i];
            if (!strategy) continue;
            const strategyName = strategy.name || `Strategy[${i}]`;
            logger.debug({ strategyName, index: i }, 'Shutting down strategy');
            if ('shutdown' in strategy && typeof strategy.shutdown === 'function') {
                try {
                    await strategy.shutdown();
                    logger.debug({ strategyName }, 'Strategy shutdown complete');
                } catch (err) {
                    logger.warn({ err, strategyName }, 'Strategy shutdown error');
                }
            }
        }

        // Step 4: Close circuit breaker persistence store
        logStep('Closing persistence stores');
        try {
            await closeBreakerStore();
        } catch (err) {
            logger.warn({ err }, 'Failed to close breaker store');
        }

        // Close feedback engine
        try {
            feedbackEngine.shutdown();
        } catch (err) {
            logger.warn({ err }, 'Failed to close feedback engine');
        }

        // Stop adaptive learning scheduler
        try {
            stopAdaptiveScheduler();
        } catch (err) {
            logger.warn({ err }, 'Failed to stop adaptive scheduler');
        }

        // Step 5: Stop backend HTTP server
        logStep('Stopping backend HTTP server');
        try {
            await stopBackendHttpServer();
        } catch (err) {
            logger.warn({ err }, 'Failed to stop HTTP server');
        }

        // Step 6: Disconnect XRPL cleanly
        logStep('Disconnecting XRPL client');
        if (this.xrpl) {
            await this.xrpl.disconnect().catch((err) => logger.warn({ err }, 'XRPL disconnect failed during shutdown'));
        }

        // Step 7: Reset state
        logStep('Resetting runtime state');
        this.reset();

        logger.info({ totalSteps }, 'Graceful shutdown complete');
    }

    /**
     * Cancel all open offers for the bot's wallet (best-effort).
     * Used during graceful shutdown.
     */
    private async cancelAllOpenOffers(): Promise<void> {
        if (!this.walletAddress || !this.xrpl?.getClient()?.isConnected()) {
            return;
        }

        const client = this.xrpl.getClient();

        try {
            const response = await client.request({
                command: 'account_offers',
                account: this.walletAddress,
            });

            const offers = response.result?.offers ?? [];
            if (offers.length === 0) {
                logger.info('No open offers to cancel during shutdown');
                return;
            }

            logger.info({ offerCount: offers.length }, 'Cancelling open offers during shutdown');

            // Cancel each offer (with some parallelism but not too aggressive)
            const cancelPromises = offers.map((offer: any, index: number) =>
                // Stagger cancellations slightly to avoid sequence issues
                new Promise<void>((resolve) => {
                    setTimeout(async () => {
                        try {
                            await this.executor?.cancelOffer(offer.seq);
                            logger.debug({ seq: offer.seq }, 'Cancelled offer during shutdown');
                        } catch (err) {
                            logger.warn({ err, seq: offer.seq }, 'Failed to cancel offer during shutdown');
                        }
                        resolve();
                    }, index * 100); // 100ms stagger between cancellations
                })
            );

            await Promise.all(cancelPromises);
            logger.info({ cancelled: offers.length }, 'Finished cancelling offers during shutdown');
        } catch (err) {
            logger.warn({ err }, 'Failed to fetch open offers during shutdown');
        }
    }

    setPositionSize(size: number): void {
        if (!Number.isFinite(size) || size <= 0) {
            throw new Error('Position size must be positive');
        }
        this.baseConfig.strategy.positionSize = size;
        this.strategies.forEach((strategy: any) => {
            if (typeof strategy.setPositionSize === 'function') {
                strategy.setPositionSize(size);
            }
        });
        logger.info({ size }, 'Updated position size');
    }

    setTradingPair(pair: TradingPair): void {
        if (this.started) {
            const nextPairKey = `${pair.baseCurrency}/${pair.quoteCurrency}`;
            const switched = this.setActivePair(nextPairKey);
            if (!switched.success) {
                throw new Error(switched.error || 'Failed to switch trading pair');
            }
            return;
        }
        validateTradingPair(pair);
        const { baseCurrency, quoteCurrency, baseIssuer, quoteIssuer, issuer, description } = pair;
        if (baseCurrency.toUpperCase() === quoteCurrency.toUpperCase()) {
            throw new Error('Base and quote currency must differ');
        }
        this.baseConfig.tradingPair = {
            baseCurrency,
            quoteCurrency,
            baseIssuer: baseIssuer ?? issuer ?? '',
            quoteIssuer: quoteIssuer ?? issuer ?? '',
            issuer: issuer ?? '',
            ...(description ? { description } : {}),
        };
        this.baseConfig.tradingPairs = [this.baseConfig.tradingPair];
        logger.info({ tradingPair: this.baseConfig.tradingPair }, 'Updated trading pair');
    }

    getActivePair(): string {
        return `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
    }

    setActivePair(pairKey: string): { success: boolean; activePair: string; error?: string } {
        const currentPairKey = this.getActivePair();

        // Idempotent: no-op if already on this pair
        if (pairKey === currentPairKey) {
            return { success: true, activePair: currentPairKey };
        }

        // Reject if already switching (FSM guard)
        if (this.pairSwitchState === 'SWITCHING' || this.pairSwitchState === 'SYNCING') {
            return { success: false, activePair: currentPairKey, error: 'Pair switch already in progress' };
        }

        if (!pairKey || !isValidPairKey(pairKey)) {
            return { success: false, activePair: currentPairKey, error: `Invalid pair key: ${pairKey}` };
        }

        const target = TRADING_PAIRS.find((p) => p.key === pairKey);
        if (!target) {
            return { success: false, activePair: currentPairKey, error: `Pair not found: ${pairKey}` };
        }

        // ─── FSM: IDLE → SWITCHING ───────────────────────────────────────
        this.pairSwitchState = 'SWITCHING';
        this.emitSwitchEvent('PAIR_SWITCH_START', pairKey, currentPairKey);

        const previousPair = { ...this.baseConfig.tradingPair };
        const previousPairKey = currentPairKey;

        const applyPair = (candidate: TradingPair): void => {
            // 1. Config (single source of truth)
            this.baseConfig.tradingPair = { ...candidate };
            this.baseConfig.tradingPairs = [{ ...candidate }];

            // 2. Market data layer — clears buffers for the new pair
            this.tradeTape?.setPair(candidate);
            this.tradeTapeService?.setPair(candidate);
            this.tracker?.setPair(candidate);

            // 3. Execution layer — executor must target new pair
            this.executor?.setPair(candidate);

            // 4. Strategy layer — all strategies must target new pair
            for (const strategy of this.strategies) {
                if (typeof strategy.setPair === 'function') {
                    strategy.setPair(candidate);
                }
            }
        };

        try {
            const nextPair: TradingPair = {
                baseCurrency: target.base.currency,
                quoteCurrency: target.quote.currency,
                baseIssuer: target.base.issuer,
                quoteIssuer: target.quote.issuer,
                issuer: target.quote.issuer ?? target.base.issuer,
                description: target.description,
            };

            validateTradingPair(nextPair);
            assertAllowedPair(nextPair);

            applyPair(nextPair);
            this.emitSwitchEvent('PAIR_SWITCH_APPLY_COMPLETE', pairKey, previousPairKey);

            // ─── FSM: SWITCHING → SYNCING ────────────────────────────────
            this.pairSwitchState = 'SYNCING';

            // Invalidate all stale market caches from the previous pair
            this.invalidateMarketCaches();
            this.emitSwitchEvent('PAIR_SWITCH_CACHES_INVALIDATED', pairKey, previousPairKey);

            // ─── FSM: SYNCING → READY ────────────────────────────────────
            this.pairSwitchState = 'READY';
            // Will transition to IDLE on next successful tick
            this.pairSwitchState = 'IDLE';
            this.emitSwitchEvent('PAIR_SWITCH_COMPLETE', pairKey, previousPairKey);

            return { success: true, activePair: this.getActivePair() };
        } catch (err) {
            // ─── FSM: → FAILED, then rollback → IDLE ─────────────────────
            this.pairSwitchState = 'FAILED';
            this.emitSwitchEvent('PAIR_SWITCH_FAILED', pairKey, previousPairKey,
                err instanceof Error ? err.message : 'unknown error');

            try {
                applyPair(previousPair);
            } catch (rollbackErr) {
                logger.error({ rollbackErr, pair: previousPairKey }, 'Rollback applyPair failed');
            }

            // Always invalidate caches after a failed switch attempt,
            // regardless of whether rollback succeeded. Stale cross-pair
            // data is worse than empty caches.
            this.invalidateMarketCaches();

            this.pairSwitchState = 'IDLE';

            const error = err instanceof Error ? err.message : 'unknown error';
            logger.error({ err, from: previousPairKey, attempted: pairKey }, 'Failed to switch pair, rolled back');
            return { success: false, activePair: this.getActivePair(), error };
        }
    }

    /**
     * Cancel an offer by sequence number.
     * Routes through the executor to use proper signing.
     */
    async cancelOffer(offerSequence: number): Promise<ExecutionResult> {
        if (!this.executor) {
            throw new Error('Trading runtime not started - cannot cancel offers');
        }
        logger.info({ offerSequence }, 'Cancelling offer via runtime');
        return this.executor.cancelOffer(offerSequence);
    }

    /**
     * Get the XRPL client for read-only operations.
     * Returns null if runtime not started.
     */
    getClient(): Client | null {
        return this.xrpl?.getClient() ?? null;
    }

    /**
     * Check if runtime is started.
     */
    isStarted(): boolean {
        return this.started;
    }

    /**
     * Get the wallet address (if available).
     */
    getWalletAddress(): string | null {
        return this.walletAddress;
    }

    /**
     * Get the current config (read-only).
     */
    getConfig(): AppConfig {
        return this.baseConfig;
    }

    /**
     * Get the order book tracker state (for API routes in single-process mode).
     */
    getOrderBookState(): import('../utils/types').OrderBookState | null {
        return this.tracker?.getState() ?? null;
    }

    /**
     * Get the current risk status for dashboard/API.
     */
    getRiskStatus(): {
        maxExposure: number;
        currentExposure: number;
        dailyLossLimit: number;
        dailyLossCurrent: number;
        killSwitch: boolean;
        consecutiveFailures: number;
        maxTradeSize: number;
        reserveFloorXRP: number;
    } | null {
        return this.risk?.getStatus() ?? null;
    }

    /**
     * Get the trade tape instance (for API routes).
     */
    getTradeTape(): TradeTape | null {
        return this.tradeTape;
    }

    /**
     * Get the trade tape service instance.
     */
    getTradeTapeService(): TradeTapeService | null {
        return this.tradeTapeService;
    }

    private reset(): void {
        // Stop CPU watchdog
        if (this.cpuWatchdog) {
            this.cpuWatchdog.stop();
            this.cpuWatchdog = null;
        }

        // Clear global trade tape reference
        setGlobalTradeTape(null);

        // Invalidate all market caches
        this.invalidateMarketCaches();

        this.xrpl = null;
        this.tracker = null;
        this.risk = null;
        this.executor = null;
        this.strategies = [];
        this.walletAddress = null;
        this.tickInFlight = false;
        this.started = false;
        this.shutdownInProgress = false;
        this.pairSwitchState = 'IDLE';
        this.tradeTape = null;
        this.tradeTapeService = null;
        this.httpServer = null;
        this.capitalProtection = null;
        this.capitalProtectionConfig = null;
        this.lastGovernanceDecision = null;

        // Reset feed stall recovery and health state
        this.feedStallRecovery?.reset();
        this.feedStallRecovery = null;
        this.lastMarketDataHealth = null;
        this.lastExecutionGateResult = null;
        this.lastLedgerCloseMs = 0;
        this.previousLedgerIndex = 0;
        this.lastBalanceSnapshotMs = 0;
        this.lastBalanceLedgerIndex = 0;
    }

}
