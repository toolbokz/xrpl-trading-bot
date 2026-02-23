import type { ExecutionQualityEventRecord } from './feedbackDb';

export const DEFAULT_EXECUTION_QUALITY_EXCLUDED_STRATEGIES = ['account-ingestion'] as const;

const TRUE_STRING_VALUES = new Set(['1', 'true', 'yes']);

type StrategyEventLike = Pick<ExecutionQualityEventRecord, 'strategy'>;

export interface StrategyFilterOptions {
    includeStrategies?: readonly string[] | null;
    excludeStrategies?: readonly string[] | null;
    defaultExcludedStrategies?: readonly string[];
}

export interface ResolvedStrategyFilters {
    includeStrategies: string[] | null;
    excludeStrategies: string[];
}

export interface AppliedStrategyFilters<T> {
    included: T[];
    excludedCount: number;
    applied: ResolvedStrategyFilters;
}

export type ExecutionEvidenceLike = Pick<ExecutionQualityEventRecord, 'txHash' | 'submitTs' | 'submitResultEngine'>;

export function parseCsvParam(value: unknown): string[] {
    const rawParts: string[] = [];
    if (typeof value === 'string') {
        rawParts.push(value);
    } else if (Array.isArray(value)) {
        for (const entry of value) {
            if (typeof entry === 'string') rawParts.push(entry);
        }
    }

    const deduped = new Set<string>();
    for (const raw of rawParts) {
        const parts = raw.split(',');
        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.length > 0) {
                deduped.add(trimmed);
            }
        }
    }
    return Array.from(deduped.values());
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (value == null || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
}

function normalizeStrategy(value: unknown): string | null {
    const text = asNonEmptyString(value);
    return text ? text.toLowerCase() : null;
}

function normalizeStrategies(values: readonly string[] | null | undefined): string[] {
    if (!values || values.length === 0) return [];
    const unique = new Set<string>();
    for (const value of values) {
        const normalized = normalizeStrategy(value);
        if (normalized) {
            unique.add(normalized);
        }
    }
    return Array.from(unique.values()).sort();
}

export function resolveStrategyFilters(options: StrategyFilterOptions = {}): ResolvedStrategyFilters {
    const includeStrategies = normalizeStrategies(options.includeStrategies);
    if (includeStrategies.length > 0) {
        return {
            includeStrategies,
            excludeStrategies: [],
        };
    }

    const fallbackExcludes = options.defaultExcludedStrategies ?? DEFAULT_EXECUTION_QUALITY_EXCLUDED_STRATEGIES;
    const excludeInput = options.excludeStrategies ?? fallbackExcludes;

    return {
        includeStrategies: null,
        excludeStrategies: normalizeStrategies(excludeInput),
    };
}

function shouldIncludeStrategy(strategy: unknown, resolved: ResolvedStrategyFilters): boolean {
    const normalized = normalizeStrategy(strategy);
    if (resolved.includeStrategies && resolved.includeStrategies.length > 0) {
        return normalized != null && resolved.includeStrategies.includes(normalized);
    }
    if (resolved.excludeStrategies.length > 0 && normalized != null) {
        return !resolved.excludeStrategies.includes(normalized);
    }
    return true;
}

export function applyStrategyFilters<T extends StrategyEventLike>(
    events: readonly T[],
    options: StrategyFilterOptions = {},
): AppliedStrategyFilters<T> {
    const resolved = resolveStrategyFilters(options);
    const included: T[] = [];
    let excludedCount = 0;
    for (const event of events) {
        if (shouldIncludeStrategy(event.strategy, resolved)) {
            included.push(event);
        } else {
            excludedCount += 1;
        }
    }

    return {
        included,
        excludedCount,
        applied: resolved,
    };
}

export function isExecutionEvidenceEvent(event: ExecutionEvidenceLike): boolean {
    const record = asRecord(event as unknown) ?? {};

    const txHash = asNonEmptyString(event.txHash) ?? asNonEmptyString(record.tx_hash);
    const submitTs = asFiniteNumber(event.submitTs)
        ?? asFiniteNumber(record.submit_ts_ms)
        ?? asFiniteNumber(record.submit_ts);

    const submitResultEngine = asNonEmptyString(event.submitResultEngine)
        ?? asNonEmptyString(record.submit_result_engine);
    const submitResult = asRecord(record.submit_result);
    const nestedSubmitResultEngine = submitResult
        ? asNonEmptyString(submitResult.engine_result) ?? asNonEmptyString(submitResult.engineResult)
        : null;

    const rawTxType = asNonEmptyString(record.txType) ?? asNonEmptyString(record.tx_type);
    const normalizedTxType = rawTxType ? rawTxType.replace(/[_\s]/g, '').toLowerCase() : null;
    const hasOfferType = normalizedTxType === 'offercreate';
    const hasOfferIntent = record.offerCreate != null || record.offer_create != null;

    return txHash != null
        || submitTs != null
        || submitResultEngine != null
        || nestedSubmitResultEngine != null
        || hasOfferType
        || hasOfferIntent;
}

function asBooleanFlag(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') return TRUE_STRING_VALUES.has(value.trim().toLowerCase());
    return false;
}

export function isPaperTradeEvent(event: unknown): boolean {
    const record = asRecord(event) ?? {};
    return asBooleanFlag(record.paper)
        || asBooleanFlag(record.isPaper)
        || asBooleanFlag(record.is_paper)
        || asBooleanFlag(record.paperTrade)
        || asBooleanFlag(record.paper_trade);
}
