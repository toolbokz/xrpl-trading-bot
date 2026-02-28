import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest, jsonError } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { logSensitiveAction } from '../../../lib/localApi/audit';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Env-settings API — read & write .env values for the Advanced panel.
// ---------------------------------------------------------------------------

/** Sensitive keys that are never exposed to the UI. */
const REDACTED_KEYS = new Set([
    'XRPL_SECRET_NUMBERS_MAINNET_ENC',
    'XRPL_SECRET_PASSPHRASE',
    'AWS_SECRET_NAME',
    'AWS_REGION',
    'XUMM_API_KEY',
    'XUMM_API_SECRET',
    'XUMM_USER_TOKEN',
    'LOCAL_API_TOKEN',
    'REDIS_URL',
]);

/** Keys the UI is not allowed to modify (safety-critical or structural). */
const READ_ONLY_KEYS = new Set([
    'NODE_ENV',
    'BOT_LOCAL_ONLY',
    'BOT_ALLOW_REMOTE',
    'MAINNET_LIVE_TRADING_ACK',
    'SAFETY_LOCK_FILE',
    'SAFETY_SKIP_MAINNET_ACK',
    'PORT',
    ...REDACTED_KEYS,
]);

/**
 * Grouped setting metadata used by both API and UI.
 * Each group has a label and an ordered list of env keys.
 */
export interface EnvSettingMeta {
    key: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    readOnly?: boolean;
}

export interface EnvGroup {
    id: string;
    label: string;
    settings: EnvSettingMeta[];
}

export const ENV_GROUPS: EnvGroup[] = [
    {
        id: 'runtime',
        label: 'Runtime',
        settings: [
            { key: 'LOG_LEVEL', type: 'string', description: 'Logging verbosity (debug, info, warn, error)' },
            { key: 'HISTORY_MODE', type: 'string', description: 'Trade history mode (backfill, none)' },
            { key: 'SERVICE_NAME', type: 'string', description: 'Service name for logs / tracing' },
        ],
    },
    {
        id: 'security',
        label: 'Security',
        settings: [
            { key: 'BOT_LOCAL_ONLY', type: 'boolean', description: 'Restrict to localhost only', readOnly: true },
            { key: 'BOT_ALLOW_REMOTE', type: 'boolean', description: 'Allow remote access (dangerous)', readOnly: true },
            { key: 'BOT_API_DEV_MODE', type: 'boolean', description: 'Skip proxy header checks in dev' },
        ],
    },
    {
        id: 'xrpl',
        label: 'XRPL Connection',
        settings: [
            { key: 'XRPL_NETWORK', type: 'string', description: 'Network (mainnet or testnet)' },
            { key: 'XRPL_WSS_URLS', type: 'string', description: 'Comma-separated WebSocket endpoints' },
            { key: 'XRPL_MAX_RECONNECTS', type: 'number', description: 'Max reconnect attempts' },
            { key: 'XRPL_RECONNECT_DELAY_MS', type: 'number', description: 'Initial reconnect delay (ms)' },
            { key: 'XRPL_RECONNECT_MAX_DELAY_MS', type: 'number', description: 'Max reconnect delay (ms)' },
            { key: 'XRPL_CONNECT_TIMEOUT_MS', type: 'number', description: 'Connection timeout (ms)' },
            { key: 'XRPL_REQUEST_TIMEOUT_MS', type: 'number', description: 'Request timeout (ms)' },
            { key: 'XRPL_429_COOLDOWN_MS', type: 'number', description: 'Rate-limit cooldown (ms)' },
        ],
    },
    {
        id: 'trading-pair',
        label: 'Trading Pair',
        settings: [
            { key: 'TRADE_BASE_CURRENCY', type: 'string', description: 'Base currency (e.g. XRP)' },
            { key: 'TRADE_QUOTE_CURRENCY', type: 'string', description: 'Quote currency (e.g. RLUSD)' },
            { key: 'TRADE_QUOTE_ISSUER', type: 'string', description: 'Quote currency issuer address' },
            { key: 'TRADE_ISSUER', type: 'string', description: 'Legacy issuer fallback' },
        ],
    },
    {
        id: 'execution',
        label: 'Execution',
        settings: [
            { key: 'EXECUTION_ORDER_TYPE', type: 'string', description: 'Order type (IOC, limit, etc.)' },
            { key: 'EXECUTION_MIN_FILL_RATIO', type: 'number', description: 'Min fill ratio (0-1)' },
            { key: 'EXECUTION_DEPTH_LEVELS', type: 'number', description: 'Book depth levels to check' },
            { key: 'EXECUTION_REPRICE_MAX_BPS', type: 'number', description: 'Max BPS for depth reprice' },
            { key: 'PAPER_TRADING', type: 'boolean', description: 'Paper trading mode (no real orders)' },
        ],
    },
    {
        id: 'risk',
        label: 'Risk Management',
        settings: [
            { key: 'BASE_ORDER_SIZE_XRP', type: 'number', description: 'Primary order size in XRP' },
            { key: 'MAX_TRADE_SIZE', type: 'number', description: 'Maximum single trade size (XRP)' },
            { key: 'MAX_DAILY_LOSS_XRP', type: 'number', description: 'Daily loss limit (XRP)' },
            { key: 'MAX_EXPOSURE_PER_ISSUER', type: 'number', description: 'Max exposure per issuer (XRP)' },
            { key: 'RESERVE_FLOOR_XRP', type: 'number', description: 'XRP reserve floor' },
            { key: 'RESERVE_BUFFER_XRP', type: 'number', description: 'XRP reserve buffer' },
            { key: 'CONSECUTIVE_FAILURE_KILL_SWITCH', type: 'number', description: 'Consecutive failures before kill switch' },
            { key: 'MAX_SLIPPAGE_BPS', type: 'number', description: 'Max slippage (basis points)' },
            { key: 'STOP_LOSS_BPS', type: 'number', description: 'Stop loss (basis points)' },
            { key: 'COOLDOWN_MS', type: 'number', description: 'Cooldown between trades (ms)' },
        ],
    },
    {
        id: 'hard-risk',
        label: 'Hard Risk Guards',
        settings: [
            { key: 'HARD_RISK_MAX_EXPOSURE', type: 'number', description: 'Hard max exposure limit' },
            { key: 'HARD_RISK_MAX_SKEW_PCT', type: 'number', description: 'Max position skew (%)' },
            { key: 'HARD_RISK_MAX_DRAWDOWN_PCT', type: 'number', description: 'Max drawdown (%)' },
            { key: 'HARD_RISK_MAX_BALANCE_STALE_MS', type: 'number', description: 'Max balance stale time (ms)' },
            { key: 'HARD_RISK_MIN_FEED_HEALTH', type: 'number', description: 'Minimum feed health score' },
        ],
    },
    {
        id: 'entry-gate',
        label: 'Entry Gate & Scalper',
        settings: [
            { key: 'ENTRY_GATE_CROSS_BPS', type: 'number', description: 'Entry gate cross threshold (bps)' },
            { key: 'ENTRY_GATE_MAX_SPREAD_BPS', type: 'number', description: 'Max spread to allow entry (bps)' },
            { key: 'SCALPER_ENTRY_CROSS_BPS', type: 'number', description: 'Scalper entry cross (bps)' },
            { key: 'SCALPER_EXIT_CROSS_BPS', type: 'number', description: 'Scalper exit cross (bps)' },
            { key: 'SCALPER_MAX_EXIT_SPREAD_BPS', type: 'number', description: 'Scalper max exit spread (bps)' },
            { key: 'SCALPER_MIN_TAKE_PROFIT_BPS', type: 'number', description: 'Min take-profit above entry (bps)' },
        ],
    },
    {
        id: 'flow',
        label: 'Flow & Regime',
        settings: [
            { key: 'FLOW_ALPHA_ENABLED', type: 'boolean', description: 'Enable flow-alpha directional filter' },
            { key: 'FLOW_ALPHA_MIN_IMBALANCE', type: 'number', description: 'Min order flow imbalance' },
            { key: 'FLOW_ALPHA_MIN_COMBINED_SIGNAL', type: 'number', description: 'Min combined signal strength' },
            { key: 'FLOW_WINDOW_MS', type: 'number', description: 'Flow analysis window (ms)' },
            { key: 'FLOW_TRENDING_THRESHOLD', type: 'number', description: 'Trending regime threshold' },
            { key: 'FLOW_CHAOTIC_SPREAD_BPS', type: 'number', description: 'Chaotic regime spread (bps)' },
            { key: 'FLOW_ENABLE_REGIME_FILTER', type: 'boolean', description: 'Enable regime-based filtering' },
            { key: 'FLOW_ENABLE_ADVERSE_SELECTION', type: 'boolean', description: 'Enable adverse selection guard' },
            { key: 'FLOW_MAX_QUOTE_SKEW_BPS', type: 'number', description: 'Max quote skew (bps)' },
        ],
    },
    {
        id: 'edge-cost',
        label: 'Edge Cost Gate',
        settings: [
            { key: 'EDGE_COST_GATE_ENABLED', type: 'boolean', description: 'Enable edge vs cost gate' },
            { key: 'EDGE_ESTIMATE_MULTIPLIER_BPS', type: 'number', description: 'Edge estimate multiplier (bps)' },
            { key: 'EDGE_MIN_SURPLUS_BPS', type: 'number', description: 'Min edge surplus (bps)' },
            { key: 'EDGE_MIN_DEPTH_IMBALANCE', type: 'number', description: 'Min depth imbalance' },
            { key: 'EDGE_MIN_BUY_AGGRESSION_RATIO', type: 'number', description: 'Min buy aggression ratio' },
        ],
    },
    {
        id: 'trend',
        label: 'Trend Detection',
        settings: [
            { key: 'TREND_DETECTION_ENABLED', type: 'boolean', description: 'Enable trend detector' },
            { key: 'TREND_FAST_HALF_LIFE_MS', type: 'number', description: 'Fast EMA half-life (ms)' },
            { key: 'TREND_SLOW_HALF_LIFE_MS', type: 'number', description: 'Slow EMA half-life (ms)' },
            { key: 'TREND_FLAT_THRESHOLD_BPS', type: 'number', description: 'Flat threshold (bps)' },
            { key: 'TREND_ENTRY_BLOCK_BPS', type: 'number', description: 'Entry block threshold (bps)' },
        ],
    },
    {
        id: 'vol-stop',
        label: 'Volatility Stop',
        settings: [
            { key: 'VOL_STOP_ENABLED', type: 'boolean', description: 'Enable volatility stop' },
            { key: 'VOL_STOP_WARMUP_MS', type: 'number', description: 'Warmup period (ms)' },
            { key: 'VOL_STOP_MIN_SAMPLES', type: 'number', description: 'Min samples before active' },
            { key: 'VOL_STOP_ALPHA', type: 'number', description: 'EMA smoothing alpha' },
            { key: 'VOL_STOP_MULTIPLIER', type: 'number', description: 'Volatility multiplier for stop' },
            { key: 'VOL_STOP_MIN_BPS', type: 'number', description: 'Floor for stop distance (bps)' },
            { key: 'VOL_STOP_MAX_BPS', type: 'number', description: 'Ceiling for stop distance (bps)' },
        ],
    },
    {
        id: 'capital-protection',
        label: 'Capital Protection',
        settings: [
            { key: 'CAPITAL_PROTECTION_ENABLED', type: 'boolean', description: 'Enable capital protection' },
            { key: 'CP_LOOKBACK_TRADES', type: 'number', description: 'Rolling window size (trades)' },
            { key: 'CP_MAX_ROLLING_DRAWDOWN_PCT', type: 'number', description: 'Max rolling drawdown (%)' },
            { key: 'CP_MIN_PROFIT_FACTOR', type: 'number', description: 'Min profit factor' },
            { key: 'CP_MIN_EXPECTANCY_BPS', type: 'number', description: 'Min expectancy (bps)' },
            { key: 'CP_CONSEC_FAIL_SHUTDOWN', type: 'number', description: 'Consecutive fails → shutdown' },
            { key: 'CP_SIZE_THROTTLE_MULT', type: 'number', description: 'Size throttle multiplier' },
            { key: 'CP_PAUSE_COOLDOWN_MS', type: 'number', description: 'Pause cooldown (ms)' },
        ],
    },
    {
        id: 'reprice',
        label: 'Reprice Policy',
        settings: [
            { key: 'REPRICE_DRIFT_THRESHOLD_BPS', type: 'number', description: 'Drift threshold (bps)' },
            { key: 'REPRICE_HARD_STALENESS_MS', type: 'number', description: 'Hard staleness timeout (ms)' },
            { key: 'REPRICE_CHURN_LIMIT_PER_MIN', type: 'number', description: 'Max reprices per minute' },
            { key: 'ORDERBOOK_STALE_MS', type: 'number', description: 'Order book stale threshold (ms)' },
            { key: 'ORDERBOOK_SOURCE_LEDGER_STALE_MS', type: 'number', description: 'Source ledger stale threshold (ms)' },
        ],
    },
    {
        id: 'adaptive',
        label: 'Adaptive Learning',
        settings: [
            { key: 'ADAPTIVE_LEARNING_ENABLED', type: 'boolean', description: 'Enable adaptive sizing' },
            { key: 'ADAPTIVE_LOOKBACK_HOURS', type: 'number', description: 'Lookback period (hours)' },
            { key: 'ADAPTIVE_MIN_SAMPLES', type: 'number', description: 'Min samples for adjustment' },
            { key: 'ADAPTIVE_UPDATE_INTERVAL_MIN', type: 'number', description: 'Update interval (minutes)' },
            { key: 'ADAPTIVE_ALPHA', type: 'number', description: 'EMA smoothing factor' },
            { key: 'ADAPTIVE_MIN_SIZE', type: 'number', description: 'Min adaptive size multiplier' },
            { key: 'ADAPTIVE_MAX_SIZE_STEP', type: 'number', description: 'Max size step' },
        ],
    },
    {
        id: 'regime-policy',
        label: 'Regime Policy',
        settings: [
            { key: 'REGIME_POLICY_ENABLED', type: 'boolean', description: 'Enable regime policy' },
            { key: 'REGIME_POLICY_LOOKBACK_HOURS', type: 'number', description: 'Lookback window (hours)' },
            { key: 'REGIME_POLICY_MIN_TRADES', type: 'number', description: 'Min trades for policy' },
            { key: 'REGIME_MIN_SIZE', type: 'number', description: 'Min regime size' },
            { key: 'REGIME_MAX_SIZE', type: 'number', description: 'Max regime size' },
        ],
    },
    {
        id: 'monitoring',
        label: 'Monitoring & Performance',
        settings: [
            { key: 'EVENT_LOOP_LAG_LIMIT_MS', type: 'number', description: 'Event loop lag limit (ms)' },
            { key: 'EVENT_LOOP_SAMPLE_INTERVAL_MS', type: 'number', description: 'Event loop sample rate (ms)' },
            { key: 'BOT_LOOP_MIN_DELAY_MS', type: 'number', description: 'Min loop delay (ms)' },
            { key: 'STRATEGY_MAX_TPS', type: 'number', description: 'Max strategy ticks/sec' },
            { key: 'PERF_SUMMARY_INTERVAL_MS', type: 'number', description: 'Performance summary interval (ms)' },
            { key: 'LOG_MAX_PER_SEC', type: 'number', description: 'Max log lines per second' },
        ],
    },
    {
        id: 'features',
        label: 'Feature Flags',
        settings: [
            { key: 'FEATURE_XRPL_DISCOVERY_ENABLED', type: 'boolean', description: 'Enable XRPL discovery UI' },
            { key: 'FEATURE_TRADE_TOASTS_ENABLED', type: 'boolean', description: 'Enable trade toast notifications' },
            { key: 'FEATURE_TX_INTENT_LOOKUP', type: 'boolean', description: 'Enable TX intent lookup' },
            { key: 'FEATURE_EXECUTION_PRICE_SANITY', type: 'boolean', description: 'Enable execution price sanity' },
            { key: 'FEATURE_EXECUTION_MIN_ORDER_SANITY', type: 'boolean', description: 'Enable min order size sanity' },
            { key: 'TRADE_TAPE_ENABLED', type: 'boolean', description: 'Enable trade tape' },
            { key: 'SCANNER_ENABLED', type: 'boolean', description: 'Enable market scanner' },
            { key: 'TRUSTLINE_AUTO_ENSURE', type: 'boolean', description: 'Auto-create trustlines' },
        ],
    },
];

// ── helpers ──────────────────────────────────────────────────────────

function envFilePath(): string {
    // Use the deployed env file (the one the service actually reads).
    const deployed = '/opt/xrpl-trading-bot/.env';
    if (fs.existsSync(deployed)) return deployed;
    // Fallback for dev
    return path.resolve(process.cwd(), '.env');
}

function parseEnvFile(content: string): Map<string, { value: string; commented: boolean }> {
    const map = new Map<string, { value: string; commented: boolean }>();
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        // Match active and commented-out key=value lines
        const m = trimmed.match(/^(#\s*)?([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        const commented = !!m[1];
        const key = m[2]!;
        const value = m[3]!;
        // Only store first occurrence (active takes precedence over commented)
        if (!map.has(key)) {
            map.set(key, { value, commented });
        } else if (!commented) {
            // Active line overrides a previous commented line
            map.set(key, { value, commented: false });
        }
    }
    return map;
}

function setEnvValue(content: string, key: string, newValue: string): string {
    const lines = content.split('\n');
    let found = false;
    const result = lines.map((line) => {
        const trimmed = line.trim();
        // Match active (non-commented) line for this key
        const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && m[1]! === key && !found) {
            found = true;
            return `${key}=${newValue}`;
        }
        return line;
    });
    if (!found) {
        // Append at end
        result.push(`${key}=${newValue}`);
    }
    return result.join('\n');
}

// ── handler ──────────────────────────────────────────────────────────

async function handler(req: LocalRequest, res: NextApiResponse) {
    const filePath = envFilePath();

    // GET — return current values grouped
    if (req.method === 'GET') {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = parseEnvFile(raw);

            const groups = ENV_GROUPS.map((group) => ({
                ...group,
                settings: group.settings.map((s) => {
                    const entry = parsed.get(s.key);
                    const isRedacted = REDACTED_KEYS.has(s.key);
                    return {
                        ...s,
                        value: isRedacted ? '••••••' : (entry?.value ?? ''),
                        commented: entry?.commented ?? true,
                        readOnly: s.readOnly || READ_ONLY_KEYS.has(s.key),
                    };
                }),
            }));

            return res.status(200).json({ groups, filePath, requestId: req.requestId });
        } catch (err) {
            return jsonError(res, 500, `Failed to read .env: ${(err as Error).message}`, req.requestId);
        }
    }

    // PUT — update one or more settings
    if (req.method === 'PUT') {
        const body = req.parsedBody as Record<string, unknown> | null;
        if (!body || typeof body !== 'object' || !body.changes) {
            return jsonError(res, 400, 'Body must include { changes: { KEY: value, ... } }', req.requestId);
        }

        const changes = body.changes as Record<string, string>;
        const blocked: string[] = [];
        const applied: string[] = [];

        try {
            let content = fs.readFileSync(filePath, 'utf-8');

            for (const [key, value] of Object.entries(changes)) {
                if (READ_ONLY_KEYS.has(key)) {
                    blocked.push(key);
                    continue;
                }
                content = setEnvValue(content, key, String(value));
                applied.push(key);
            }

            fs.writeFileSync(filePath, content, 'utf-8');

            void logSensitiveAction(
                req.requestId,
                'env-settings-update',
                { keys: applied },
            );

            return res.status(200).json({
                ok: true,
                applied,
                blocked,
                message: applied.length > 0
                    ? `Updated ${applied.length} setting(s). Restart the bot for changes to take effect.`
                    : 'No settings were updated.',
                requestId: req.requestId,
            });
        } catch (err) {
            return jsonError(res, 500, `Failed to write .env: ${(err as Error).message}`, req.requestId);
        }
    }

    return jsonError(res, 405, 'Method not allowed', req.requestId);
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET', 'PUT'] });
