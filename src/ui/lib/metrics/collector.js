"use strict";
/**
 * Metrics collector for Prometheus monitoring.
 * Collects request counts, rate limit blocks, and bot state.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotMetrics = exports.clearMetrics = exports.getPrometheusMetrics = exports.observeHistogram = exports.decGauge = exports.incGauge = exports.setGauge = exports.incCounter = void 0;
// Metrics storage
const counters = new Map();
const gauges = new Map();
const histograms = new Map();
// Default histogram buckets for request duration (ms)
const DEFAULT_DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
/**
 * Find or create a metric value with matching labels.
 */
function findOrCreateValue(values, labels, createFn) {
    const existing = values.find((v) => labelsMatch(v.labels, labels));
    if (existing)
        return existing;
    const newValue = createFn();
    values.push(newValue);
    return newValue;
}
/**
 * Check if two label sets match.
 */
function labelsMatch(a, b) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length)
        return false;
    return keysA.every((k, i) => keysB[i] === k && a[k] === b[k]);
}
/**
 * Increment a counter metric.
 */
function incCounter(name, labels = {}, value = 1) {
    if (!counters.has(name)) {
        counters.set(name, []);
    }
    const values = counters.get(name);
    const entry = findOrCreateValue(values, labels, () => ({ value: 0, labels }));
    entry.value += value;
}
exports.incCounter = incCounter;
/**
 * Set a gauge metric value.
 */
function setGauge(name, value, labels = {}) {
    if (!gauges.has(name)) {
        gauges.set(name, []);
    }
    const values = gauges.get(name);
    const entry = findOrCreateValue(values, labels, () => ({ value: 0, labels }));
    entry.value = value;
}
exports.setGauge = setGauge;
/**
 * Increment a gauge metric.
 */
function incGauge(name, labels = {}, delta = 1) {
    if (!gauges.has(name)) {
        gauges.set(name, []);
    }
    const values = gauges.get(name);
    const entry = findOrCreateValue(values, labels, () => ({ value: 0, labels }));
    entry.value += delta;
}
exports.incGauge = incGauge;
/**
 * Decrement a gauge metric.
 */
function decGauge(name, labels = {}, delta = 1) {
    incGauge(name, labels, -delta);
}
exports.decGauge = decGauge;
/**
 * Record a value in a histogram.
 */
function observeHistogram(name, value, labels = {}, buckets = DEFAULT_DURATION_BUCKETS) {
    if (!histograms.has(name)) {
        histograms.set(name, []);
    }
    const values = histograms.get(name);
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
exports.observeHistogram = observeHistogram;
/**
 * Format labels for Prometheus output.
 */
function formatLabels(labels) {
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
    return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
}
/**
 * Escape label value for Prometheus format.
 */
function escapeLabel(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
/**
 * Get all metrics in Prometheus exposition format.
 */
function getPrometheusMetrics() {
    const lines = [];
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
exports.getPrometheusMetrics = getPrometheusMetrics;
/**
 * Clear all metrics (for testing).
 */
function clearMetrics() {
    counters.clear();
    gauges.clear();
    histograms.clear();
}
exports.clearMetrics = clearMetrics;
// =============================================================================
// Predefined Metrics
// =============================================================================
/** Bot API metrics namespace */
exports.BotMetrics = {
    /** Increment HTTP request counter */
    httpRequest(method, path, status) {
        incCounter('bot_http_requests_total', { method, path, status: String(status) });
    },
    /** Record HTTP request duration */
    httpDuration(method, path, durationMs) {
        observeHistogram('bot_http_request_duration_ms', durationMs, { method, path });
    },
    /** Increment rate limit block counter */
    rateLimitBlocked(path, type) {
        incCounter('bot_rate_limit_blocked_total', { path, type });
    },
    /** Increment auth failure counter */
    authFailure(reason) {
        incCounter('bot_auth_failures_total', { reason });
    },
    /** Set bot state gauge (0=stopped, 1=paused, 2=running) */
    setBotState(state) {
        const stateValue = state === 'RUNNING' ? 2 : state === 'PAUSED' ? 1 : 0;
        setGauge('bot_state', stateValue);
    },
    /** Set active position count */
    setActivePositions(count) {
        setGauge('bot_active_positions', count);
    },
    /** Set bot balance */
    setBalance(currency, amount) {
        setGauge('bot_balance', amount, { currency });
    },
    /** Increment trade counter */
    tradeExecuted(side, success) {
        incCounter('bot_trades_total', { side, success: String(success) });
    },
    /** Record trade profit/loss */
    tradePnL(pnl) {
        observeHistogram('bot_trade_pnl', pnl, {}, [-100, -50, -10, -1, 0, 1, 10, 50, 100, 500, 1000]);
    },
    /** Set XRPL connection state (0=disconnected, 1=connected) */
    setXrplConnected(connected) {
        setGauge('bot_xrpl_connected', connected ? 1 : 0);
    },
    /** Record XRPL request latency */
    xrplLatency(command, durationMs) {
        observeHistogram('bot_xrpl_request_duration_ms', durationMs, { command });
    },
    /** Increment XRPL error counter */
    xrplError(command, error) {
        incCounter('bot_xrpl_errors_total', { command, error });
    },
};
//# sourceMappingURL=collector.js.map