import type { Client } from 'xrpl';
import { loadConfig } from '../../../config';
import { validateStartupConfig, type StartupValidationIssue } from '../../../config/startupValidation';
import { logger } from '../../../analytics/logger';
import { getFeedbackDb } from '../../../analytics/feedbackDb';
import type { RuntimeHeartbeatSnapshot } from '../../../runtime/runtimeCacheRegistry';
import { getXrplClient } from '../../../xrpl/sharedClient';
import { toXrplCurrency } from '../../../xrpl/currency';
import { getCacheSnapshot, getProcessModeInfo, getState, isSingleProcessMode } from '../runtimeBridge';
import { botController } from '../botController';

interface ProbeResult {
    ok: boolean;
    latencyMs: number | null;
    detail: string;
}

interface ProbeResultWithExtra<T> extends ProbeResult {
    data: T;
}

type WorkerLiveness = 'OK' | 'DEGRADED' | 'FAIL';

export interface RuntimeHeartbeatHealth {
    ts: number;
    tickId: number;
    ageMs: number;
    inFlight: boolean;
    lastError: string | null;
    lastSubmitTs: number | null;
    lastValidatedTs: number | null;
}

export interface BotWiringHealthReport {
    ok: boolean;
    timestamp: string;
    checks: {
        config: {
            ok: boolean;
            strictEnabled: boolean;
            failFast: boolean;
            environment: string;
            issues: StartupValidationIssue[];
        };
        db: ProbeResult;
        redis: ProbeResult & { enabled: boolean };
        xrplServerInfo: ProbeResultWithExtra<{ validatedLedger: number | null; networkId: number | null }>;
        orderBook: ProbeResultWithExtra<{ pairKey: string; offers: number; ledgerIndex: number | null }>;
        worker: {
            ok: boolean;
            liveness: WorkerLiveness;
            mode: 'single' | 'dual';
            botState: 'RUNNING' | 'PAUSED' | 'STOPPED';
            runtimeStarted: boolean;
            runtimeReady: boolean;
            warmingUp: boolean;
            heartbeatMaxAgeMs: number;
            heartbeat: RuntimeHeartbeatHealth | null;
            detail: string;
        };
    };
    warnings: string[];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${context}-timeout:${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function nowMs(): number {
    return Date.now();
}

function sanitizeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function resolveProbeTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.BOT_WIRING_HEALTH_TIMEOUT_MS ?? '', 10);
    if (!Number.isFinite(parsed)) return 3_500;
    return Math.max(500, parsed);
}

function resolveHeartbeatMaxAgeMs(): number {
    const parsed = Number.parseInt(process.env.EXECUTION_HEARTBEAT_MAX_AGE_MS ?? '', 10);
    if (!Number.isFinite(parsed)) return 15_000;
    return Math.max(1_000, parsed);
}

function formatHeartbeat(heartbeat: RuntimeHeartbeatSnapshot, now: number): RuntimeHeartbeatHealth {
    return {
        ts: heartbeat.ts,
        tickId: heartbeat.tickId,
        ageMs: Math.max(0, now - heartbeat.ts),
        inFlight: heartbeat.inFlight,
        lastError: heartbeat.lastError,
        lastSubmitTs: heartbeat.lastSubmitTs,
        lastValidatedTs: heartbeat.lastValidatedTs,
    };
}

export function evaluateRuntimeHeartbeatLiveness(input: {
    heartbeat: RuntimeHeartbeatSnapshot | null;
    nowMs: number;
    maxAgeMs: number;
    runtimeShouldBeRunning: boolean;
}): { liveness: WorkerLiveness; ok: boolean; detail: string; heartbeat: RuntimeHeartbeatHealth | null } {
    if (!input.runtimeShouldBeRunning) {
        return {
            liveness: 'OK',
            ok: true,
            detail: 'Runtime heartbeat not required for current worker state',
            heartbeat: input.heartbeat ? formatHeartbeat(input.heartbeat, input.nowMs) : null,
        };
    }

    if (!input.heartbeat) {
        return {
            liveness: 'FAIL',
            ok: false,
            detail: 'Runtime heartbeat missing while runtime should be running',
            heartbeat: null,
        };
    }

    const normalized = formatHeartbeat(input.heartbeat, input.nowMs);
    if (normalized.ageMs <= input.maxAgeMs) {
        return {
            liveness: 'OK',
            ok: true,
            detail: `Runtime heartbeat fresh (${normalized.ageMs}ms <= ${input.maxAgeMs}ms)`,
            heartbeat: normalized,
        };
    }

    return {
        liveness: 'DEGRADED',
        ok: false,
        detail: `Runtime heartbeat stale (${normalized.ageMs}ms > ${input.maxAgeMs}ms)`,
        heartbeat: normalized,
    };
}

async function probeFeedbackDb(): Promise<ProbeResult> {
    const start = nowMs();
    try {
        const db = getFeedbackDb();
        const row = db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
        const ok = row?.ok === 1;
        return {
            ok,
            latencyMs: nowMs() - start,
            detail: ok ? 'feedback sqlite reachable' : 'feedback sqlite probe returned unexpected payload',
        };
    } catch (err) {
        return {
            ok: false,
            latencyMs: nowMs() - start,
            detail: `feedback sqlite probe failed: ${sanitizeError(err)}`,
        };
    }
}

type RedisClientLike = {
    connect: () => Promise<unknown>;
    ping: () => Promise<string>;
    quit: () => Promise<unknown>;
    disconnect?: () => void;
    on: (event: 'error', handler: (err: unknown) => void) => void;
};

async function probeRedis(timeoutMs: number): Promise<ProbeResult & { enabled: boolean }> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        return {
            ok: true,
            enabled: false,
            latencyMs: null,
            detail: 'REDIS_URL not configured (skipped)',
        };
    }

    const start = nowMs();
    let client: RedisClientLike | null = null;
    try {
        const redisModule = await import('redis') as {
            createClient: (opts: { url: string; socket: { connectTimeout: number } }) => RedisClientLike;
        };
        client = redisModule.createClient({
            url: redisUrl,
            socket: { connectTimeout: timeoutMs },
        });
        client.on('error', () => {
            // Keep probe non-throwing; final status comes from connect/ping promises.
        });

        await withTimeout(client.connect(), timeoutMs, 'redis-connect');
        const pong = await withTimeout(client.ping(), timeoutMs, 'redis-ping');
        await client.quit();
        return {
            ok: pong.toUpperCase() === 'PONG',
            enabled: true,
            latencyMs: nowMs() - start,
            detail: `redis ping: ${pong}`,
        };
    } catch (err) {
        if (client?.disconnect) {
            try {
                client.disconnect();
            } catch {
                // ignore cleanup errors
            }
        }
        return {
            ok: false,
            enabled: true,
            latencyMs: nowMs() - start,
            detail: `redis probe failed: ${sanitizeError(err)}`,
        };
    }
}

function resolveIssuedIssuer(currency: string, issuer: string | undefined, fallbackIssuer: string | undefined): string | undefined {
    if (currency.trim().toUpperCase() === 'XRP') return undefined;
    return issuer ?? fallbackIssuer;
}

async function probeXrplServerInfo(timeoutMs: number): Promise<ProbeResultWithExtra<{ client: Client | null; validatedLedger: number | null; networkId: number | null }>> {
    const start = nowMs();
    try {
        const client = await withTimeout(getXrplClient(), timeoutMs, 'xrpl-connect');
        const response = await withTimeout(
            client.request({ command: 'server_info' }),
            timeoutMs,
            'xrpl-server_info',
        );
        const info = response.result?.info;
        const validatedLedger = typeof info?.validated_ledger?.seq === 'number'
            ? info.validated_ledger.seq
            : null;
        const networkId = typeof info?.network_id === 'number' ? info.network_id : null;
        return {
            ok: true,
            latencyMs: nowMs() - start,
            detail: 'XRPL server_info succeeded',
            data: { client, validatedLedger, networkId },
        };
    } catch (err) {
        return {
            ok: false,
            latencyMs: nowMs() - start,
            detail: `XRPL server_info probe failed: ${sanitizeError(err)}`,
            data: { client: null, validatedLedger: null, networkId: null },
        };
    }
}

async function probeOrderBook(
    client: Client | null,
    timeoutMs: number,
): Promise<ProbeResultWithExtra<{ pairKey: string; offers: number; ledgerIndex: number | null }>> {
    const cfg = loadConfig();
    const pairKey = `${cfg.tradingPair.baseCurrency}/${cfg.tradingPair.quoteCurrency}`;
    const start = nowMs();
    if (!client) {
        return {
            ok: false,
            latencyMs: nowMs() - start,
            detail: 'XRPL client unavailable for orderbook probe',
            data: { pairKey, offers: 0, ledgerIndex: null },
        };
    }

    try {
        const baseIssuer = resolveIssuedIssuer(
            cfg.tradingPair.baseCurrency,
            cfg.tradingPair.baseIssuer,
            cfg.tradingPair.issuer,
        );
        const quoteIssuer = resolveIssuedIssuer(
            cfg.tradingPair.quoteCurrency,
            cfg.tradingPair.quoteIssuer,
            cfg.tradingPair.issuer,
        );
        const takerGetsInput = quoteIssuer
            ? { currency: cfg.tradingPair.quoteCurrency, issuer: quoteIssuer }
            : { currency: cfg.tradingPair.quoteCurrency };
        const takerPaysInput = baseIssuer
            ? { currency: cfg.tradingPair.baseCurrency, issuer: baseIssuer }
            : { currency: cfg.tradingPair.baseCurrency };
        const response = await withTimeout(
            client.request({
                command: 'book_offers',
                taker_gets: toXrplCurrency(takerGetsInput) as unknown as Record<string, unknown>,
                taker_pays: toXrplCurrency(takerPaysInput) as unknown as Record<string, unknown>,
                ledger_index: 'validated',
                limit: 5,
            } as unknown as Parameters<Client['request']>[0]),
            timeoutMs,
            'xrpl-book_offers',
        );

        const responseResult = response.result as {
            offers?: unknown[];
            ledger_index?: number | string;
            ledger_current_index?: number | string;
        } | undefined;
        const offers = Array.isArray(responseResult?.offers) ? responseResult.offers.length : 0;
        const rawLedgerIndex = responseResult?.ledger_index ?? responseResult?.ledger_current_index;
        const parsedLedger = typeof rawLedgerIndex === 'number'
            ? rawLedgerIndex
            : (typeof rawLedgerIndex === 'string' ? Number(rawLedgerIndex) : NaN);
        const ledgerIndex = Number.isFinite(parsedLedger) ? parsedLedger : null;
        return {
            ok: offers > 0 || responseResult !== undefined,
            latencyMs: nowMs() - start,
            detail: `book_offers succeeded with ${offers} offers`,
            data: { pairKey, offers, ledgerIndex },
        };
    } catch (err) {
        return {
            ok: false,
            latencyMs: nowMs() - start,
            detail: `orderbook probe failed: ${sanitizeError(err)}`,
            data: { pairKey, offers: 0, ledgerIndex: null },
        };
    }
}

function getWorkerCheck(): BotWiringHealthReport['checks']['worker'] {
    const mode = getProcessModeInfo();
    const botState = botController.getState();
    const runtimeState = getState();
    const cache = getCacheSnapshot();
    const heartbeatMaxAgeMs = resolveHeartbeatMaxAgeMs();
    const now = nowMs();
    const heartbeat = cache?.heartbeat ?? null;

    if (!isSingleProcessMode()) {
        return {
            ok: true,
            liveness: 'OK',
            mode: mode.mode,
            botState,
            runtimeStarted: mode.runtimeStarted,
            runtimeReady: mode.runtimeReady,
            warmingUp: mode.warmingUp,
            heartbeatMaxAgeMs,
            heartbeat: heartbeat ? formatHeartbeat(heartbeat, now) : null,
            detail: 'Dual-process mode (legacy) - runtime worker status is best-effort only',
        };
    }

    const runtimeShouldBeRunning = botState === 'RUNNING' && mode.runtimeStarted;
    const heartbeatStatus = evaluateRuntimeHeartbeatLiveness({
        heartbeat,
        nowMs: now,
        maxAgeMs: heartbeatMaxAgeMs,
        runtimeShouldBeRunning,
    });

    if (botState === 'RUNNING' && mode.runtimeReady) {
        return {
            ok: heartbeatStatus.ok,
            liveness: heartbeatStatus.liveness,
            mode: mode.mode,
            botState,
            runtimeStarted: mode.runtimeStarted,
            runtimeReady: mode.runtimeReady,
            warmingUp: mode.warmingUp,
            heartbeatMaxAgeMs,
            heartbeat: heartbeatStatus.heartbeat,
            detail: `Bot loop RUNNING and runtime READY; ${heartbeatStatus.detail}`,
        };
    }

    if (botState === 'RUNNING' && mode.runtimeStarted && !mode.runtimeReady) {
        return {
            ok: heartbeatStatus.ok,
            liveness: heartbeatStatus.liveness,
            mode: mode.mode,
            botState,
            runtimeStarted: mode.runtimeStarted,
            runtimeReady: mode.runtimeReady,
            warmingUp: mode.warmingUp,
            heartbeatMaxAgeMs,
            heartbeat: heartbeatStatus.heartbeat,
            detail: `Bot loop RUNNING while runtime is still warming/degraded; ${heartbeatStatus.detail}`,
        };
    }

    return {
        ok: true,
        liveness: 'OK',
        mode: mode.mode,
        botState,
        runtimeStarted: mode.runtimeStarted,
        runtimeReady: mode.runtimeReady,
        warmingUp: mode.warmingUp,
        heartbeatMaxAgeMs,
        heartbeat: heartbeat ? formatHeartbeat(heartbeat, now) : null,
        detail: `Bot state ${botState}; active pair ${runtimeState.pair ?? 'none'}`,
    };
}

export async function buildBotWiringHealthReport(): Promise<BotWiringHealthReport> {
    const timeoutMs = resolveProbeTimeoutMs();
    const cfg = loadConfig();
    const configValidation = validateStartupConfig(process.env, cfg);

    const [dbResult, redisResult, xrplServerInfo] = await Promise.all([
        probeFeedbackDb(),
        probeRedis(timeoutMs),
        probeXrplServerInfo(timeoutMs),
    ]);
    const orderBook = await probeOrderBook(xrplServerInfo.data.client, timeoutMs);
    const worker = getWorkerCheck();

    const warnings: string[] = [];
    if (!configValidation.ok) warnings.push('startup-config-errors');
    if (configValidation.issues.some((issue) => issue.severity === 'warning')) warnings.push('startup-config-warnings');
    if (!dbResult.ok) warnings.push('feedback-db-unreachable');
    if (redisResult.enabled && !redisResult.ok) warnings.push('redis-unreachable');
    if (!xrplServerInfo.ok) warnings.push('xrpl-server-info-failed');
    if (!orderBook.ok) warnings.push('orderbook-probe-failed');
    if (worker.botState !== 'RUNNING') warnings.push(`bot-state-${worker.botState.toLowerCase()}`);
    if (worker.runtimeReady === false && worker.botState === 'RUNNING') warnings.push('runtime-not-ready');
    if (worker.liveness === 'DEGRADED') warnings.push('runtime-heartbeat-stale');
    if (worker.liveness === 'FAIL') warnings.push('runtime-heartbeat-missing');

    const report: BotWiringHealthReport = {
        ok: configValidation.ok && dbResult.ok && xrplServerInfo.ok && orderBook.ok && worker.ok,
        timestamp: new Date().toISOString(),
        checks: {
            config: {
                ok: configValidation.ok,
                strictEnabled: configValidation.strictEnabled,
                failFast: configValidation.failFast,
                environment: configValidation.environment,
                issues: configValidation.issues,
            },
            db: dbResult,
            redis: redisResult,
            xrplServerInfo: {
                ok: xrplServerInfo.ok,
                latencyMs: xrplServerInfo.latencyMs,
                detail: xrplServerInfo.detail,
                data: {
                    validatedLedger: xrplServerInfo.data.validatedLedger,
                    networkId: xrplServerInfo.data.networkId,
                },
            },
            orderBook,
            worker,
        },
        warnings,
    };

    if (!report.ok) {
        logger.warn({
            ok: report.ok,
            warnings: report.warnings,
            checks: {
                config: report.checks.config.ok,
                db: report.checks.db.ok,
                redis: report.checks.redis.ok,
                xrplServerInfo: report.checks.xrplServerInfo.ok,
                orderBook: report.checks.orderBook.ok,
            },
        }, '[Health] bot wiring check failed');
    }

    return report;
}
