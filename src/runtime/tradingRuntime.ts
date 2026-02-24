import { Wallet, isValidClassicAddress, Client, TransactionStream } from 'xrpl';
import crypto from 'crypto';
import { AppConfig, TradingPair, FlowConfig, loadConfig } from '../config';
import { isExecTelemetryEnabled } from '../config/featureFlags';
import { runtimeLog as logger } from '../analytics/logger';
import { sleep } from '../utils/sleep';
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
import { PerfTracer, getPerfTracer, stopPerfTracer } from '../monitoring/perfTracer';
import { TradeTape, setGlobalTradeTape } from '../market/tradeTape';
import { TradeTapeService } from '../market/tradeTapeService';
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
    tradeMarkoutScheduler,
    type MarkoutLifecycleEvent,
} from '../analytics/tradeMarkoutScheduler';
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
import type { RuntimeHeartbeatSnapshot, VolatilityStopCacheSnapshot } from './runtimeCacheRegistry';
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
import {
    ExecutionQualityCollector,
} from '../analytics/executionQuality';
import {
    HardRiskGuard,
    HardRiskInput,
    HardRiskPayload,
    loadHardRiskConfig,
} from '../risk/hardRiskGuard';
import { ExposureTracker, ExposureSnapshot } from '../risk/exposureTracker';
import { ObservabilityBus } from '../observability/eventBus';
import {
    StrategyApprovalEvent,
    StrategyDecisionFunnel,
    StrategyDecisionFunnelMap,
    StrategyEventContext,
    StrategySubmitTelemetryEvent,
    applySubmitTelemetryToFunnel,
    createStrategyDecisionFunnel,
    cloneStrategyDecisionFunnelMap,
} from '../observability/strategyDecisionFunnel';
import { EventLoopLagTracker, loadEventLoopLagConfig, type EventLoopLagState } from '../monitoring/eventLoopLag';
import { enforceSafetyPolicy } from '../security/safetyPolicy';
import { LiquidityIntelligence, LiquiditySnapshot, loadLiquidityConfig } from '../market/liquidityIntelligence';
import { ExecutionPairResolver, loadExecutionPairResolverConfig, resolveToNormalizedPair } from '../market/executionPairResolver';
import { AvailabilityScanner, loadAvailabilityScannerConfig, type AvailabilityScannerSnapshot, type PairAvailability } from '../market/availabilityScanner';
import { EntryGate, loadEntryGateConfig } from '../strategies/entryGate';
import { getInstruments, findInstrument, isValidPairKey } from '../market/instrumentRegistry';
import { SpreadDistributionSampler, type SpreadDistributionSnapshot } from '../analytics/spreadDistribution';
import { BackgroundMarketScanner } from '../market/backgroundScanner/backgroundMarketScanner';
import type { BackgroundScannerSnapshot } from '../market/backgroundScanner/types';
import { AccountTradeIngestionService } from '../analytics/accountTradeIngestion';
import { VolatilityEstimator, resolveAdaptiveStopLossBps } from '../market/volatilityEstimator';
import { initFirstRun } from './firstRunInit';

const cloneConfig = (cfg: AppConfig): AppConfig => ({
    xrpl: { ...cfg.xrpl },
    tradingPair: { ...cfg.tradingPair },
    tradingPairs: cfg.tradingPairs.map((p) => ({ ...p })),
    walletSeed: cfg.walletSeed,
    walletSecretNumbers: cfg.walletSecretNumbers,
    enableTestnetFaucet: cfg.enableTestnetFaucet,
    paperTrading: cfg.paperTrading,
    risk: { ...cfg.risk, issuerBlacklist: new Set(cfg.risk.issuerBlacklist) },
    strategy: {
        ...cfg.strategy,
        volatilityStop: cfg.strategy.volatilityStop ? { ...cfg.strategy.volatilityStop } : undefined,
    },
    flow: { ...cfg.flow },
    backgroundScanner: { ...cfg.backgroundScanner },
    analytics: { ...cfg.analytics },
    features: cfg.features ? { ...cfg.features } : undefined,
    historyMode: cfg.historyMode,
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
        const allowedKeys = getInstruments().map((p) => p.key).join(', ');
        throw new Error(
            `Trading pair "${pairKey}" is not allowed. Only these pairs are supported: ${allowedKeys}`
        );
    }
};

/**
 * @deprecated Use PairSwitchPhase from pairSwitchFsm.ts for the 12-state FSM.
 * Kept for backward compatibility with tests and external consumers.
 */
export type { PairSwitchState, PairSwitchEvent, PairSwitchResult, PairSwitchStatus } from './runtimeTypes';
import type { PairSwitchState, PairSwitchEvent, PairSwitchResult, PairSwitchStatus } from './runtimeTypes';

export class TradingRuntime {
    private xrpl: XRPLWebSocket | null = null;
    private tracker: OrderBookTracker | null = null;
    private risk: RiskEngine | null = null;
    private executor: OfferExecutor | null = null;
    private strategies: Strategy[] = [];
    private walletAddress: string | null = null;
    private tickInFlight = false;
    private tickHeartbeatCounter = 0;
    private heartbeatLastSubmitTs: number | null = null;
    private heartbeatLastValidatedTs: number | null = null;
    private heartbeatLastError: string | null = null;
    private started = false;
    private shutdownInProgress = false;
    /** @deprecated Legacy field — use pairSwitchOrchestrator.getPhase(). */
    private pairSwitchState: PairSwitchState = 'IDLE';
    /** 12-state pair-switch orchestrator with context isolation. */
    private readonly pairSwitchOrchestrator = new PairSwitchOrchestrator();
    private cpuWatchdog: CpuWatchdog | null = null;
    private tradeTape: TradeTape | null = null;
    private tradeTapeService: TradeTapeService | null = null;
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
    /** Edge-detection flag: true when balance staleness was detected on previous tick. */
    private lastBalanceStale = false;
    private feedStallRecovery: FeedStallRecovery | null = null;
    private lastMarketDataHealth: MarketHealthResult | null = null;
    private lastExecutionGateResult: ExecutionGateResult | null = null;
    private healthConfig: MarketHealthConfig = DEFAULT_HEALTH_CONFIG;
    private gateConfig: ExecutionGateConfig = DEFAULT_GATE_CONFIG;
    /** Structural snapshot validator — detects sequence gaps, timestamp regressions, NaN. */
    private snapshotValidator = new SnapshotValidator();
    /** Centralized pair-keyed cache — the single source of truth for API routes. */
    private readonly cacheRegistry = new RuntimeCacheRegistry();
    /** Execution quality analytics — per-fill tracing and aggregation. */
    private readonly executionQualityCollector = new ExecutionQualityCollector();
    /** Shared entry gate for consistent entry filtering across strategies. */
    private readonly entryGate = new EntryGate(loadEntryGateConfig());
    /** Hard risk guard — deterministic 7-condition capital safety gate. */
    private readonly hardRiskGuard = new HardRiskGuard(loadHardRiskConfig());
    /** Exposure tracker — lightweight position tracking from fills. */
    private readonly exposureTracker = new ExposureTracker();
    /** Observability event bus — structured event stream for forensic debugging. */
    private readonly observabilityBus = new ObservabilityBus();
    /** Per-strategy decision funnel counters (observability-only, no execution impact). */
    private strategyDecisionFunnels: StrategyDecisionFunnelMap = {};
    /** Liquidity intelligence engine — dynamic liquidity scoring per tick. */
    private liquidityIntelligence: LiquidityIntelligence | null = null;
    /** Spread distribution sampler — rolling percentiles for observability. */
    private readonly spreadDistributionSampler = new SpreadDistributionSampler();
    /** Execution pair resolver — centralized issuer resolution with caching. */
    private readonly pairResolver: ExecutionPairResolver;
    /** Cached XRPL-normalized pair key (hex-encoded currency codes) for feedback DB queries. */
    private resolvedPairKey: string | null = null;
    /** Availability scanner — periodic issuer/trustline/orderbook probes. */
    private availabilityScanner: AvailabilityScanner | null = null;
    /** Per-tick performance tracer — lightweight phase timing + event-loop lag. */
    private perfTracer: PerfTracer | null = null;
    /** Event loop lag tracker — infra safety auto-pause. */
    private eventLoopLagTracker: EventLoopLagTracker | null = null;
    /** Background scanner — best-effort cross-market intelligence. */
    private backgroundScanner: BackgroundMarketScanner | null = null;
    /** Account-level fill ingester for bot + manual wallet activity. */
    private accountTradeIngestion: AccountTradeIngestionService | null = null;
    /** Edge-detection flag for scanner degraded/recovered observability. */
    private scannerWasDegraded = false;
    /** Per-pair EWMA volatility estimator for optional adaptive stop-loss sizing. */
    private readonly volatilityEstimator: VolatilityEstimator;
    /** Latest volatility-adaptive stop snapshot for strategy context + API visibility. */
    private currentVolatilityStop: VolatilityStopCacheSnapshot | null = null;
    /** Edge-detection flag: emit VOL_STOP_READY once per pair session. */
    private volatilityStopReadyEmitted = false;
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
    // ── Stored handler references for symmetric .off() cleanup ──
    private onXrplLedger: (() => void) | null = null;
    private onXrplTransaction: ((tx: TransactionStream) => void) | null = null;
    private onXrplReconnect: (() => void) | null = null;
    private onUnderlyingDisconnected: (() => void) | null = null;
    private underlyingClientRef: Client | null = null;
    // ── Pair-switch pending state (PR2: readiness truth) ──
    private pairSwitchPending = false;
    private pairSwitchSwitchId: string | null = null;
    private pairSwitchTargetPairKey: string | null = null;
    private pairSwitchLastError: string | null = null;

    constructor(config?: AppConfig) {
        // Security gate: enforce local-only execution on construction
        try {
            enforceLocalOnly('TradingRuntime');
        } catch (err) {
            logger.error({ err }, 'Local-only security check failed');
            throw err;
        }

        this.baseConfig = config ?? loadConfig();
        const volatilityEstimatorConfig = {
            ...(Number.isFinite(this.baseConfig.strategy.volatilityStop?.alpha)
                ? { alpha: this.baseConfig.strategy.volatilityStop!.alpha }
                : {}),
            ...(Number.isFinite(this.baseConfig.strategy.volatilityStop?.warmupMs)
                ? { warmupMs: this.baseConfig.strategy.volatilityStop!.warmupMs }
                : {}),
            ...(Number.isFinite(this.baseConfig.strategy.volatilityStop?.minSamples)
                ? { minSamples: this.baseConfig.strategy.volatilityStop!.minSamples }
                : {}),
        };
        this.volatilityEstimator = new VolatilityEstimator(volatilityEstimatorConfig);
        this.currentVolatilityStop = this.buildVolatilityStopSnapshot(Date.now());
        this.fsm = new RuntimeFSM();
        this.pairResolver = new ExecutionPairResolver(loadExecutionPairResolverConfig());
        this.spreadDistributionSampler.setPairKey(this.getActivePair());

        // Wire resolver cache miss → observability bus
        this.pairResolver.setOnCacheMiss((pairKey, reason) => {
            this.observabilityBus.emitResolverCacheMiss({
                pairKey,
                runtimeState: this.fsm.getState(),
                reason,
            });
        });
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
     * Get the full pair-switch status including async pending state.
     * This is the source of truth for whether a pair switch is truly complete.
     */
    getPairSwitchStatus(): PairSwitchStatus {
        return {
            activePair: this.getActivePair(),
            pending: this.pairSwitchPending,
            switchId: this.pairSwitchSwitchId,
            targetPairKey: this.pairSwitchTargetPairKey,
            lastError: this.pairSwitchLastError,
            legacyState: this.pairSwitchState,
            orchestratorPhase: this.pairSwitchOrchestrator.getPhase(),
            orchestratorReady: this.pairSwitchOrchestrator.isReady(),
        };
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
        this.lastBalanceStale = false;
        // Reset health state from previous pair
        this.lastMarketDataHealth = null;
        this.lastExecutionGateResult = null;
        this.exposureTracker.reset();
        // Reset liquidity intelligence for new pair
        this.liquidityIntelligence?.reset();
        // Reset spread distribution sampling for new pair
        this.spreadDistributionSampler.reset();
        this.spreadDistributionSampler.setPairKey(this.getActivePair());
        // Reset volatility estimator for the new pair (warmup restarts).
        this.volatilityEstimator.reset(Date.now());
        this.currentVolatilityStop = this.buildVolatilityStopSnapshot(Date.now());
        this.volatilityStopReadyEmitted = false;
        // Invalidate pair resolver cache to force re-resolution for new pair
        this.pairResolver.invalidate();
        this.strategyDecisionFunnels = {};
        for (const strategy of this.strategies) {
            this.ensureStrategyFunnel(strategy.name);
        }
        this.syncStrategyFunnelToCache(this.getActivePair());
    }

    async start(): Promise<void> {
        // First-run initialization: ensure data dir, detect clean state, set boot timestamp
        initFirstRun();

        // Security gate: re-check on start
        enforceLocalOnly('TradingRuntime.start');

        // Safety policy enforcement — blocks dangerous configurations
        enforceSafetyPolicy();

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
            const accountTradeIngestion = new AccountTradeIngestionService(
                config.tradingPair,
                wallet?.classicAddress ?? null,
            );

            // Set global reference for API routes
            setGlobalTradeTape(tradeTape);

            this.tradeTape = tradeTape;
            this.tradeTapeService = tradeTapeService;
            this.accountTradeIngestion = accountTradeIngestion;

            // ── Listener dedup guard ─────────────────────────────────────
            // Prevents stacking duplicate event listeners if start() is
            // somehow called again after a reset()/restart cycle.
            if (!this.listenersAttached) {
                // Detach any stale listeners (defensive — should be no-op on fresh start)
                this.detachRuntimeListeners();

                let txCount = 0;

                // Create handler references (stored for symmetric .off() in reset/shutdown)
                this.onXrplLedger = () => {
                    this.lastLedgerCloseMs = Date.now();
                    this.lastLedgerAdvanceMs = Date.now();
                    this.previousLedgerIndex = this.xrpl?.getLedgerIndex() ?? 0;
                };

                this.onXrplTransaction = (tx: TransactionStream) => {
                    txCount += 1;
                    this.lastTapeUpdateMs = Date.now();
                    if (txCount % 5000 === 0) {
                        logger.info({ txCount, lastTxType: tx.transaction?.TransactionType }, 'TradeTape: Transaction stream active');
                    }
                    this.tradeTapeService?.processTransaction(tx);
                    this.accountTradeIngestion?.processTransaction(tx);
                    // Inform stall recovery that the tape feed is alive
                    this.feedStallRecovery?.recordTapeEvent();
                };

                // Emit XRPL_RECONNECTED observability event on WebSocket reconnect
                this.onXrplReconnect = () => {
                    logger.info({ event: 'XRPL_RECONNECTED', timestamp: Date.now() }, 'XRPL WebSocket reconnected');
                    const rPairKey = `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
                    this.observabilityBus.emitXrplReconnected({
                        pairKey: rPairKey,
                        runtimeState: this.fsm.getState(),
                    });
                };

                xrpl.on('ledger', this.onXrplLedger);
                xrpl.on('transaction', this.onXrplTransaction);
                xrpl.on('reconnect', this.onXrplReconnect);

                // Emit XRPL_DISCONNECTED observability event via underlying client
                const underlyingClient = xrpl.getClient();
                this.underlyingClientRef = underlyingClient;
                this.onUnderlyingDisconnected = () => {
                    const dPairKey = `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
                    this.observabilityBus.emitXrplDisconnected({
                        pairKey: dPairKey,
                        runtimeState: this.fsm.getState(),
                    });
                };
                underlyingClient.on('disconnected', this.onUnderlyingDisconnected);

                this.listenersAttached = true;
            }

            this.strategies = [
                new ScalperStrategy(tracker, config.strategy, config.tradingPair, executor, risk, config.flow),
                new AMMArbitrageStrategy(amm, config.strategy, config.tradingPair, executor, risk, config.flow),
                new PathArbitrageStrategy(client, config.strategy, config.tradingPair, executor, config.paperTrading, risk, config.flow),
            ];
            this.strategyDecisionFunnels = {};
            for (const strategy of this.strategies) {
                this.ensureStrategyFunnel(strategy.name);
            }
            this.syncStrategyFunnelToCache(this.getActivePair());

            this.xrpl = xrpl;
            this.tracker = tracker;
            this.risk = risk;
            this.executor = executor;
            executor.setExecutionQualityCollector(this.executionQualityCollector);
            executor.setExposureTracker(this.exposureTracker);
            executor.setBotTxHashSink((hash) => this.accountTradeIngestion?.registerBotTxHash(hash));
            executor.setSubmitTelemetrySink((event) => this.recordSubmitTelemetry(event));
            executor.setTradeToastEmitter((event) => {
                const eventTsMs = Date.parse(event.timestamp);
                this.observabilityBus.emit({
                    eventType: event.type,
                    pairKey: event.pair,
                    runtimeState: this.fsm.getState(),
                    correlationId: event.correlationId ?? null,
                    detail: {
                        type: event.type,
                        side: event.side ?? null,
                        pair: event.pair,
                        baseCurrency: event.baseCurrency,
                        quoteCurrency: event.quoteCurrency,
                        baseAmount: event.baseAmount,
                        quoteAmount: event.quoteAmount,
                        price: event.price,
                        feeQuote: event.feeQuote,
                        pnlQuote: event.pnlQuote,
                        timestamp: event.timestamp,
                        timestamp_ms: Number.isFinite(eventTsMs) ? eventTsMs : Date.now(),
                        filled_base: event.baseAmount ?? null,
                        filled_quote: event.quoteAmount ?? null,
                        avg_price: event.price ?? null,
                        fill_ts_ms: Number.isFinite(eventTsMs) ? eventTsMs : null,
                        correlation_id: event.correlationId ?? null,
                        pair_key: event.pair,
                        base_currency: event.baseCurrency,
                        quote_currency: event.quoteCurrency,
                        base_amount: event.baseAmount ?? null,
                        quote_amount: event.quoteAmount ?? null,
                        fee_quote: event.feeQuote ?? null,
                        pnl_quote: event.pnlQuote ?? null,
                    },
                });
            });
            tradeMarkoutScheduler.setHooks({
                emit_event: (event) => this.emitMarkoutLifecycleEvent(event),
            });
            tradeMarkoutScheduler.start();
            // Wire exposure tracker into risk engine so risk checks can
            // account for current notional exposure.
            try {
                risk.setExposureTracker(this.exposureTracker);
            } catch { /* best-effort */ }
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
                    // Stage 2: force endpoint rotation to escape zombie connections.
                    // The previous approach only detached handlers and re-connected
                    // via getXrplClient(), which returned the SAME broken connection
                    // if isConnected() still reported true.
                    logger.info('Feed stall recovery: hard resubscribe — rotating endpoint');
                    await this.xrpl?.disconnect();
                    const { rotateEndpoint: rotate } = await import('../xrpl/sharedClient');
                    await rotate();
                    await this.xrpl?.connect();
                    await this.xrpl?.subscribe(this.baseConfig.tradingPair);
                },
                fullClientRebuild: async () => {
                    // Stage 3: full tear-down with endpoint rotation.
                    logger.warn('Feed stall recovery: full client rebuild — rotating endpoint');
                    await this.xrpl?.disconnect();
                    const { disconnectXrplClient, rotateEndpoint: rotate } = await import('../xrpl/sharedClient');
                    await disconnectXrplClient();
                    await rotate();
                    await this.xrpl?.connect();
                    await this.xrpl?.subscribe(this.baseConfig.tradingPair);
                },
            });

            // Start CPU watchdog to prevent runaway CPU usage
            this.cpuWatchdog = startCpuWatchdog(() => {
                logger.warn('CPU watchdog triggered - trading paused due to high CPU');
            });

            // Start event loop lag tracker for infra safety auto-pause
            const lagConfig = loadEventLoopLagConfig();
            this.eventLoopLagTracker = new EventLoopLagTracker(lagConfig);
            this.eventLoopLagTracker.start();

            // Initialize liquidity intelligence engine
            const liqConfig = loadLiquidityConfig();
            this.liquidityIntelligence = new LiquidityIntelligence(liqConfig);
            logger.info('Liquidity intelligence engine initialized');

            // Initialize availability scanner with all registered instruments
            const scannerConfig = loadAvailabilityScannerConfig();
            this.availabilityScanner = new AvailabilityScanner(scannerConfig);
            this.availabilityScanner.setWalletAddress(this.walletAddress);
            const instruments = getInstruments();
            for (const inst of instruments) {
                this.availabilityScanner.addPair(
                    inst.key,
                    { currency: inst.base.currency, issuer: inst.base.issuer },
                    { currency: inst.quote.currency, issuer: inst.quote.issuer },
                );
            }
            logger.info({ pairCount: instruments.length }, 'Availability scanner initialized');

            // Start adaptive learning scheduler
            const pairKey = `${config.tradingPair.baseCurrency}/${config.tradingPair.quoteCurrency}`;
            this.executionQualityCollector.setPairKey(pairKey);
            this.hardRiskGuard.setPairKey(pairKey);
            this.exposureTracker.setPairKey(pairKey);
            this.exposureTracker.setMaxPositionBase(config.strategy.positionSize * 20);
            const strategyNames = this.strategies.map(s => s.name);
            startAdaptiveScheduler({
                pairKeys: [pairKey],
                strategies: strategyNames,
            });

            // Start lightweight per-tick performance tracer
            this.perfTracer = getPerfTracer();
            this.perfTracer.start();

            // Start background market scanner (best-effort, never blocks tick loop)
            if (config.backgroundScanner.enabled && this.xrpl?.isConnected()) {
                const scannerClient = this.xrpl.getClient();
                this.backgroundScanner = new BackgroundMarketScanner({
                    client: scannerClient,
                    getCurrentPairKey: () => this.getCurrentPairKey(),
                    getCurrentMidPrice: () => this.getActivePairMidPrice(),
                    getAvailabilitySnapshot: () => this.availabilityScanner?.getSnapshot() ?? null,
                    isPaused: () => (this.eventLoopLagTracker?.isAutoPaused() ?? false) || !isCpuHealthy(),
                    onSnapshot: (pairKey: string, snapshot: BackgroundScannerSnapshot) => {
                        this.handleBackgroundScannerSnapshot(pairKey, snapshot);
                    },
                }, {
                    enabled: config.backgroundScanner.enabled,
                    maxMarkets: config.backgroundScanner.maxMarkets,
                    maxRps: config.backgroundScanner.maxRps,
                    tier1IntervalMs: config.backgroundScanner.tier1IntervalMs,
                    tier2IntervalMs: config.backgroundScanner.tier2IntervalMs,
                    maxStalenessMs: config.backgroundScanner.maxStalenessMs,
                    discoveryEnabled: config.features?.xrplDiscoveryEnabled ?? false,
                    discoveryMinLiquidityUsd: config.xrpl.minLiquidityUsd ?? 50_000,
                    discoveryMinVolumeUsd: config.xrpl.minVolumeUsd ?? 10_000,
                });
                this.backgroundScanner.start();
            }

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

        // If XRPL client is disconnected, attempt to re-establish before skipping.
        // The previous "just skip" approach could leave the bot idle indefinitely
        // if auto-reconnect failed and no other code path triggered establish().
        if (!this.xrpl.isConnected()) {
            logger.info('XRPL client disconnected — attempting re-establish before skipping tick');
            try {
                await this.xrpl.connect();
            } catch (err) {
                logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'XRPL re-establish failed, skipping tick');
            }
            if (!this.xrpl.isConnected()) {
                return;
            }
        }

        // CPU safety: skip tick if CPU is overloaded
        if (!isCpuHealthy()) {
            logger.debug('Skipping tick - CPU watchdog paused trading');
            return;
        }

        // Event loop lag safety: skip tick if event loop is overloaded
        if (this.eventLoopLagTracker?.isAutoPaused()) {
            logger.debug('Skipping tick - event loop lag auto-pause active');
            return;
        }

        this.tickInFlight = true;
        const tickId = ++this.tickHeartbeatCounter;
        this.writeTickHeartbeat(tickId, true, this.heartbeatLastError);
        let tickError: unknown = null;
        try {
            // Re-check after acquiring tickInFlight lock (state may have changed)
            if (!this.tracker || !this.risk || !this.xrpl) {
                return;
            }

            // ── PERF: start tick timing ──
            this.perfTracer?.tickStart();

            // Check for daily loss reset at UTC midnight
            this.risk.checkAndResetDaily();

            this.perfTracer?.phaseEnd(0); // riskReset

            if (this.risk.isShutdown()) return;
            if (this.walletAddress) {
                const reservesOk = await this.risk.checkReserves(this.walletAddress);
                if (!reservesOk) return;
                // Track balance snapshot freshness for health scoring
                this.lastBalanceSnapshotMs = Date.now();
                this.lastBalanceLedgerIndex = this.xrpl?.getLedgerIndex() ?? 0;

                // Edge-detect: balance was stale, now refreshed
                if (this.lastBalanceStale) {
                    this.lastBalanceStale = false;
                    const balPairKey = `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
                    this.observabilityBus.emitBalanceRefreshed({
                        pairKey: balPairKey,
                        runtimeState: this.fsm.getState(),
                        stalenessMs: 0,
                        nowMs: this.lastBalanceSnapshotMs,
                    });
                }
            }
            this.perfTracer?.phaseEnd(1); // reserveCheck

            const bookRefreshOk = await this.tracker.refresh();
            if (bookRefreshOk) {
                this.lastBookUpdateMs = Date.now();
                // Feed-stall recovery should only treat successful book_offers refreshes
                // as book liveness, not generic websocket ledger traffic.
                this.feedStallRecovery?.recordBookEvent(this.lastBookUpdateMs);
            }
            this.perfTracer?.phaseEnd(2); // bookRefresh

            // Final null check before accessing state (may have been killed during refresh)
            if (!this.tracker || !this.xrpl) {
                return;
            }

            // Build strategy context with trade tape data
            const orderBookState = this.tracker.getState();
            const pairKey = `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
            const nowMs = Date.now();
            this.marketSnapshotSequence += 1;

            const bestBid = orderBookState.bids[0]?.price ?? 0;
            const bestAsk = orderBookState.asks[0]?.price ?? 0;
            this.updateVolatilityStopState(pairKey, nowMs, bestBid, bestAsk);
            this.spreadDistributionSampler.ingest(bestBid, bestAsk, nowMs);
            const spreadDistribution = this.spreadDistributionSampler.maybeCompute(nowMs);

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
                this.observabilityBus.emitDataInvalidated({
                    pairKey,
                    runtimeState: this.fsm.getState(),
                    reasons: validation.reasons,
                    sequence: this.currentOrderBookSnapshot.sequence,
                    nowMs,
                });
            }
            if (validation.valid && wasInvalid) {
                logger.info({
                    event: 'DATA_RECOVERED',
                    sequence: this.currentOrderBookSnapshot.sequence,
                    pairKey,
                    timestamp: nowMs,
                }, 'DATA_RECOVERED: snapshot validation passed after previous failure');
            }

            const latestTrade = this.tradeTape?.getLast() ?? null;
            this.currentNormalizedTrade = latestTrade
                ? normalizeTrade(latestTrade, nowMs, latestTrade.ts, 'tape', false)
                : null;

            this.currentMarketHealthScore = computeMarketHealth({
                trade: this.currentNormalizedTrade,
                book: this.currentOrderBookSnapshot,
                amm: null,
            });

            this.perfTracer?.phaseEnd(3); // snapshot (includes bookRefresh[2]+normalize+validate)

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
                    this.observabilityBus.emitFeedStale({
                        pairKey,
                        runtimeState: this.fsm.getState(),
                        stage: stallState?.stage ?? 'UNKNOWN',
                    });
                    logger.info({
                        event: 'RECOVERY_STAGE',
                        from: this.fsm.getState(),
                        to: 'RECOVERING',
                        stage: stallState?.stage ?? 'UNKNOWN',
                        timestamp: Date.now(),
                    }, 'RECOVERY_STAGE: entering RECOVERING state');
                    const fsmFromState = this.fsm.getState();
                    this.fsm.transition('RECOVERING', 'feed-stall-recovery-started');
                    this.observabilityBus.emitFsmTransition({
                        from: fsmFromState,
                        to: 'RECOVERING',
                        reason: 'feed-stall-recovery-started',
                        pairKey,
                    });
                }
                // FSM: transition out of RECOVERING when stall recovery completes
                if (stallStateBefore && !stallStateAfter && this.fsm.getState() === 'RECOVERING') {
                    logger.info({
                        event: 'RECOVERY_STAGE',
                        from: 'RECOVERING',
                        to: 'DEGRADED',
                        timestamp: Date.now(),
                    }, 'RECOVERY_STAGE: stall recovery completed, transitioning to DEGRADED');
                    this.observabilityBus.emitFeedRecovered({
                        pairKey,
                        runtimeState: 'DEGRADED',
                    });
                    // Will determine READY vs DEGRADED after health scoring below
                    // For now go to DEGRADED; health check may promote to READY
                    this.fsm.transition('DEGRADED', 'feed-stall-recovery-completed');
                }
            }

            this.perfTracer?.phaseEnd(4); // feedStall

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
                lastBalanceSnapshotMs: this.lastBalanceSnapshotMs,
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
                    this.observabilityBus.emitFsmTransition({ from: 'WARMING_MARKET_CACHE', to: 'READY', reason: 'first-tick-healthy', pairKey });
                } else {
                    this.fsm.transition('DEGRADED', 'first-tick-unhealthy');
                    this.observabilityBus.emitFsmTransition({ from: 'WARMING_MARKET_CACHE', to: 'DEGRADED', reason: 'first-tick-unhealthy', pairKey });
                }
            } else if (currentFsmState === 'READY' && !marketDataHealth.healthy) {
                // Health dropped below threshold
                const reason = `health-degraded:${marketDataHealth.score}`;
                this.fsm.transition('DEGRADED', reason);
                this.observabilityBus.emitFsmTransition({ from: 'READY', to: 'DEGRADED', reason, pairKey });
            } else if (currentFsmState === 'DEGRADED' && marketDataHealth.healthy &&
                !(this.feedStallRecovery?.isRecovering())) {
                // Health recovered and no stall recovery in progress
                const reason = `health-recovered:${marketDataHealth.score}`;
                this.fsm.transition('READY', reason);
                this.observabilityBus.emitFsmTransition({ from: 'DEGRADED', to: 'READY', reason, pairKey });
            }

            // Emit edge-detected EXECUTION_BLOCKED / EXECUTION_ALLOWED events
            this.observabilityBus.evaluateGateVerdict({
                blocked: gateResult.verdict === 'BLOCK',
                reasons: gateResult.reasons,
                healthScore: gateResult.healthScore,
                pairKey,
                runtimeState: this.fsm.getState(),
                nowMs,
            });

            // Edge-detect: balance staleness from gate reasons
            const isBalanceStale = gateResult.reasons.some(r => r.startsWith('balance-stale:'));
            if (isBalanceStale && !this.lastBalanceStale) {
                this.lastBalanceStale = true;
                const balanceAge = nowMs - (this.lastBalanceSnapshotMs || nowMs);
                this.observabilityBus.emitBalanceStale({
                    pairKey,
                    runtimeState: this.fsm.getState(),
                    stalenessMs: balanceAge,
                    lastRefreshMs: this.lastBalanceSnapshotMs,
                    nowMs,
                });
            }

            this.perfTracer?.phaseEnd(5); // healthQuorum (includes gate + FSM)
            this.perfTracer?.phaseEnd(6); // fsmTransitions

            // ─────────────────────────────────────────────────────────────────
            // Flow metrics + analytics snapshot — run BEFORE the execution gate
            // so that observational data (adverse selection, regime, etc.) is
            // always recorded regardless of whether trading is allowed.
            // ─────────────────────────────────────────────────────────────────
            const flowMetrics = computeFlowMetrics(this.tradeTape, orderBookState, this.baseConfig.flow);
            this.currentFlowMetrics = flowMetrics;
            this.perfTracer?.phaseEnd(7); // flowMetrics

            // Record market snapshot for analytics (non-blocking, best-effort).
            // This feeds the adverse-selection panel and regime analytics.
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
            this.perfTracer?.phaseEnd(9); // feedbackRecord

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
                this.updateCacheSnapshot(pairKey, gateResult, flowMetrics, spreadDistribution);
                return;
            }

            this.entryGate.ingestTick(orderBookState, flowMetrics);

            if (this.executor) {
                const bestBid = orderBookState.bids[0]?.price ?? 0;
                const bestAsk = orderBookState.asks[0]?.price ?? 0;
                const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0);
                this.executor.setCurrentMarketContext({
                    midPrice: midPrice > 0 ? midPrice : null,
                    bestBid: bestBid > 0 ? bestBid : null,
                    bestAsk: bestAsk > 0 ? bestAsk : null,
                    spreadBps: Number.isFinite(orderBookState.spread) ? orderBookState.spread : null,
                    bookAgeMs: Number.isFinite(orderBookState.lastUpdated)
                        ? Math.max(0, nowMs - orderBookState.lastUpdated)
                        : null,
                    flowCombined: flowMetrics.combinedSignal,
                    flowStrength: flowMetrics.signalStrength,
                    flowRegime: flowMetrics.regime,
                    localExtreme: this.entryGate.isLocalExtreme(),
                });
            }

            // Compute liquidity intelligence
            const allTrades = this.tradeTape?.getAll() ?? [];
            this.liquidityIntelligence?.ingestTick(orderBookState, allTrades, nowMs);

            // Run availability scanner if interval has elapsed (non-blocking, best-effort)
            if (this.availabilityScanner?.needsScan() && this.xrpl?.isConnected()) {
                const scanClient = this.xrpl.getClient();
                const scanStartMs = Date.now();
                this.availabilityScanner.scanAll(scanClient)
                    .then(() => {
                        const snapshot = this.availabilityScanner?.getSnapshot();
                        if (snapshot) {
                            this.observabilityBus.emitAvailabilityScanComplete({
                                pairKey,
                                runtimeState: this.fsm.getState(),
                                pairsScanned: snapshot.pairs.length,
                                pairsAvailable: snapshot.pairs.filter(p => p.verdict === 'AVAILABLE').length,
                                durationMs: Date.now() - scanStartMs,
                            });
                        }
                    })
                    .catch((err) => {
                        logger.warn({ err }, 'Availability scanner background scan failed');
                    });
            }

            // Update cache registry with full tick data
            this.updateCacheSnapshot(pairKey, gateResult, flowMetrics, spreadDistribution);

            this.perfTracer?.phaseEnd(8); // cacheUpdate

            // (Snapshot recording moved before execution gate — see above)

            // ─────────────────────────────────────────────────────────────────
            // Hard Risk Guard — deterministic capital safety gate
            // ─────────────────────────────────────────────────────────────────
            // Update exposure tracker with latest mid-price
            const tickMid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
            if (tickMid > 0) this.exposureTracker.updateMidPrice(tickMid);

            const governanceMetrics = this.lastGovernanceDecision?.metrics;
            const hardRiskInput: HardRiskInput = {
                currentExposureNotional: this.exposureTracker.getNotionalExposure(),
                inventorySkewPct: this.exposureTracker.getInventorySkewPct(),
                drawdownPct: governanceMetrics?.drawdownPct ?? 0,
                tradesCount: governanceMetrics?.tradesCount ?? 0,
                peakEquity: governanceMetrics?.peakEquity ?? 0,
                equityNow: governanceMetrics?.equityNow ?? 0,
                drawdownConfidence: governanceMetrics?.drawdownConfidence ?? false,
                runtimeReady: this.fsm.getState() === 'READY',
                marketDataValid: this.lastDataValid,
                balanceStalenessMs: nowMs - (this.lastBalanceSnapshotMs || nowMs),
                feedHealthScore: marketDataHealth.score,
            };
            const hardRiskResult = this.hardRiskGuard.evaluate(hardRiskInput);
            if (!hardRiskResult.executionAllowed) {
                logger.info({
                    event: 'HARD_RISK_BLOCK',
                    riskState: hardRiskResult.riskState,
                    reasons: hardRiskResult.riskBlockReasons,
                    metrics: hardRiskResult.metrics,
                    pairKey,
                    timestamp: nowMs,
                }, 'HARD_RISK_BLOCK: execution blocked by hard risk guard');
                this.observabilityBus.emitRiskBlock({
                    pairKey,
                    runtimeState: this.fsm.getState(),
                    reasons: hardRiskResult.riskBlockReasons,
                    riskState: hardRiskResult.riskState,
                    nowMs,
                });
                return;
            }

            this.perfTracer?.phaseEnd(10); // hardRisk

            // ─────────────────────────────────────────────────────────────────
            // Capital Protection Gate
            // ─────────────────────────────────────────────────────────────────
            let governanceDecision: CapitalProtectionDecision | undefined;
            let globalSizeMultiplier = 1.0;
            let globalCooldownMs = 0;

            if (this.capitalProtection) {
                // Use XRPL-normalized pair key (hex currency codes) to match
                // what OfferExecutor records in the feedback DB.
                const feedbackPairKey = this.getResolvedPairKey();
                governanceDecision = this.capitalProtection.evaluate(feedbackPairKey);
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
                    await sleep(globalCooldownMs);
                }
            }

            this.perfTracer?.phaseEnd(11); // capitalProtection

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
                entryGate: this.entryGate,
                volatilityStop: this.currentVolatilityStop ?? undefined,
                // regimePolicy will be set per-strategy below
            };

            const regime: FlowRegime = flowMetrics.regime;

            // Get current regime policy (cached, fast)
            const regimePolicy = this.regimePolicyEngine?.getCurrentPolicy() ?? null;

            for (const strategy of this.strategies) {
                // Rate limit strategy execution to prevent CPU spikes
                await throttleStrategy();

                const strategyEventContext: StrategyEventContext = {
                    pairKey,
                    regime,
                    spreadBps: Number.isFinite(orderBookState.spread) ? orderBookState.spread : null,
                    healthScore: Number.isFinite(gateResult.healthScore) ? gateResult.healthScore : null,
                    fsmState: this.fsm.getState(),
                };
                this.recordStrategyTick(strategy.name, pairKey);

                // Ensure fill/reject analytics are attributed to the strategy
                // currently being evaluated in this tick.
                if (this.executor) {
                    this.executor.setCurrentStrategy(strategy.name);
                }

                // Check if strategy is disabled by governance
                if (governanceDecision?.disabledStrategies?.includes(strategy.name)) {
                    logger.debug({
                        strategy: strategy.name,
                        reasons: governanceDecision.reasons,
                    }, 'Skipping strategy - disabled by capital protection');
                    this.recordStrategyRejected(
                        strategy.name,
                        // Keep bucket names strategy-local and stable.
                        'healthNotOk',
                        strategyEventContext,
                        {
                            reason: 'governance-strategy-disabled',
                            reasons: governanceDecision.reasons,
                        },
                    );
                    continue;
                }

                // Check if regime is disabled by governance (capital protection)
                if (governanceDecision?.disabledRegimes?.includes(regime)) {
                    logger.debug({
                        strategy: strategy.name,
                        regime,
                        reasons: governanceDecision.reasons,
                    }, 'Skipping strategy - regime disabled by capital protection');
                    this.recordStrategyRejected(
                        strategy.name,
                        'regimeNotAllowed',
                        strategyEventContext,
                        {
                            reason: 'governance-regime-disabled',
                            reasons: governanceDecision.reasons,
                            regime,
                        },
                    );
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
                        this.recordStrategyRejected(
                            strategy.name,
                            'regimeNotAllowed',
                            strategyEventContext,
                            {
                                reason: 'regime-policy-disabled',
                                regime,
                                isRegimeDisabledGlobal,
                                isRegimeDisabledStrategy,
                            },
                        );
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
                        this.recordStrategyRejected(
                            strategy.name,
                            'regimeNotAllowed',
                            strategyEventContext,
                            { reason: 'adaptive-regime-disabled', regime },
                        );
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
                            await sleep(tuning.coolDownMs);
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
                    pairKey,
                    runtimeState: this.fsm.getState(),
                    healthScore: gateResult.healthScore,
                    strategyFunnel: this.buildStrategyFunnelRecorder(strategy.name, strategyEventContext),
                };

                await strategy.tick(strategyCtx);

                // Clear overrides after each strategy to avoid cross-contamination
                if (this.executor) {
                    this.executor.clearAdaptiveOverrides();
                    this.executor.clearGovernanceOverrides();
                    this.executor.clearRegimePolicyOverrides();
                }
            }
            this.perfTracer?.phaseEnd(12); // strategies
        } catch (err) {
            tickError = err;
            throw err;
        } finally {
            this.perfTracer?.tickEnd();
            this.tickInFlight = false;
            this.writeTickHeartbeat(
                tickId,
                false,
                tickError != null ? this.sanitizeTickError(tickError) : null,
            );
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
     * Get the execution quality analytics collector.
     */
    getExecutionQualityCollector(): ExecutionQualityCollector {
        return this.executionQualityCollector;
    }

    /**
     * Get the hard risk guard (for API routes / observability).
     */
    getHardRiskGuard(): HardRiskGuard {
        return this.hardRiskGuard;
    }

    /**
     * Get the current exposure snapshot (for API routes / risk display).
     */
    getExposureSnapshot(): ExposureSnapshot {
        return this.exposureTracker.getSnapshot();
    }

    /**
     * Get the hard risk payload for API endpoint.
     */
    getHardRiskPayload(): HardRiskPayload {
        return this.hardRiskGuard.getPayload();
    }

    /**
     * Get the observability event bus (for API routes / forensic replay).
     */
    getObservabilityBus(): ObservabilityBus {
        return this.observabilityBus;
    }

    /**
     * Get the current liquidity intelligence snapshot (for API routes).
     */
    getLiquiditySnapshot(): LiquiditySnapshot | null {
        return this.liquidityIntelligence?.getSnapshot() ?? null;
    }

    /**
     * Get the execution pair resolver (for API routes / diagnostics).
     */
    getPairResolver(): ExecutionPairResolver {
        return this.pairResolver;
    }

    /**
     * Get the availability scanner snapshot (for API routes).
     */
    getAvailabilityScannerSnapshot(): AvailabilityScannerSnapshot | null {
        return this.availabilityScanner?.getSnapshot() ?? null;
    }

    /**
     * Get availability for a specific pair (for API routes).
     */
    getPairAvailability(pairKey: string): PairAvailability | null {
        return this.availabilityScanner?.getPairAvailability(pairKey) ?? null;
    }

    /**
     * Get the current pair key (e.g. "XRP/RLUSD").
     */
    getCurrentPairKey(): string {
        return `${this.baseConfig.tradingPair.baseCurrency}/${this.baseConfig.tradingPair.quoteCurrency}`;
    }

    /**
     * Get the XRPL-normalized pair key (hex-encoded currency codes).
     *
     * This matches the format used by OfferExecutor when recording trade events
     * in the feedback DB (e.g. "XRP/524C555344000000000000000000000000000000"
     * instead of "XRP/RLUSD"). Used for governance/feedback queries.
     */
    private getResolvedPairKey(pair?: TradingPair): string {
        if (!pair && this.resolvedPairKey) {
            return this.resolvedPairKey;
        }
        const target = pair ?? this.baseConfig.tradingPair;
        try {
            const resolved = resolveToNormalizedPair(target);
            const key = resolved.symbol;
            if (!pair) {
                this.resolvedPairKey = key;
            }
            return key;
        } catch {
            // Fallback to human-readable if resolution fails
            return `${target.baseCurrency}/${target.quoteCurrency}`;
        }
    }

    private ensureStrategyFunnel(strategyName: string): StrategyDecisionFunnel {
        const existing = this.strategyDecisionFunnels[strategyName];
        if (existing) return existing;
        const created = createStrategyDecisionFunnel();
        this.strategyDecisionFunnels[strategyName] = created;
        return created;
    }

    private syncStrategyFunnelToCache(pairKey?: string): void {
        const effectivePairKey = pairKey ?? this.getActivePair();
        if (!effectivePairKey) return;
        this.cacheRegistry.updateStrategyFunnel(
            effectivePairKey,
            cloneStrategyDecisionFunnelMap(this.strategyDecisionFunnels),
        );
    }

    private recordStrategyTick(strategyName: string, pairKey: string): void {
        const funnel = this.ensureStrategyFunnel(strategyName);
        funnel.strategyTicks += 1;
        this.syncStrategyFunnelToCache(pairKey);
    }

    private recordStrategyCandidate(strategyName: string, pairKey: string): void {
        const funnel = this.ensureStrategyFunnel(strategyName);
        funnel.candidatesBuilt += 1;
        this.syncStrategyFunnelToCache(pairKey);
    }

    private recordStrategyRejected(
        strategyName: string,
        reasonCode: string,
        context: StrategyEventContext,
        detail?: Record<string, unknown>,
    ): void {
        const funnel = this.ensureStrategyFunnel(strategyName);
        funnel.rejectedCount += 1;
        funnel.rejectedByReason[reasonCode] = (funnel.rejectedByReason[reasonCode] ?? 0) + 1;
        this.observabilityBus.emitStrategyRejected({
            pairKey: context.pairKey,
            runtimeState: context.fsmState,
            strategy: strategyName,
            reasonCode,
            regime: context.regime,
            spreadBps: context.spreadBps,
            healthScore: context.healthScore,
            ...(detail ? { detail } : {}),
        });
        this.syncStrategyFunnelToCache(context.pairKey);
    }

    private recordStrategyApproved(
        strategyName: string,
        context: StrategyEventContext,
        event?: StrategyApprovalEvent,
    ): void {
        const funnel = this.ensureStrategyFunnel(strategyName);
        funnel.approvedCount += 1;
        this.observabilityBus.emitStrategyApproved({
            pairKey: context.pairKey,
            runtimeState: context.fsmState,
            strategy: strategyName,
            ...(event?.side ? { side: event.side } : {}),
            ...(typeof event?.sizeBase === 'number' ? { sizeBase: event.sizeBase } : {}),
            ...(event?.expectedPriceSource ? { expectedPriceSource: event.expectedPriceSource } : {}),
            ...(event ? { detail: event } : {}),
        });
        this.syncStrategyFunnelToCache(context.pairKey);
    }

    private buildStrategyFunnelRecorder(strategyName: string, context: StrategyEventContext) {
        return {
            markCandidateBuilt: () => this.recordStrategyCandidate(strategyName, context.pairKey),
            markRejected: (reasonCode: string, detail?: Record<string, unknown>) => {
                this.recordStrategyRejected(strategyName, reasonCode, context, detail);
            },
            markApproved: (event?: StrategyApprovalEvent) => {
                this.recordStrategyApproved(strategyName, context, event);
            },
        };
    }

    private classifyExecutionLifecycle(
        event: StrategySubmitTelemetryEvent,
    ): { lifecycleStage: string; outcomeClass: string; retryable: boolean; abortReason: string | null } {
        if (event.stage === 'attempt') {
            return {
                lifecycleStage: 'attempt',
                outcomeClass: 'attempt',
                retryable: false,
                abortReason: null,
            };
        }

        if (event.stage === 'success') {
            return {
                lifecycleStage: 'submitted',
                outcomeClass: event.ackStatus === 'queued' ? 'queued' : 'accepted',
                retryable: false,
                abortReason: null,
            };
        }

        const rawCode = (event.errorCode ?? event.submitResult?.engine_result ?? '').toUpperCase();
        const timeoutLike = rawCode.includes('TIMEOUT');
        const networkLike = rawCode.includes('NETWORK') || rawCode.includes('DISCONNECT');
        const tecLike = rawCode.startsWith('TEC');
        const tefLike = rawCode.startsWith('TEF');
        const telLike = rawCode.startsWith('TEL');

        if (timeoutLike || networkLike || telLike) {
            return {
                lifecycleStage: 'abort',
                outcomeClass: 'retry',
                retryable: true,
                abortReason: rawCode || 'submit-failed',
            };
        }

        if (tecLike || tefLike) {
            return {
                lifecycleStage: 'abort',
                outcomeClass: 'rejected',
                retryable: false,
                abortReason: rawCode || 'submit-failed',
            };
        }

        return {
            lifecycleStage: 'abort',
            outcomeClass: 'failed',
            retryable: false,
            abortReason: rawCode || 'submit-failed',
        };
    }

    private updateHeartbeatFromSubmitTelemetry(event: StrategySubmitTelemetryEvent): void {
        const submitTs = event.submitTsMs;
        if (typeof submitTs === 'number' && Number.isFinite(submitTs)) {
            this.heartbeatLastSubmitTs = this.heartbeatLastSubmitTs == null
                ? submitTs
                : Math.max(this.heartbeatLastSubmitTs, submitTs);
        }

        const validatedTs = event.validatedTsMs;
        if (typeof validatedTs === 'number' && Number.isFinite(validatedTs)) {
            this.heartbeatLastValidatedTs = this.heartbeatLastValidatedTs == null
                ? validatedTs
                : Math.max(this.heartbeatLastValidatedTs, validatedTs);
        }
    }

    private sanitizeTickError(err: unknown): string {
        if (err instanceof Error) {
            return err.message;
        }
        return String(err);
    }

    private writeTickHeartbeat(tickId: number, inFlight: boolean, lastError: string | null): void {
        this.heartbeatLastError = lastError;
        const heartbeat: RuntimeHeartbeatSnapshot = {
            ts: Date.now(),
            tickId,
            inFlight,
            lastError: this.heartbeatLastError,
            lastSubmitTs: this.heartbeatLastSubmitTs,
            lastValidatedTs: this.heartbeatLastValidatedTs,
        };
        this.cacheRegistry.updateHeartbeat(this.getCurrentPairKey(), heartbeat);
    }

    private recordSubmitTelemetry(event: StrategySubmitTelemetryEvent): void {
        this.updateHeartbeatFromSubmitTelemetry(event);
        const funnel = this.ensureStrategyFunnel(event.strategy);
        applySubmitTelemetryToFunnel(funnel, event);
        const eventType = event.stage === 'attempt'
            ? 'SUBMIT_ATTEMPT'
            : (event.stage === 'success' ? 'SUBMIT_SUCCESS' : 'SUBMIT_FAIL');
        const execTelemetryEnabled = isExecTelemetryEnabled();
        const lifecycle = execTelemetryEnabled ? this.classifyExecutionLifecycle(event) : null;
        this.observabilityBus.emit({
            eventType,
            pairKey: event.pairKey,
            runtimeState: this.fsm.getState(),
            correlationId: event.tradeId ?? null,
            detail: {
                strategy: event.strategy,
                trade_id: event.tradeId ?? null,
                side: event.side ?? null,
                amount_base: event.amountBase ?? null,
                intent_price: event.intentPrice ?? null,
                baseline_ts_ms: event.baselineTsMs ?? null,
                baseline_best_bid: event.baselineBestBid ?? null,
                baseline_best_ask: event.baselineBestAsk ?? null,
                baseline_mid: event.baselineMid ?? null,
                baseline_spread_bps: event.baselineSpreadBps ?? null,
                baseline_source: event.baselineSource ?? null,
                expected_price: event.expectedPrice ?? null,
                expected_rule: event.expectedRule ?? null,
                price_convention: event.priceConvention ?? null,
                baseline_book_age_ms: event.baselineBookAgeMs ?? null,
                submit_ts_ms: event.submitTsMs ?? null,
                submit_response_ts_ms: event.submitResponseTsMs ?? event.ackTsMs ?? null,
                ack_ts_ms: event.ackTsMs ?? event.submitResponseTsMs ?? null,
                validated_ts_ms: event.validatedTsMs ?? null,
                node_endpoint: event.nodeEndpoint ?? null,
                fee_drops: event.feeDrops ?? null,
                sequence: event.sequence ?? null,
                offer_create: event.offerCreateIntent ?? null,
                engine_result: event.submitResult?.engine_result ?? null,
                submit_result: event.submitResult ?? null,
                ack_status: event.ackStatus ?? null,
                tx_hash: event.txHash ?? null,
                error_code: event.errorCode ?? null,
                ...(lifecycle ? {
                    lifecycle_stage: lifecycle.lifecycleStage,
                    outcome_class: lifecycle.outcomeClass,
                    retryable: lifecycle.retryable,
                    abort_reason: lifecycle.abortReason,
                } : {}),
            },
        });
        if (lifecycle) {
            logger.info({
                event: 'EXECUTION_LIFECYCLE',
                stage: lifecycle.lifecycleStage,
                outcome: lifecycle.outcomeClass,
                retryable: lifecycle.retryable,
                abortReason: lifecycle.abortReason,
                strategy: event.strategy,
                pairKey: event.pairKey,
                tradeId: event.tradeId ?? null,
                txHash: event.txHash ?? null,
                errorCode: event.errorCode ?? null,
            }, 'Execution lifecycle telemetry');
        }
        this.syncStrategyFunnelToCache(event.pairKey);
    }

    private emitMarkoutLifecycleEvent(event: MarkoutLifecycleEvent): void {
        const payload = {
            pairKey: event.pair_key,
            runtimeState: this.fsm.getState(),
            correlationId: event.correlation_id,
            detail: event.detail,
            ...(typeof event.timestamp_ms === 'number' ? { nowMs: event.timestamp_ms } : {}),
        };
        if (event.event_type === 'MARKOUT_SCHEDULED') {
            this.observabilityBus.emitMarkoutScheduled(payload);
            return;
        }
        if (event.event_type === 'MARKOUT_RECORDED') {
            this.observabilityBus.emitMarkoutRecorded(payload);
            return;
        }
        this.observabilityBus.emitMarkoutMissing(payload);
    }

    private buildVolatilityStopSnapshot(nowMs: number): VolatilityStopCacheSnapshot {
        const volCfg = this.baseConfig.strategy.volatilityStop;
        const volState = this.volatilityEstimator.getState();
        const volBps = this.volatilityEstimator.getVolBps();
        const volReady = this.volatilityEstimator.isReady(nowMs);
        const resolved = resolveAdaptiveStopLossBps({
            fixedStopLossBps: this.baseConfig.strategy.stopLossBps,
            volBps,
            volReady,
            config: volCfg,
        });

        return {
            enabled: volCfg?.enabled === true,
            volBps,
            volReady,
            stopLossBpsUsed: resolved.stopLossBpsUsed,
            enhancedStopBpsUsed: resolved.enhancedStopBpsUsed,
            source: resolved.source,
            sampleCount: volState.sampleCount,
        };
    }

    private updateVolatilityStopState(pairKey: string, nowMs: number, bestBid: number, bestAsk: number): void {
        const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : Number.NaN;
        this.volatilityEstimator.update(midPrice, nowMs);
        this.currentVolatilityStop = this.buildVolatilityStopSnapshot(nowMs);

        if (this.currentVolatilityStop.enabled && this.currentVolatilityStop.volReady && !this.volatilityStopReadyEmitted) {
            this.volatilityStopReadyEmitted = true;
            this.observabilityBus.emit({
                eventType: 'VOL_STOP_READY',
                pairKey,
                runtimeState: this.fsm.getState(),
                detail: {
                    volBps: Number(this.currentVolatilityStop.volBps.toFixed(2)),
                    sampleCount: this.currentVolatilityStop.sampleCount,
                    stopLossBpsUsed: Number(this.currentVolatilityStop.stopLossBpsUsed.toFixed(2)),
                    source: this.currentVolatilityStop.source,
                },
                nowMs,
            });
        }
    }

    /**
     * Push latest tick data into the cache registry.
     */
    private updateCacheSnapshot(
        pairKey: string,
        gate: ExecutionGateResult,
        flow: FlowMetrics | null,
        spreadDistribution: SpreadDistributionSnapshot | null,
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
            liquidity: this.liquidityIntelligence?.getSnapshot() ?? null,
            volatilityStop: this.currentVolatilityStop,
            spreadDistribution,
            strategyFunnel: cloneStrategyDecisionFunnelMap(this.strategyDecisionFunnels),
        });
    }

    /**
     * Best-effort background scanner callback.
     * Updates cache + observability only; never affects execution gate.
     */
    private handleBackgroundScannerSnapshot(pairKey: string, snapshot: BackgroundScannerSnapshot): void {
        try {
            this.cacheRegistry.updateBackground(pairKey, snapshot);
        } catch (err) {
            logger.warn({ err, pairKey }, 'Background scanner cache update rejected');
            return;
        }

        const degraded = snapshot.health.score < 60 || snapshot.health.consecutiveFailures > 0;
        if (degraded && !this.scannerWasDegraded) {
            this.scannerWasDegraded = true;
            this.observabilityBus.emitScannerDegraded({
                pairKey,
                runtimeState: this.fsm.getState(),
                score: snapshot.health.score,
                consecutiveFailures: snapshot.health.consecutiveFailures,
            });
        } else if (!degraded && this.scannerWasDegraded) {
            this.scannerWasDegraded = false;
            this.observabilityBus.emitScannerRecovered({
                pairKey,
                runtimeState: this.fsm.getState(),
                score: snapshot.health.score,
            });
        }

        if (snapshot.fairValue.xrpMid !== null) {
            this.observabilityBus.emitFairValueUpdated({
                pairKey,
                runtimeState: this.fsm.getState(),
                confidence: snapshot.fairValue.confidence,
                sourcesUsed: snapshot.fairValue.sourcesUsed.length,
                divergenceBpsVsXrpRlusd: snapshot.fairValue.divergenceBpsVsXrpRlusd,
            });
        }
    }

    private getActivePairMidPrice(): number | null {
        const bestBid = this.currentOrderBookSnapshot?.bestBid ?? 0;
        const bestAsk = this.currentOrderBookSnapshot?.bestAsk ?? 0;
        if (bestBid > 0 && bestAsk > 0) {
            return (bestBid + bestAsk) / 2;
        }
        return null;
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
     * Get the event loop lag tracker state (for API/observability).
     */
    getEventLoopLagState(): EventLoopLagState | null {
        return this.eventLoopLagTracker?.getState() ?? null;
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

        // Flush and close exposure tracker persistence
        try {
            await this.exposureTracker.closePersistence();
        } catch (err) {
            logger.warn({ err }, 'Failed to close exposure persistence');
        }

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

        try {
            tradeMarkoutScheduler.stop();
        } catch (err) {
            logger.warn({ err }, 'Failed to stop trade markout scheduler');
        }

        // Step 5: Stop background scanner before XRPL disconnect
        logStep('Stopping background market scanner');
        try {
            this.backgroundScanner?.stop();
        } catch (err) {
            logger.warn({ err }, 'Failed to stop background market scanner');
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

    setActivePair(pairKey: string): PairSwitchResult {
        const currentPairKey = this.getActivePair();

        // Idempotent: no-op if already on this pair
        if (pairKey === currentPairKey) {
            return { success: true, activePair: currentPairKey, pending: false };
        }

        // Reject if already switching (legacy FSM guard)
        if (this.pairSwitchState === 'SWITCHING' || this.pairSwitchState === 'SYNCING') {
            return { success: false, activePair: currentPairKey, pending: this.pairSwitchPending, error: 'Pair switch already in progress (legacy)' };
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
            return { success: false, activePair: currentPairKey, pending: false, error: `Invalid pair key: ${pairKey}` };
        }

        const target = findInstrument(pairKey);
        if (!target) {
            return { success: false, activePair: currentPairKey, pending: false, error: `Pair not found: ${pairKey}` };
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
            return { success: false, activePair: currentPairKey, pending: false, error };
        }

        // ─── Legacy FSM: IDLE → SWITCHING ────────────────────────────────
        this.pairSwitchState = 'SWITCHING';
        this.emitSwitchEvent('PAIR_SWITCH_START', pairKey, currentPairKey);
        this.observabilityBus.emitPairSwitchStart({
            fromPair: currentPairKey,
            toPair: pairKey,
            runtimeState: this.fsm.getState(),
        });

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

                // Invalidate resolved pair key cache so governance uses the new pair
                this.resolvedPairKey = null;

                // 2. Market data layer
                this.tradeTape?.setPair(newPair);
                this.tradeTapeService?.setPair(newPair);
                this.accountTradeIngestion?.setPair(newPair);
                this.tracker?.setPair(newPair);

                // 3. Execution layer
                this.executor?.setPair(newPair);
                this.executionQualityCollector.setPairKey(
                    `${newPair.baseCurrency}/${newPair.quoteCurrency}`,
                );
                this.hardRiskGuard.setPairKey(
                    `${newPair.baseCurrency}/${newPair.quoteCurrency}`,
                );
                this.exposureTracker.setPairKey(
                    `${newPair.baseCurrency}/${newPair.quoteCurrency}`,
                );
                this.spreadDistributionSampler.setPairKey(
                    `${newPair.baseCurrency}/${newPair.quoteCurrency}`,
                );

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
                const refreshed = await this.tracker.refresh();
                if (refreshed) {
                    const now = Date.now();
                    this.lastBookUpdateMs = now;
                    this.feedStallRecovery?.recordBookEvent(now);
                }
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

            // ─── Pending state: mark switch as in-flight ─────────────────
            const switchId = crypto.randomUUID();
            this.pairSwitchPending = true;
            this.pairSwitchSwitchId = switchId;
            this.pairSwitchTargetPairKey = pairKey;
            this.pairSwitchLastError = null;

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
                        this.pairSwitchPending = false;
                        this.emitSwitchEvent('PAIR_SWITCH_COMPLETE', pairKey, previousPairKey,
                            `orchestrator completed in ${result.durationMs}ms`);
                        this.observabilityBus.emitPairSwitchReady({
                            pairKey,
                            runtimeState: this.fsm.getState(),
                            durationMs: result.durationMs,
                        });
                    } else {
                        // Orchestrator failed — propagate failure visibly
                        this.pairSwitchPending = false;
                        this.pairSwitchLastError = result.error ?? 'Orchestrator async phases failed';
                        this.pairSwitchOrchestrator.recoverFromFailure();
                        this.emitSwitchEvent('PAIR_SWITCH_FAILED', pairKey, previousPairKey,
                            this.pairSwitchLastError);
                        this.observabilityBus.emitPairSwitchFailed({
                            pairKey,
                            runtimeState: this.fsm.getState(),
                            error: this.pairSwitchLastError,
                            switchId,
                        });
                        logger.warn({
                            error: result.error,
                            phases: result.phases,
                            switchId,
                        }, 'Pair switch orchestrator reported failure — PAIR_SWITCH_FAILED emitted');
                    }
                })
                .catch((err) => {
                    // Should not happen (executePairSwitch catches internally)
                    const errorMsg = err instanceof Error ? err.message : 'Unexpected orchestrator error';
                    this.pairSwitchPending = false;
                    this.pairSwitchLastError = errorMsg;
                    this.pairSwitchOrchestrator.recoverFromFailure();
                    this.emitSwitchEvent('PAIR_SWITCH_FAILED', pairKey, previousPairKey, errorMsg);
                    this.observabilityBus.emitPairSwitchFailed({
                        pairKey,
                        runtimeState: this.fsm.getState(),
                        error: errorMsg,
                        switchId,
                    });
                    logger.error({ err, switchId }, 'Unexpected orchestrator error — PAIR_SWITCH_FAILED emitted');
                });

            return { success: true, pending: true, switchId, activePair: this.getActivePair() };
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
            return { success: false, activePair: this.getActivePair(), pending: false, error };
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
        // ── Detach all runtime-owned event listeners first ────────────
        // Must happen BEFORE this.xrpl = null so we still have the reference.
        this.detachRuntimeListeners();

        // Stop persisted markout jobs timer loop for this runtime lifecycle.
        tradeMarkoutScheduler.stop();

        // Stop CPU watchdog
        if (this.cpuWatchdog) {
            this.cpuWatchdog.stop();
            this.cpuWatchdog = null;
        }

        // Stop perf tracer
        if (this.perfTracer) {
            stopPerfTracer();
            this.perfTracer = null;
        }

        // Stop event loop lag tracker
        if (this.eventLoopLagTracker) {
            this.eventLoopLagTracker.stop();
            this.eventLoopLagTracker = null;
        }

        // Stop background scanner (idempotent)
        this.backgroundScanner?.stop();
        this.backgroundScanner = null;
        this.scannerWasDegraded = false;

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
        this.tickHeartbeatCounter = 0;
        this.heartbeatLastSubmitTs = null;
        this.heartbeatLastValidatedTs = null;
        this.heartbeatLastError = null;
        this.started = false;
        this.shutdownInProgress = false;
        this.pairSwitchState = 'IDLE';
        this.pairSwitchOrchestrator.reset();
        this.pairSwitchPending = false;
        this.pairSwitchSwitchId = null;
        this.pairSwitchTargetPairKey = null;
        this.pairSwitchLastError = null;
        this.tradeTape = null;
        this.tradeTapeService = null;
        this.accountTradeIngestion?.reset();
        this.accountTradeIngestion = null;
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
        this.lastBalanceStale = false;
        this.lastBookUpdateMs = 0;
        this.lastTapeUpdateMs = 0;
        this.lastLedgerAdvanceMs = 0;
        this.snapshotValidator.reset();
        this.lastDataValid = true;
        this.lastDataInvalidReasons = [];
        this.cacheRegistry.reset();
        this.executionQualityCollector.reset();
        this.hardRiskGuard.reset();
        this.exposureTracker.reset();
        this.observabilityBus.clear();
        this.strategyDecisionFunnels = {};

        // Reset FSM to BOOTING for potential restart
        this.fsm.reset();
    }

    /**
     * Detach all runtime-owned event listeners from the XRPLWebSocket wrapper
     * and the underlying XRPL Client. Uses stored handler references for safe
     * .off() (never removeAllListeners). Idempotent.
     */
    private detachRuntimeListeners(): void {
        // Tier 2: listeners on the XRPLWebSocket EventEmitter
        if (this.xrpl) {
            if (this.onXrplLedger) this.xrpl.off('ledger', this.onXrplLedger);
            if (this.onXrplTransaction) this.xrpl.off('transaction', this.onXrplTransaction);
            if (this.onXrplReconnect) this.xrpl.off('reconnect', this.onXrplReconnect);
        }

        // Tier 1: listener on the underlying shared Client
        if (this.underlyingClientRef && this.onUnderlyingDisconnected) {
            this.underlyingClientRef.off('disconnected', this.onUnderlyingDisconnected);
        }

        // Clear references
        this.onXrplLedger = null;
        this.onXrplTransaction = null;
        this.onXrplReconnect = null;
        this.onUnderlyingDisconnected = null;
        this.underlyingClientRef = null;
        this.listenersAttached = false;
    }
}
