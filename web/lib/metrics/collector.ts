/**
 * Metrics collector for Prometheus monitoring.
 * Collects request counts, rate limit blocks, and bot state.
 */

export interface MetricLabels {
    [key: string]: string;
}

interface CounterValue {
    value: number;
    labels: MetricLabels;
}

interface GaugeValue {
    value: number;
    labels: MetricLabels;
}

interface HistogramBucket {
    le: number;
    count: number;
}

interface HistogramValue {
    buckets: HistogramBucket[];
    sum: number;
    count: number;
    labels: MetricLabels;
}

// Metrics storage
const counters = new Map<string, CounterValue[]>();
const gauges = new Map<string, GaugeValue[]>();
const histograms = new Map<string, HistogramValue[]>();

// Default histogram buckets for request duration (ms)
const DEFAULT_DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * Find or create a metric value with matching labels.
 */
function findOrCreateValue<T extends { labels: MetricLabels }>(
    values: T[],
    labels: MetricLabels,
    createFn: () => T
): T {
    const existing = values.find((v) => labelsMatch(v.labels, labels));
    if (existing) return existing;
    const newValue = createFn();
    values.push(newValue);
    return newValue;
}

/**
 * Check if two label sets match.
 */
function labelsMatch(a: MetricLabels, b: MetricLabels): boolean {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k, i) => keysB[i] === k && a[k] === b[k]);
}

/**
 * Increment a counter metric.
 */
export function incCounter(name: string, labels: MetricLabels = {}, value: number = 1): void {
    if (!counters.has(name)) {
        counters.set(name, []);
    }
    const values = counters.get(name)!;
    const entry = findOrCreateValue(values, labels, () => ({ value: 0, labels }));
    entry.value += value;
}

/**
 * Set a gauge metric value.
 */
export function setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    if (!gauges.has(name)) {
        gauges.set(name, []);
    }
    const values = gauges.get(name)!;
    const entry = findOrCreateValue(values, labels, () => ({ value: 0, labels }));
    entry.value = value;
}

/**
 * Increment a gauge metric.
 */
export function incGauge(name: string, labels: MetricLabels = {}, delta: number = 1): void {
    if (!gauges.has(name)) {
        gauges.set(name, []);
    }
    const values = gauges.get(name)!;
    const entry = findOrCreateValue(values, labels, () => ({ value: 0, labels }));
    entry.value += delta;
}

/**
 * Decrement a gauge metric.
 */
export function decGauge(name: string, labels: MetricLabels = {}, delta: number = 1): void {
    incGauge(name, labels, -delta);
}

/**
 * Record a value in a histogram.
 */
export function observeHistogram(
    name: string,
    value: number,
    labels: MetricLabels = {},
    buckets: number[] = DEFAULT_DURATION_BUCKETS
): void {
    if (!histograms.has(name)) {
        histograms.set(name, []);
    }
    const values = histograms.get(name)!;
    const entry = findOrCreateValue(values, labels, () => ({
        buckets: buckets.map((le) => ({ le, count: 0 })),
        sum: 0,
        count: 0,
        labels,
    }));

    entry.sum += value;
    entry.count += 1;
    for (const bucket of entry.buckets) {
        if (value <= bucket.le) {
            bucket.count += 1;
        }
    }
}

/**
 * Format labels for Prometheus output.
 */
function formatLabels(labels: MetricLabels): string {
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
    return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
}

/**
 * Escape label value for Prometheus format.
 */
function escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Get all metrics in Prometheus exposition format.
 */
export function getPrometheusMetrics(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, values] of counters) {
        lines.push(`# HELP ${name} Counter metric`);
        lines.push(`# TYPE ${name} counter`);
        for (const v of values) {
            lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
        }
    }

    // Gauges
    for (const [name, values] of gauges) {
        lines.push(`# HELP ${name} Gauge metric`);
        lines.push(`# TYPE ${name} gauge`);
        for (const v of values) {
            lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
        }
    }

    // Histograms
    for (const [name, values] of histograms) {
        lines.push(`# HELP ${name} Histogram metric`);
        lines.push(`# TYPE ${name} histogram`);
        for (const v of values) {
            for (const bucket of v.buckets) {
                lines.push(`${name}_bucket${formatLabels({ ...v.labels, le: String(bucket.le) })} ${bucket.count}`);
            }
            lines.push(`${name}_bucket${formatLabels({ ...v.labels, le: '+Inf' })} ${v.count}`);
            lines.push(`${name}_sum${formatLabels(v.labels)} ${v.sum}`);
            lines.push(`${name}_count${formatLabels(v.labels)} ${v.count}`);
        }
    }

    return lines.join('\n') + '\n';
}

/**
 * Clear all metrics (for testing).
 */
export function clearMetrics(): void {
    counters.clear();
    gauges.clear();
    histograms.clear();
}

// =============================================================================
// Predefined Metrics
// =============================================================================

/** Bot API metrics namespace */
export const BotMetrics = {
    /** Increment HTTP request counter */
    httpRequest(method: string, path: string, status: number): void {
        incCounter('bot_http_requests_total', { method, path, status: String(status) });
    },

    /** Record HTTP request duration */
    httpDuration(method: string, path: string, durationMs: number): void {
        observeHistogram('bot_http_request_duration_ms', durationMs, { method, path });
    },

    /** Increment rate limit block counter */
    rateLimitBlocked(path: string, type: string): void {
        incCounter('bot_rate_limit_blocked_total', { path, type });
    },

    /** Increment auth failure counter */
    authFailure(reason: string): void {
        incCounter('bot_auth_failures_total', { reason });
    },

    /** Set bot state gauge (0=stopped, 1=paused, 2=running) */
    setBotState(state: 'STOPPED' | 'PAUSED' | 'RUNNING'): void {
        const stateValue = state === 'RUNNING' ? 2 : state === 'PAUSED' ? 1 : 0;
        setGauge('bot_state', stateValue);
    },

    /** Set active position count */
    setActivePositions(count: number): void {
        setGauge('bot_active_positions', count);
    },

    /** Set bot balance */
    setBalance(currency: string, amount: number): void {
        setGauge('bot_balance', amount, { currency });
    },

    /** Increment trade counter */
    tradeExecuted(side: 'buy' | 'sell', success: boolean): void {
        incCounter('bot_trades_total', { side, success: String(success) });
    },

    /** Record trade profit/loss */
    tradePnL(pnl: number): void {
        observeHistogram('bot_trade_pnl', pnl, {}, [-100, -50, -10, -1, 0, 1, 10, 50, 100, 500, 1000]);
    },

    /** Set XRPL connection state (0=disconnected, 1=connected) */
    setXrplConnected(connected: boolean): void {
        setGauge('bot_xrpl_connected', connected ? 1 : 0);
    },

    /** Record XRPL request latency */
    xrplLatency(command: string, durationMs: number): void {
        observeHistogram('bot_xrpl_request_duration_ms', durationMs, { command });
    },

    /** Increment XRPL error counter */
    xrplError(command: string, error: string): void {
        incCounter('bot_xrpl_errors_total', { command, error });
    },
};
