import fs from 'fs';
import path from 'path';
import { getSnapshotNear } from './feedbackDb';
import { logger } from './logger';
import {
    tradeHistory,
    TradeMarkoutMissingReason,
    TradeMarkoutRecord,
} from './tradeHistory';
import { canonicalizePairKey } from '../xrpl/currency';

export type MarkoutLifecycleEventType = 'MARKOUT_SCHEDULED' | 'MARKOUT_RECORDED' | 'MARKOUT_MISSING';

export interface MarkoutLifecycleEvent {
    event_type: MarkoutLifecycleEventType;
    pair_key: string;
    correlation_id: string | null;
    detail: Record<string, unknown>;
    timestamp_ms?: number;
}

export interface ScheduleMarkoutsInput {
    trade_id: string;
    tx_hash: string;
    pair_key: string;
    side: 'buy' | 'sell';
    fill_price: number;
    fill_ts_ms: number;
    horizons_s?: number[];
}

interface PendingMarkoutJob {
    job_id: string;
    trade_id: string;
    tx_hash: string;
    pair_key: string;
    side: 'buy' | 'sell';
    fill_price: number;
    fill_ts_ms: number;
    horizon_s: number;
    due_ts_ms: number;
    attempts: number;
    created_ts_ms: number;
    expires_ts_ms: number;
}

interface SchedulerHooks {
    emit_event?: ((event: MarkoutLifecycleEvent) => void) | null;
}

const DEFAULT_HORIZONS_S = [60, 300];
const MARKOUT_PENDING_FILE = path.resolve(process.cwd(), 'data', 'trade_markouts_pending.json');
const RETRY_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 5;

function clampHorizonSeconds(value: number): number {
    if (!Number.isFinite(value)) return 60;
    return Math.max(1, Math.floor(value));
}

function configuredDefaultHorizons(): number[] {
    const raw = process.env.MARKOUT_HORIZONS_S;
    if (!raw || raw.trim().length === 0) return DEFAULT_HORIZONS_S;
    const parsed = raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => clampHorizonSeconds(n));
    if (parsed.length === 0) return DEFAULT_HORIZONS_S;
    return [...new Set(parsed)];
}

function computeMarkoutBps(side: 'buy' | 'sell', fillPrice: number, markPrice: number): number {
    if (!Number.isFinite(fillPrice) || fillPrice <= 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
        return 0;
    }
    const raw = side === 'buy'
        ? ((markPrice - fillPrice) / fillPrice) * 10_000
        : ((fillPrice - markPrice) / fillPrice) * 10_000;
    return Math.round(raw * 100) / 100;
}

function normalizePendingJob(raw: unknown): PendingMarkoutJob | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.job_id !== 'string' || typeof record.trade_id !== 'string' || typeof record.tx_hash !== 'string') {
        return null;
    }
    if (typeof record.pair_key !== 'string' || (record.side !== 'buy' && record.side !== 'sell')) {
        return null;
    }
    const fillPrice = typeof record.fill_price === 'number' && Number.isFinite(record.fill_price) ? record.fill_price : NaN;
    const fillTsMs = typeof record.fill_ts_ms === 'number' && Number.isFinite(record.fill_ts_ms) ? record.fill_ts_ms : NaN;
    const dueTsMs = typeof record.due_ts_ms === 'number' && Number.isFinite(record.due_ts_ms) ? record.due_ts_ms : NaN;
    const horizonS = typeof record.horizon_s === 'number' && Number.isFinite(record.horizon_s)
        ? clampHorizonSeconds(record.horizon_s)
        : NaN;
    if (!Number.isFinite(fillPrice) || !Number.isFinite(fillTsMs) || !Number.isFinite(dueTsMs) || !Number.isFinite(horizonS)) {
        return null;
    }
    return {
        job_id: record.job_id,
        trade_id: record.trade_id,
        tx_hash: record.tx_hash,
        pair_key: canonicalizePairKey(record.pair_key),
        side: record.side,
        fill_price: fillPrice,
        fill_ts_ms: fillTsMs,
        horizon_s: horizonS,
        due_ts_ms: dueTsMs,
        attempts: typeof record.attempts === 'number' && Number.isFinite(record.attempts)
            ? Math.max(0, Math.floor(record.attempts))
            : 0,
        created_ts_ms: typeof record.created_ts_ms === 'number' && Number.isFinite(record.created_ts_ms)
            ? record.created_ts_ms
            : Date.now(),
        expires_ts_ms: typeof record.expires_ts_ms === 'number' && Number.isFinite(record.expires_ts_ms)
            ? record.expires_ts_ms
            : dueTsMs + 180_000,
    };
}

function missingReasonFromState(
    txHash: string,
    lastError: string | null,
    timedOut: boolean,
): TradeMarkoutMissingReason {
    const trade = tradeHistory.getTradeByHash(txHash);
    if (!trade) return 'unknown';
    if (trade.status !== 'FILLED' && trade.status !== 'PARTIAL') return 'trade_not_filled';
    const validatedTs = trade.trace?.validated_ts_ms ?? null;
    if (validatedTs == null || validatedTs <= 0) return 'tx_unvalidated';
    if (lastError && /snapshot|db|sqlite|feedback/i.test(lastError)) return 'price_source_down';
    if (timedOut) return 'timeout';
    return 'no_liquidity';
}

class TradeMarkoutScheduler {
    private started = false;
    private hooks: SchedulerHooks = {};
    private pendingJobs = new Map<string, PendingMarkoutJob>();
    private timers = new Map<string, NodeJS.Timeout>();

    setHooks(hooks: SchedulerHooks): void {
        this.hooks = hooks;
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.loadPendingFromDisk();
        for (const job of this.pendingJobs.values()) {
            this.scheduleTimer(job);
        }
    }

    stop(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.started = false;
    }

    schedule(input: ScheduleMarkoutsInput): void {
        const horizons = (input.horizons_s && input.horizons_s.length > 0 ? input.horizons_s : configuredDefaultHorizons())
            .map(clampHorizonSeconds);
        const pairKey = canonicalizePairKey(input.pair_key);
        const nowMs = Date.now();

        for (const horizonS of horizons) {
            const dueTsMs = input.fill_ts_ms + (horizonS * 1000);
            const jobId = `${input.trade_id}:${horizonS}`;
            if (this.pendingJobs.has(jobId)) continue;
            const job: PendingMarkoutJob = {
                job_id: jobId,
                trade_id: input.trade_id,
                tx_hash: input.tx_hash,
                pair_key: pairKey,
                side: input.side,
                fill_price: input.fill_price,
                fill_ts_ms: input.fill_ts_ms,
                horizon_s: horizonS,
                due_ts_ms: dueTsMs,
                attempts: 0,
                created_ts_ms: nowMs,
                // If no market snapshot appears near due_ts_ms within this window, mark as missing.
                expires_ts_ms: dueTsMs + Math.max(120_000, Math.floor(horizonS * 500)),
            };
            this.pendingJobs.set(jobId, job);
            this.emit({
                event_type: 'MARKOUT_SCHEDULED',
                pair_key: pairKey,
                correlation_id: input.trade_id,
                detail: {
                    trade_id: input.trade_id,
                    tx_hash: input.tx_hash,
                    horizon_s: horizonS,
                    due_ts_ms: dueTsMs,
                },
            });
            if (this.started) {
                this.scheduleTimer(job);
            }
        }

        this.savePendingToDisk();
    }

    getPendingCount(): number {
        return this.pendingJobs.size;
    }

    private emit(event: MarkoutLifecycleEvent): void {
        const emitter = this.hooks.emit_event;
        if (!emitter) return;
        try {
            emitter(event);
        } catch (err) {
            logger.debug({ err, eventType: event.event_type }, 'Markout lifecycle emitter failed');
        }
    }

    private scheduleTimer(job: PendingMarkoutJob): void {
        const existing = this.timers.get(job.job_id);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(job.job_id);
        }

        const delayMs = Math.max(0, job.due_ts_ms - Date.now());
        const timer = setTimeout(() => {
            void this.processJob(job.job_id);
        }, delayMs);
        this.timers.set(job.job_id, timer);
    }

    private async processJob(jobId: string): Promise<void> {
        try {
            this.timers.delete(jobId);
            const job = this.pendingJobs.get(jobId);
            if (!job) return;
            job.attempts += 1;

            let lastError: string | null = null;
            let markPrice: number | null = null;

            try {
                const toleranceMs = Math.max(60_000, Math.floor(job.horizon_s * 1000));
                const snapshot = getSnapshotNear(job.pair_key, job.due_ts_ms, toleranceMs);
                const candidateMid = snapshot?.midPrice;
                if (typeof candidateMid === 'number' && Number.isFinite(candidateMid) && candidateMid > 0) {
                    markPrice = candidateMid;
                }
            } catch (err) {
                lastError = err instanceof Error ? err.message : 'snapshot-lookup-failed';
            }

            if (markPrice != null) {
                const markoutBps = computeMarkoutBps(job.side, job.fill_price, markPrice);
                const record: TradeMarkoutRecord = {
                    horizon_s: job.horizon_s,
                    due_ts_ms: job.due_ts_ms,
                    mark_ts_ms: Date.now(),
                    mark_price: markPrice,
                    markout_bps: markoutBps,
                    source: 'market_snapshots',
                    status: 'recorded',
                    missing_reason: null,
                    attempts: job.attempts,
                    last_error: null,
                };
                tradeHistory.appendTradeMarkout({
                    hash: job.tx_hash,
                    tradeId: job.trade_id,
                    markout: record,
                });
                this.emit({
                    event_type: 'MARKOUT_RECORDED',
                    pair_key: job.pair_key,
                    correlation_id: job.trade_id,
                    detail: {
                        trade_id: job.trade_id,
                        tx_hash: job.tx_hash,
                        horizon_s: job.horizon_s,
                        due_ts_ms: job.due_ts_ms,
                        mark_ts_ms: record.mark_ts_ms,
                        mark_price: markPrice,
                        markout_bps: markoutBps,
                        source: record.source,
                    },
                });
                this.pendingJobs.delete(jobId);
                this.savePendingToDisk();
                return;
            }

            const timedOut = Date.now() >= job.expires_ts_ms || job.attempts >= MAX_ATTEMPTS;
            if (!timedOut) {
                const retryTimer = setTimeout(() => {
                    void this.processJob(job.job_id);
                }, RETRY_INTERVAL_MS);
                this.timers.set(job.job_id, retryTimer);
                this.savePendingToDisk();
                return;
            }

            const reason = missingReasonFromState(job.tx_hash, lastError, timedOut);
            const missing: TradeMarkoutRecord = {
                horizon_s: job.horizon_s,
                due_ts_ms: job.due_ts_ms,
                mark_ts_ms: Date.now(),
                mark_price: null,
                markout_bps: null,
                source: 'market_snapshots',
                status: 'missing',
                missing_reason: reason,
                attempts: job.attempts,
                last_error: lastError,
            };
            tradeHistory.appendTradeMarkout({
                hash: job.tx_hash,
                tradeId: job.trade_id,
                markout: missing,
            });
            this.emit({
                event_type: 'MARKOUT_MISSING',
                pair_key: job.pair_key,
                correlation_id: job.trade_id,
                detail: {
                    trade_id: job.trade_id,
                    tx_hash: job.tx_hash,
                    horizon_s: job.horizon_s,
                    due_ts_ms: job.due_ts_ms,
                    missing_reason: reason,
                    attempts: job.attempts,
                    last_error: lastError,
                },
            });
            this.pendingJobs.delete(jobId);
            this.savePendingToDisk();
        } catch (err) {
            logger.warn({ err, jobId }, 'Unhandled markout processing error');
            this.pendingJobs.delete(jobId);
            this.savePendingToDisk();
        }
    }

    private loadPendingFromDisk(): void {
        try {
            if (!fs.existsSync(MARKOUT_PENDING_FILE)) return;
            const content = fs.readFileSync(MARKOUT_PENDING_FILE, 'utf8');
            const raw = JSON.parse(content);
            if (!Array.isArray(raw)) return;
            for (const item of raw) {
                const job = normalizePendingJob(item);
                if (!job) continue;
                this.pendingJobs.set(job.job_id, job);
            }
            logger.info({ pendingCount: this.pendingJobs.size }, 'Loaded pending markout jobs');
        } catch (err) {
            logger.warn({ err }, 'Failed to load pending markout jobs');
            this.pendingJobs.clear();
        }
    }

    private savePendingToDisk(): void {
        try {
            fs.mkdirSync(path.dirname(MARKOUT_PENDING_FILE), { recursive: true });
            const jobs = [...this.pendingJobs.values()].sort((a, b) => a.due_ts_ms - b.due_ts_ms);
            fs.writeFileSync(MARKOUT_PENDING_FILE, JSON.stringify(jobs, null, 2), 'utf8');
        } catch (err) {
            logger.warn({ err }, 'Failed to persist pending markout jobs');
        }
    }
}

export const tradeMarkoutScheduler = new TradeMarkoutScheduler();
export const TRADE_MARKOUT_PENDING_FILE = MARKOUT_PENDING_FILE;
