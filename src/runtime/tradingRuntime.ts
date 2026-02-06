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
import {
    SnapshotValidator,
} from '../market/snapshotValidator';
import { RuntimeCacheRegistry } from './runtimeCacheRegistry';
import {
    PairSwitchOrchestrator,
    PairSwitchActions,
    PairContext,
} from './pairSwitchOrchestrator';
import {
    PairSwitchPhase,
} from './pairSwitchFsm';
import {
    RuntimeFSM,
    RuntimeState,
    RuntimeFSMSnapshot,
} from './runtimeFsm';
import {
    buildRuntimeTelemetry,
    RuntimeTelemetry,
} from './runtimeObservability';

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

/**
 * @deprecated Use PairSwitchPhase from pairSwitchFsm.ts for the 12-state FSM.
 * Kept for backward compatibility with tests and external consumers.
 */
export type PairSwitchState = 'IDLE' | 'SWITCHING' | 'SYNCING' | 'READY' | 'FAILED';

/** Structured pair-switch lifecycle event for observability */
export interface PairSwitchEvent {
    event: string;
    pairKey: string;
    previousPairKey?: string | undefined;
    timestamp: number;
    switchState: PairSwitchState;
    /** The 12-state FSM phase (if orchestrator is active). */
    switchPhase?: PairSwitchPhase | undefined;
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
    /** @deprecated Legacy field — use pairSwitchOrchestrator.getPhase(). */
    private pairSwitchState: PairSwitchState = 'IDLE';
    /** 12-state pair-switch orchestrator with context isolation. */
    private readonly pairSwitchOrchestrator = new PairSwitchOrchestrator();
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
    /** Structural snapshot validator — detects sequence gaps, timestamp regressions, NaN. */
    private snapshotValidator = new SnapshotValidator();
    /** Centralized pair-keyed cache — the single source of truth for API routes. */
    private readonly cacheRegistry = new RuntimeCacheRegistry();
    /** Whether the last snapshot passed structural validation. */
    private lastDataValid = true;
    /** Reasons the last snapshot failed validation (empty when valid). */
    private lastDataInvalidReasons: string[] = [];
    /** Runtime lifecycle FSM — replaces the old `started`/`shutdownInProgress` booleans. */
    private readonly fsm: RuntimeFSM;
    /** Whether the first tick with market data has completed (triggers WARMING→READY). */
    private firstTickCompleted = false;
    /** Timestamp of last order-book update received (ms epoch). */
    private lastBookUpdateMs = 0;
    /** Timestamp of last trade-tape event received (ms epoch). */
    private lastTapeUpdateMs = 0;
    /** Timestamp of last validated ledger advance (ms epoch). */
    private lastLedgerAdvanceMs = 0;
    /** Guard to prevent duplicate event listeners on restart. */
    private listenersAttached = false;

    constructor(config?: AppConfig) {
        // Security gate: enforce local-only execution on construction
        try {
            enforceLocalOnly('TradingRuntime');
        } catch (err) {
            logger.error({ err }, 'Local-only security check failed');
            throw err;
        }

        this.baseConfig = config ?? loadConfig();
        this.fsm = new RuntimeFSM();
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
            switchPhase: this.pairSwitchOrchestrator.getPhase(),
            detail,
        };
        logger.info(evt, `PAIR_SWITCH: ${event}`);
    }

    /**
     * Get the current pair-switch FSM state (legacy 5-state).
     * @deprecated Use getPairSwitchPhase() for the 12-state FSM.
     */
    getPairSwitchState(): PairSwitchState {
        return this.pairSwitchState;
    }

    /**
     * Get the current 12-state pair-switch FSM phase.
     */
    getPairSwitchPhase(): PairSwitchPhase {
        return this.pairSwitchOrchestrator.getPhase();
    }

    /**
     * Get the pair-switch orchestrator (for API/observability).
     */
    getPairSwitchOrchestrator(): PairSwitchOrchestrator {
        return this.pairSwitchOrchestrator;
    }

    /**
     * Get the current pair context from the orchestrator.
     */
    getPairContext(): PairContext | null {
        return this.pairSwitchOrchestrator.getContext();
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
        this.snapshotValidator.reset();
        this.lastDataValid = true;
        this.lastDataInvalidReasons = [];
        this.cacheRegistry.reset();
        // Reset feed timestamps to prevent stale-data false positives for the new pair
        this.lastBookUpdateMs = 0;
        this.lastTapeUpdateMs = 0;
        this.lastLedgerAdvanceMs = 0;
        this.lastBalanceSnapshotMs = 0;
        this.lastBalanceLedgerIndex = 0;
        // Reset health state from previous pair
        this.lastMarketDataHealth = null;
        this.lastExecutionGateResult = null;
    }

    async start(): Promise<void> {
        // Security gate: re-check on start
        enforceLocalOnly('TradingRuntime.start');

        if (this.started) return;

        // FSM: ensure we are in BOOTING state
        if (this.fsm.getState() !== 'BOOTING') {
            throw new Error(`Cannot start runtime: FSM is in ${this.fsm.getState()}, expected BOOTING`);
        }

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
            // FSM: BOOTING → SYNCING_LEDGER
            this.fsm.transition('SYNCING_LEDGER', 'xrpl-connecting');
            await xrpl.connect();

            // FSM: SYNCING_LEDGER → SUBSCRIBING_FEEDS
            this.fsm.transition('SUBSCRIBING_FEEDS', 'xrpl-subscribing');
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

            // ── Listener dedup guard ─────────────────────────────────────
            // Prevents stacking duplicate event listeners if start() is
            // somehow called again after a reset()/restart cycle.
            if (!this.listenersAttached) {
                // Track ledger close time for health scoring
                xrpl.on('ledger', () => {
                    this.lastLedgerCloseMs = Date.now();
                    this.lastLedgerAdvanceMs = Date.now();
                    this.previousLedgerIndex = this.xrpl?.getLedgerIndex() ?? 0;
                    // Inform stall recovery that the book feed is alive
                    // (ledger events prove the WS is active even if no trades)
                    this.feedStallRecovery?.recordBookEvent();
                });

                let txCount = 0;
                xrpl.on('transaction', (tx: TransactionStream) => {
                    txCount += 1;
                    this.lastTapeUpdateMs = Date.now();
                    if (txCount % 5000 === 0) {
                        logger.info({ txCount, lastTxType: tx.transaction?.TransactionType }, 'TradeTape: Transaction stream active');
                    }
                    this.tradeTapeService?.processTransaction(tx);
                    // Inform stall recovery that the tape feed is alive
                    this.feedStallRecovery?.recordTapeEvent();
                });

                // Emit XRPL_RECONNECTED observability event on WebSocket reconnect
                xrpl.on('reconnect', () => {
                    logger.info({ event: 'XRPL_RECONNECTED', timestamp: Date.now() }, 'XRPL WebSocket reconnected');
                });

                this.listenersAttached = true;
            }

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

            // FSM: SUBSCRIBING_FEEDS → WARMING_MARKET_CACHE
            this.fsm.transition('WARMING_MARKET_CACHE', 'components-initialized');

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
            this.fsm.forceHalt('start-failed');
            this.reset();
            throw err;
        }
    }

    async tick(): Promise<void> {
        // Silently skip if runtime not ready or shutting down
        if (!this.started || this.shutdownInProgress) {
            return;
        }
        // FSM guard: skip ticks in non-operational states
        if (this.fsm.isHalted()) {
            return;
        }
        // Block ticks during pair switching to prevent mixed-pair execution
        if (this.pairSwitchState === 'SWITCHING' || this.pairSwitchState === 'SYNCING') {
            logger.debug({ pairSwitchState: this.pairSwitchState }, 'Skipping tick - pair switch in progress (legacy)');
            return;
        }
        // 12-state FSM guard: block unless orchestrator is READY
        if (!this.pairSwitchOrchestrator.isReady()) {
            logger.debug({ phase: this.pairSwitchOrchestrator.getPhase() }, 'Skipping tick - pair switch FSM not READY');
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
            this.lastBookUpdateMs = Date.now();

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

            // ─────────────────────────────────────────────────────────────────
            // Snapshot Structural Validation — sequence, timestamps, numerics
            // ─────────────────────────────────────────────────────────────────
            const validation = this.snapshotValidator.validate(this.currentOrderBookSnapshot);
            const wasInvalid = !this.lastDataValid;
            this.lastDataValid = validation.valid;
            this.lastDataInvalidReasons = validation.reasons;

            if (!validation.valid && (wasInvalid !== true || this.lastDataInvalidReasons.length > 0)) {
                logger.info({
                    event: 'DATA_INVALIDATED',
                    reasons: validation.reasons,
                    sequence: this.currentOrderBookSnapshot.sequence,
                    pairKey,
                    timestamp: nowMs,
                }, 'DATA_INVALIDATED: snapshot failed structural validation');
            }
            if (validation.valid && wasInvalid) {
                logger.info({
                    event: 'DATA_RECOVERED',
                    sequence: this.currentOrderBookSnapshot.sequence,
                    pairKey,
                    timestamp: nowMs,
                }, 'DATA_RECOVERED: snapshot validation passed after previous failure');
            }

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
                const stallStateBefore = this.feedStallRecovery.isRecovering();
                await this.feedStallRecovery.evaluate();
                const stallStateAfter = this.feedStallRecovery.isRecovering();

                // FSM: transition to RECOVERING when stall recovery starts
                if (!stallStateBefore && stallStateAfter &&
                    (this.fsm.getState() === 'READY' || this.fsm.getState() === 'DEGRADED')) {
                    const stallState = this.feedStallRecovery?.getState();
                    logger.info({
                        event: 'FEED_STALE',
                        stage: stallState?.stage ?? 'UNKNOWN',
                        timestamp: Date.now(),
                    }, 'FEED_STALE: feed stall detected, entering recovery');
                    logger.info({
                        event: 'RECOVERY_STAGE',
                        from: this.fsm.getState(),
                        to: 'RECOVERING',
                        stage: stallState?.stage ?? 'UNKNOWN',
                        timestamp: Date.now(),
                    }, 'RECOVERY_STAGE: entering RECOVERING state');
                    this.fsm.transition('RECOVERING', 'feed-stall-recovery-started');
                }
                // FSM: transition out of RECOVERING when stall recovery completes
                if (stallStateBefore && !stallStateAfter && this.fsm.getState() === 'RECOVERING') {
                    logger.info({
                        event: 'RECOVERY_STAGE',
                        from: 'RECOVERING',
                        to: 'DEGRADED',
                        timestamp: Date.now(),
                    }, 'RECOVERY_STAGE: stall recovery completed, transitioning to DEGRADED');
                    // Will determine READY vs DEGRADED after health scoring below
                    // For now go to DEGRADED; health check may promote to READY
                    this.fsm.transition('DEGRADED', 'feed-stall-recovery-completed');
                }
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
                runtimeState: this.fsm.getState(),
                health: marketDataHealth,
                isConnected: this.xrpl.isConnected(),
                isReconnecting: this.xrpl.isReconnecting(),
                pairSwitchState: this.pairSwitchOrchestrator.getPhase(),
                isShuttingDown: this.shutdownInProgress,
                isInRecovery: this.feedStallRecovery?.isRecovering() ?? false,
                isRiskShutdown: this.risk.isShutdown(),
                dataValid: this.lastDataValid,
                dataInvalidReasons: this.lastDataInvalidReasons,
                ledgerIndex: this.xrpl.getLedgerIndex(),
                lastLedgerCloseMs: this.lastLedgerCloseMs,
            }, this.gateConfig);
            this.lastExecutionGateResult = gateResult;

            // ─────────────────────────────────────────────────────────────────
            // Runtime FSM — health-based state transitions
            // ─────────────────────────────────────────────────────────────────
            const currentFsmState = this.fsm.getState();
            if (currentFsmState === 'WARMING_MARKET_CACHE' && !this.firstTickCompleted) {
                // First tick with data received — transition to operational state
                this.firstTickCompleted = true;
                if (marketDataHealth.healthy) {
                    this.fsm.transition('READY', 'first-tick-healthy');
                } else {
                    this.fsm.transition('DEGRADED', 'first-tick-unhealthy');
                }
            } else if (currentFsmState === 'READY' && !marketDataHealth.healthy) {
                // Health dropped below threshold
                this.fsm.transition('DEGRADED', `health-degraded:${marketDataHealth.score}`);
            } else if (currentFsmState === 'DEGRADED' && marketDataHealth.healthy &&
                !(this.feedStallRecovery?.isRecovering())) {
                // Health recovered and no stall recovery in progress
                this.fsm.transition('READY', `health-recovered:${marketDataHealth.score}`);
            }

            if (gateResult.verdict === 'BLOCK') {
                const isBadData = gateResult.reasons.some(r => r === 'snapshot-invalid' || r.startsWith('data:'));
                logger.info({
                    event: isBadData ? 'EXECUTION_BLOCKED_BAD_DATA' : 'EXECUTION_BLOCKED',
                    verdict: gateResult.verdict,
                    healthScore: gateResult.healthScore,
                    reasons: gateResult.reasons,
                    runtimeState: this.fsm.getState(),
                    timestamp: Date.now(),
                }, isBadData
                    ? 'EXECUTION_BLOCKED_BAD_DATA: gate denied tick — snapshot structural validation failed'
                    : 'EXECUTION_BLOCKED: gate denied tick execution');
                // Update cache even on BLOCK so API reflects latest state
                this.updateCacheSnapshot(pairKey, gateResult, null);
                return;
            }

            // Compute flow metrics from trade tape and order book
            const flowMetrics = computeFlowMetrics(this.tradeTape, orderBookState, this.baseConfig.flow);
            this.currentFlowMetrics = flowMetrics;

            // Update cache registry with full tick data
            this.updateCacheSnapshot(pairKey, gateResult, flowMetrics);

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
        if (!this.fsm.isHalted()) {
            this.fsm.forceHalt('kill');
        }
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

    /**
     * Get the centralized cache registry (the single source of truth for API routes).
     */
    getCacheRegistry(): RuntimeCacheRegistry {
        return this.cacheRegistry;
    }

    /**
     * Get the current pair key (e.g. "XRP/RLUSD").
     */
    getCurrentPairKey(): string {
        return `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
    }

    /**
     * Push latest tick data into the cache registry.
     */
    private updateCacheSnapshot(
        pairKey: string,
        gate: ExecutionGateResult,
        flow: FlowMetrics | null,
    ): void {
        const tapeData = this.tradeTape ? (() => {
            const trades = this.tradeTape!.getAll();
            const last = trades[trades.length - 1];
            return { trades, tradeCount: trades.length, lastTradeAtMs: last?.ts ?? null };
        })() : null;

        this.cacheRegistry.update({
            pairKey,
            sequence: this.marketSnapshotSequence,
            runtimeState: this.fsm.getState(),
            health: this.lastMarketDataHealth,
            gate,
            flow,
            tape: tapeData,
            orderbook: this.currentOrderBookSnapshot,
            lastTrade: this.currentNormalizedTrade,
        });
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

    // ─── Runtime FSM Getters ─────────────────────────────────────────────

    /**
     * Get the current runtime lifecycle FSM state.
     */
    getRuntimeState(): RuntimeState {
        return this.fsm.getState();
    }

    /**
     * Get a full FSM snapshot with transition history.
     */
    getRuntimeFSMSnapshot(): RuntimeFSMSnapshot {
        return this.fsm.getSnapshot();
    }

    /**
     * Whether the runtime FSM is in the READY state (execution allowed).
     */
    isRuntimeReady(): boolean {
        return this.fsm.isExecutionAllowed();
    }

    /**
     * Get aggregated telemetry snapshot for observability / API exposure.
     */
    getRuntimeTelemetry(): RuntimeTelemetry {
        return buildRuntimeTelemetry({
            fsmSnapshot: this.fsm.getSnapshot(),
            pairSwitchState: this.pairSwitchState,
            pairSwitchPhase: this.pairSwitchOrchestrator.getPhase(),
            isConnected: this.xrpl?.isConnected() ?? false,
            isReconnecting: this.xrpl?.isReconnecting() ?? false,
            feedStallState: this.feedStallRecovery?.getState() ?? null,
            ledgerIndex: this.xrpl?.getLedgerIndex() ?? 0,
            previousLedgerIndex: this.previousLedgerIndex,
            lastLedgerCloseMs: this.lastLedgerCloseMs,
            lastBalanceSnapshotMs: this.lastBalanceSnapshotMs,
            lastBalanceLedgerIndex: this.lastBalanceLedgerIndex,
            lastBookUpdateMs: this.lastBookUpdateMs,
            lastTapeUpdateMs: this.lastTapeUpdateMs,
            lastLedgerAdvanceMs: this.lastLedgerAdvanceMs,
            marketHealth: this.lastMarketDataHealth,
            executionGate: this.lastExecutionGateResult,
        });
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

        // FSM: transition to HALTED (from any operational state)
        if (!this.fsm.isHalted()) {
            this.fsm.forceHalt('graceful-shutdown');
        }

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

        // Reject if already switching (legacy FSM guard)
        if (this.pairSwitchState === 'SWITCHING' || this.pairSwitchState === 'SYNCING') {
            return { success: false, activePair: currentPairKey, error: 'Pair switch already in progress (legacy)' };
        }
        // If orchestrator is still running async warmup from previous switch,
        // force-reset it. The sync path already succeeded for the previous pair,
        // so it's safe to interrupt the async phases and start a new switch.
        if (!this.pairSwitchOrchestrator.isReady()) {
            logger.info({
                phase: this.pairSwitchOrchestrator.getPhase(),
                newPair: pairKey,
            }, 'Interrupting in-flight orchestrator for new pair switch');
            this.pairSwitchOrchestrator.reset();
        }

        if (!pairKey || !isValidPairKey(pairKey)) {
            return { success: false, activePair: currentPairKey, error: `Invalid pair key: ${pairKey}` };
        }

        const target = TRADING_PAIRS.find((p) => p.key === pairKey);
        if (!target) {
            return { success: false, activePair: currentPairKey, error: `Pair not found: ${pairKey}` };
        }

        // ─── Build the target TradingPair ────────────────────────────────
        const nextPair: TradingPair = {
            baseCurrency: target.base.currency,
            quoteCurrency: target.quote.currency,
            baseIssuer: target.base.issuer,
            quoteIssuer: target.quote.issuer,
            issuer: target.quote.issuer ?? target.base.issuer,
            description: target.description,
        };

        try {
            validateTradingPair(nextPair);
            assertAllowedPair(nextPair);
        } catch (err) {
            const error = err instanceof Error ? err.message : 'unknown error';
            return { success: false, activePair: currentPairKey, error };
        }

        // ─── Legacy FSM: IDLE → SWITCHING ────────────────────────────────
        this.pairSwitchState = 'SWITCHING';
        this.emitSwitchEvent('PAIR_SWITCH_START', pairKey, currentPairKey);

        const previousPair = { ...this.baseConfig.tradingPair };
        const previousPairKey = currentPairKey;

        // Build action callbacks for the orchestrator
        const actions: PairSwitchActions = {
            detachOldFeeds: (_oldPair: TradingPair) => {
                // XRPL streams are pair-agnostic (ledger + transactions).
                // Order book is polled per-tick with the current pair.
                // No actual unsubscribe needed — this is a conceptual detach.
                logger.debug({ pair: previousPairKey }, 'Feed detach: XRPL streams are pair-agnostic, no unsubscribe needed');
            },
            destroyPairContext: () => {
                // Clear trade tape buffer for old pair
                this.tradeTape?.setPair(previousPair); // triggers clear if pair changes
                // Reset order book tracker state
                this.tracker?.setPair(previousPair); // will be overwritten by applyNewPair
            },
            resetMetricsWindows: () => {
                this.invalidateMarketCaches();
                // Reset the first-tick flag so the runtime FSM can re-enter WARMING if needed
                // (not needed since FSM stays READY/DEGRADED — health gate handles warmup)
            },
            applyNewPair: (newPair: TradingPair) => {
                // 1. Config (single source of truth)
                this.baseConfig.tradingPair = { ...newPair };
                this.baseConfig.tradingPairs = [{ ...newPair }];

                // 2. Market data layer
                this.tradeTape?.setPair(newPair);
                this.tradeTapeService?.setPair(newPair);
                this.tracker?.setPair(newPair);

                // 3. Execution layer
                this.executor?.setPair(newPair);

                // 4. Strategy layer
                for (const strategy of this.strategies) {
                    if (typeof strategy.setPair === 'function') {
                        strategy.setPair(newPair);
                    }
                }
            },
            subscribeFeeds: async (_newPair: TradingPair) => {
                // XRPL streams don't need resubscription (pair-agnostic).
                // Just ensure the connection is alive.
                if (this.xrpl && !this.xrpl.isConnected()) {
                    await this.xrpl.connect();
                    await this.xrpl.subscribe(this.baseConfig.tradingPair);
                }
            },
            refreshOrderBook: async () => {
                if (!this.tracker) return false;
                await this.tracker.refresh();
                const state = this.tracker.getState();
                return state.bids.length > 0 || state.asks.length > 0;
            },
            hasTapeEvent: () => {
                const trades = this.tradeTape?.getAll() ?? [];
                return trades.length > 0;
            },
            refreshBalances: async () => {
                if (!this.walletAddress || !this.risk) return false;
                try {
                    const reservesOk = await this.risk.checkReserves(this.walletAddress);
                    this.lastBalanceSnapshotMs = Date.now();
                    this.lastBalanceLedgerIndex = this.xrpl?.getLedgerIndex() ?? 0;
                    return reservesOk;
                } catch {
                    return false;
                }
            },
            validateDataTruth: () => {
                // Quick validation: check order book is non-empty and connection is alive
                const bookState = this.tracker?.getState();
                const connected = this.xrpl?.isConnected() ?? false;
                const hasBook = (bookState?.bids.length ?? 0) > 0 || (bookState?.asks.length ?? 0) > 0;
                const reasons: string[] = [];
                if (!connected) reasons.push('xrpl-not-connected');
                if (!hasBook) reasons.push('empty-order-book');
                return { valid: reasons.length === 0, reasons };
            },
        };

        try {
            // Execute the 12-phase pair switch synchronously (non-async phases)
            // and asynchronously (subscribe, refresh, validate).
            // We run this synchronously to match existing behavior (setActivePair is sync).
            // The orchestrator drives the FSM through all phases.
            //
            // IMPORTANT: Since setActivePair() is synchronous in the current API contract,
            // we apply the pair synchronously first (for backward compat), then fire the
            // orchestrator asynchronously to drive through the remaining phases (book,
            // tape, balances, validation). Phases 1-5 are effectively done by the sync
            // path, so the orchestrator's action callbacks for those phases are no-ops.

            // Apply the new pair synchronously (equivalent to orchestrator phases 1-5)
            actions.applyNewPair(nextPair);
            this.emitSwitchEvent('PAIR_SWITCH_APPLY_COMPLETE', pairKey, previousPairKey);

            // ─── Legacy FSM: SWITCHING → SYNCING ─────────────────────────
            this.pairSwitchState = 'SYNCING';
            this.invalidateMarketCaches();
            this.emitSwitchEvent('PAIR_SWITCH_CACHES_INVALIDATED', pairKey, previousPairKey);

            // ─── Legacy FSM: SYNCING → IDLE ──────────────────────────────
            this.pairSwitchState = 'IDLE';

            // ─── 12-State Orchestrator: async phases ─────────────────────
            // Drive the orchestrator through all 12 phases asynchronously.
            // Execution is blocked by the orchestrator FSM guard in tick().
            //
            // Override sync-path callbacks with no-ops since the sync path
            // already applied them above. Only async phases (subscribe,
            // refreshOrderBook, hasTapeEvent, refreshBalances, validateDataTruth)
            // run real work inside the orchestrator.
            const orchestratorActions: PairSwitchActions = {
                ...actions,
                // Sync path already called these — make them no-ops in orchestrator
                detachOldFeeds: () => { },
                destroyPairContext: () => { },
                resetMetricsWindows: () => { },
                applyNewPair: () => { },
            };

            this.pairSwitchOrchestrator.executePairSwitch(previousPair, nextPair, orchestratorActions)
                .then((result) => {
                    if (result.success) {
                        this.emitSwitchEvent('PAIR_SWITCH_COMPLETE', pairKey, previousPairKey,
                            `orchestrator completed in ${result.durationMs}ms`);
                    } else {
                        // Orchestrator failed but sync path already succeeded —
                        // recover the orchestrator FSM to READY
                        this.pairSwitchOrchestrator.recoverFromFailure();
                        logger.warn({
                            error: result.error,
                            phases: result.phases,
                        }, 'Pair switch orchestrator reported failure but sync path succeeded — recovered');
                    }
                })
                .catch((err) => {
                    // Should not happen (executePairSwitch catches internally)
                    logger.error({ err }, 'Unexpected orchestrator error');
                    this.pairSwitchOrchestrator.recoverFromFailure();
                });

            return { success: true, activePair: this.getActivePair() };
        } catch (err) {
            // ─── Failure → rollback ──────────────────────────────────────
            this.pairSwitchState = 'FAILED';
            this.emitSwitchEvent('PAIR_SWITCH_FAILED', pairKey, previousPairKey,
                err instanceof Error ? err.message : 'unknown error');

            try {
                // Rollback: re-apply the previous pair
                actions.applyNewPair(previousPair);
            } catch (rollbackErr) {
                logger.error({ rollbackErr, pair: previousPairKey }, 'Rollback applyPair failed');
            }

            // Always invalidate caches after a failed switch attempt
            this.invalidateMarketCaches();

            this.pairSwitchState = 'IDLE';

            // Recover orchestrator FSM
            if (this.pairSwitchOrchestrator.isSwitching() || this.pairSwitchOrchestrator.fsm.isFailed()) {
                this.pairSwitchOrchestrator.fsm.fail('sync-rollback');
                this.pairSwitchOrchestrator.recoverFromFailure();
            }

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
        this.pairSwitchOrchestrator.reset();
        this.tradeTape = null;
        this.tradeTapeService = null;
        this.httpServer = null;
        this.capitalProtection = null;
        this.capitalProtectionConfig = null;
        this.lastGovernanceDecision = null;
        this.firstTickCompleted = false;

        // Reset feed stall recovery and health state
        this.feedStallRecovery?.reset();
        this.feedStallRecovery = null;
        this.lastMarketDataHealth = null;
        this.lastExecutionGateResult = null;
        this.lastLedgerCloseMs = 0;
        this.previousLedgerIndex = 0;
        this.lastBalanceSnapshotMs = 0;
        this.lastBalanceLedgerIndex = 0;
        this.lastBookUpdateMs = 0;
        this.lastTapeUpdateMs = 0;
        this.lastLedgerAdvanceMs = 0;
        this.listenersAttached = false;
        this.snapshotValidator.reset();
        this.lastDataValid = true;
        this.lastDataInvalidReasons = [];
        this.cacheRegistry.reset();

        // Reset FSM to BOOTING for potential restart
        this.fsm.reset();
    }

}
