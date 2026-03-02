#!/usr/bin/env ts-node

import * as fs from "node:fs";
import * as path from "node:path";

type Severity = "error" | "warn" | "info";

type ParsedEntry = {
    key: string;
    value: string;
    raw: string;
    line: number;
};

type Issue = {
    severity: Severity;
    code: string;
    message: string;
    key?: string;
    line?: number;
    details?: Record<string, unknown>;
};

type ParsedEnv = {
    entries: ParsedEntry[];
    byKey: Map<string, ParsedEntry[]>;
};

function parseEnvFile(filePath: string): ParsedEnv {
    const abs = path.resolve(filePath);
    const text = fs.readFileSync(abs, "utf8");
    const lines = text.split(/\r?\n/);

    const entries: ParsedEntry[] = [];
    const byKey = new Map<string, ParsedEntry[]>();

    for (let idx = 0; idx < lines.length; idx++) {
        const rawLine = lines[idx] ?? "";
        const lineNo = idx + 1;
        const trimmed = rawLine.trim();

        if (!trimmed) continue;
        if (trimmed.startsWith("#")) continue;

        // Support optional leading "export "
        const exportPrefix = trimmed.startsWith("export ") ? "export " : "";
        const content = exportPrefix ? trimmed.slice(exportPrefix.length) : trimmed;

        const eqIndex = content.indexOf("=");
        if (eqIndex <= 0) continue; // ignore malformed lines gracefully

        const key = content.slice(0, eqIndex).trim();
        let value = content.slice(eqIndex + 1);

        // Remove inline comments only if unquoted and preceded by whitespace
        value = stripInlineComment(value).trim();

        // Strip surrounding quotes
        value = unquote(value);

        if (!key) continue;

        const entry: ParsedEntry = {
            key,
            value,
            raw: rawLine,
            line: lineNo,
        };

        entries.push(entry);

        const arr = byKey.get(key);
        if (arr) arr.push(entry);
        else byKey.set(key, [entry]);
    }

    return { entries, byKey };
}

function stripInlineComment(value: string): string {
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < value.length; i++) {
        const ch = value[i] ?? "";

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === "\\") {
            escaped = true;
            continue;
        }

        if (!inDouble && ch === "'") {
            inSingle = !inSingle;
            continue;
        }

        if (!inSingle && ch === '"') {
            inDouble = !inDouble;
            continue;
        }

        if (!inSingle && !inDouble && ch === "#") {
            const prev = i > 0 ? (value[i - 1] ?? "") : "";
            if (i === 0 || /\s/.test(prev)) {
                return value.slice(0, i);
            }
        }
    }

    return value;
}

function unquote(v: string): string {
    if (v.length >= 2) {
        const first = v[0];
        const last = v[v.length - 1];
        if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
            return v.slice(1, -1);
        }
    }
    return v;
}

function firstEntry(map: Map<string, ParsedEntry[]>, key: string): ParsedEntry | undefined {
    const arr = map.get(key);
    return arr && arr.length > 0 ? arr[0] : undefined;
}

function lastValue(map: Map<string, ParsedEntry[]>, key: string): string | undefined {
    const arr = map.get(key);
    if (!arr || arr.length === 0) return undefined;
    const last = arr[arr.length - 1];
    return last ? last.value : undefined;
}

function parseBool(v: string | undefined): boolean | undefined {
    if (v == null) return undefined;
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
    return undefined;
}

function parseNum(v: string | undefined): number | undefined {
    if (v == null || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function pushIssue(
    issues: Issue[],
    input: {
        severity: Severity;
        code: string;
        message: string;
        key?: string;
        line?: number | undefined;
        details?: Record<string, unknown>;
    }
): void {
    const issue: Issue = {
        severity: input.severity,
        code: input.code,
        message: input.message,
    };

    if (input.key !== undefined) issue.key = input.key;
    if (input.line !== undefined) issue.line = input.line;
    if (input.details !== undefined) issue.details = input.details;

    issues.push(issue);
}

function lintEnv(parsed: ParsedEnv): Issue[] {
    const issues: Issue[] = [];
    const map = parsed.byKey;

    const lineOf = (key: string): number | undefined => firstEntry(map, key)?.line;
    const val = (key: string): string | undefined => lastValue(map, key);
    const boolVal = (key: string): boolean | undefined => parseBool(val(key));
    const numVal = (key: string): number | undefined => parseNum(val(key));

    // 1) Duplicate key definitions (last one wins)
    for (const [key, entries] of map.entries()) {
        if (entries.length > 1) {
            pushIssue(issues, {
                severity: "warn",
                code: "DUPLICATE_KEY",
                message: `Key "${key}" is defined ${entries.length} times (last one wins).`,
                key,
                line: entries[0]?.line,
                details: {
                    lines: entries.map((e) => e.line),
                    lastValue: entries[entries.length - 1]?.value,
                },
            });
        }
    }

    // 2) Production localhost safety overlaps
    const nodeEnv = (val("NODE_ENV") ?? "").trim().toLowerCase();
    const botLocalOnly = boolVal("BOT_LOCAL_ONLY");
    const botAllowRemote = boolVal("BOT_ALLOW_REMOTE");
    const safetySkipRemotePolicy = boolVal("SAFETY_SKIP_REMOTE_POLICY");

    if (nodeEnv === "production") {
        if (botLocalOnly === false) {
            pushIssue(issues, {
                severity: "error",
                code: "PROD_LOCAL_ONLY_DISABLED",
                message: "NODE_ENV=production with BOT_LOCAL_ONLY=false conflicts with localhost-only production policy.",
                key: "BOT_LOCAL_ONLY",
                line: lineOf("BOT_LOCAL_ONLY"),
            });
        }

        if (botAllowRemote === true) {
            pushIssue(issues, {
                severity: "error",
                code: "PROD_REMOTE_ENABLED",
                message: "NODE_ENV=production with BOT_ALLOW_REMOTE=true is a dangerous remote exposure override.",
                key: "BOT_ALLOW_REMOTE",
                line: lineOf("BOT_ALLOW_REMOTE"),
            });
        }

        if (safetySkipRemotePolicy === true) {
            pushIssue(issues, {
                severity: "warn",
                code: "REMOTE_POLICY_SKIPPED",
                message: "SAFETY_SKIP_REMOTE_POLICY=true bypasses remote access policy enforcement.",
                key: "SAFETY_SKIP_REMOTE_POLICY",
                line: lineOf("SAFETY_SKIP_REMOTE_POLICY"),
            });
        }
    }

    // 3) Mainnet live trading ack overlaps
    const xrplNetwork = (val("XRPL_NETWORK") ?? "").trim().toLowerCase();
    const paperTrading = boolVal("PAPER_TRADING");
    const mainnetAck = boolVal("MAINNET_LIVE_TRADING_ACK");
    const safetySkipMainnetAck = boolVal("SAFETY_SKIP_MAINNET_ACK");

    if (xrplNetwork === "mainnet" && paperTrading === false) {
        if (mainnetAck !== true) {
            pushIssue(issues, {
                severity: "error",
                code: "MAINNET_LIVE_ACK_MISSING",
                message: "XRPL_NETWORK=mainnet and PAPER_TRADING=false requires MAINNET_LIVE_TRADING_ACK=true (or lock file path workflow).",
                key: "MAINNET_LIVE_TRADING_ACK",
                line: lineOf("MAINNET_LIVE_TRADING_ACK"),
            });
        }

        if (safetySkipMainnetAck === true) {
            pushIssue(issues, {
                severity: "warn",
                code: "MAINNET_ACK_BYPASSED",
                message: "SAFETY_SKIP_MAINNET_ACK=true bypasses mainnet live-trading acknowledgement enforcement.",
                key: "SAFETY_SKIP_MAINNET_ACK",
                line: lineOf("SAFETY_SKIP_MAINNET_ACK"),
            });
        }
    }

    // 4) Issuer overlap / conflicts (legacy + per-asset)
    const tradeBaseCurrency = (val("TRADE_BASE_CURRENCY") ?? "").trim().toUpperCase();
    const tradeQuoteCurrency = (val("TRADE_QUOTE_CURRENCY") ?? "").trim().toUpperCase();
    const tradeIssuer = val("TRADE_ISSUER");
    const tradeBaseIssuer = val("TRADE_BASE_ISSUER");
    const tradeQuoteIssuer = val("TRADE_QUOTE_ISSUER");

    if (tradeIssuer && (tradeBaseIssuer || tradeQuoteIssuer)) {
        pushIssue(issues, {
            severity: "warn",
            code: "LEGACY_AND_PER_ASSET_ISSUER_BOTH_SET",
            message: "TRADE_ISSUER is set alongside TRADE_BASE_ISSUER/TRADE_QUOTE_ISSUER. Per-asset issuers should be the source of truth.",
            key: "TRADE_ISSUER",
            line: lineOf("TRADE_ISSUER"),
            details: {
                tradeIssuer,
                tradeBaseIssuer,
                tradeQuoteIssuer,
            },
        });
    }

    if (tradeBaseCurrency === "XRP" && tradeBaseIssuer && tradeBaseIssuer.trim() !== "") {
        pushIssue(issues, {
            severity: "error",
            code: "XRP_BASE_SHOULD_NOT_HAVE_ISSUER",
            message: "TRADE_BASE_CURRENCY=XRP must not have TRADE_BASE_ISSUER.",
            key: "TRADE_BASE_ISSUER",
            line: lineOf("TRADE_BASE_ISSUER"),
        });
    }

    if (tradeQuoteCurrency === "XRP" && tradeQuoteIssuer && tradeQuoteIssuer.trim() !== "") {
        pushIssue(issues, {
            severity: "error",
            code: "XRP_QUOTE_SHOULD_NOT_HAVE_ISSUER",
            message: "TRADE_QUOTE_CURRENCY=XRP must not have TRADE_QUOTE_ISSUER.",
            key: "TRADE_QUOTE_ISSUER",
            line: lineOf("TRADE_QUOTE_ISSUER"),
        });
    }

    // 5) Execution min-order sanity overlaps (matches your bot feature intent)
    const featureMinOrderSanity = boolVal("FEATURE_EXECUTION_MIN_ORDER_SANITY");
    const execMinBase = numVal("EXECUTION_MIN_BASE_XRP");
    const execMinQuote = numVal("EXECUTION_MIN_QUOTE_RLUSD");

    if (featureMinOrderSanity === true) {
        if (execMinBase === undefined || execMinBase <= 0) {
            pushIssue(issues, {
                severity: "warn",
                code: "MIN_ORDER_SANITY_NO_MIN_BASE",
                message: "FEATURE_EXECUTION_MIN_ORDER_SANITY=true but EXECUTION_MIN_BASE_XRP is missing or non-positive.",
                key: "EXECUTION_MIN_BASE_XRP",
                line: lineOf("EXECUTION_MIN_BASE_XRP"),
            });
        }

        if (execMinQuote === undefined || execMinQuote <= 0) {
            pushIssue(issues, {
                severity: "warn",
                code: "MIN_ORDER_SANITY_NO_MIN_QUOTE",
                message: "FEATURE_EXECUTION_MIN_ORDER_SANITY=true but EXECUTION_MIN_QUOTE_RLUSD is missing or non-positive.",
                key: "EXECUTION_MIN_QUOTE_RLUSD",
                line: lineOf("EXECUTION_MIN_QUOTE_RLUSD"),
            });
        }
    } else if (featureMinOrderSanity === false) {
        if (execMinBase !== undefined) {
            pushIssue(issues, {
                severity: "info",
                code: "MIN_BASE_SET_WHILE_SANITY_DISABLED",
                message: "EXECUTION_MIN_BASE_XRP is set but FEATURE_EXECUTION_MIN_ORDER_SANITY=false.",
                key: "EXECUTION_MIN_BASE_XRP",
                line: lineOf("EXECUTION_MIN_BASE_XRP"),
            });
        }

        if (execMinQuote !== undefined) {
            pushIssue(issues, {
                severity: "info",
                code: "MIN_QUOTE_SET_WHILE_SANITY_DISABLED",
                message: "EXECUTION_MIN_QUOTE_RLUSD is set but FEATURE_EXECUTION_MIN_ORDER_SANITY=false.",
                key: "EXECUTION_MIN_QUOTE_RLUSD",
                line: lineOf("EXECUTION_MIN_QUOTE_RLUSD"),
            });
        }
    }

    // 6) Boolean-as-number feature flags (0/1) informational notes
    for (const key of ["FEATURE_AUDIT_GUARDS", "FEATURE_STRICT_CONFIG", "FEATURE_EXEC_TELEMETRY"]) {
        const v = val(key);
        if (v !== undefined && !["0", "1", "true", "false"].includes(v.trim().toLowerCase())) {
            pushIssue(issues, {
                severity: "warn",
                code: "NONSTANDARD_BOOL_FLAG_VALUE",
                message: `${key} uses a nonstandard boolean-like value "${v}". Prefer 0/1 or true/false.`,
                key,
                line: lineOf(key),
            });
        }
    }

    // 7) Suspicious time unit mismatch (your file has SNAPSHOT_FLUSH_INTERVAL=5 with comment saying ms/seconds ambiguity)
    const snapshotFlush = numVal("SNAPSHOT_FLUSH_INTERVAL");
    if (snapshotFlush !== undefined && snapshotFlush > 0 && snapshotFlush < 100) {
        pushIssue(issues, {
            severity: "warn",
            code: "POSSIBLE_TIME_UNIT_MISMATCH",
            message:
                "SNAPSHOT_FLUSH_INTERVAL is very small. Check whether code expects ms vs seconds (comment suggests interval semantics may be ambiguous).",
            key: "SNAPSHOT_FLUSH_INTERVAL",
            line: lineOf("SNAPSHOT_FLUSH_INTERVAL"),
            details: { snapshotFlush },
        });
    }

    // 8) Informational strictness notes
    if (val("FEATURE_AUDIT_GUARDS") === "0") {
        pushIssue(issues, {
            severity: "info",
            code: "AUDIT_GUARDS_DISABLED",
            message: "FEATURE_AUDIT_GUARDS=0 (audit guards disabled).",
            key: "FEATURE_AUDIT_GUARDS",
            line: lineOf("FEATURE_AUDIT_GUARDS"),
        });
    }

    if (val("FEATURE_STRICT_CONFIG") === "0") {
        pushIssue(issues, {
            severity: "info",
            code: "STRICT_CONFIG_DISABLED",
            message: "FEATURE_STRICT_CONFIG=0 (strict config validation disabled).",
            key: "FEATURE_STRICT_CONFIG",
            line: lineOf("FEATURE_STRICT_CONFIG"),
        });
    }

    return issues;
}

function printIssues(filePath: string, issues: Issue[]): void {
    const sevRank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

    issues.sort((a, b) => {
        const s = sevRank[a.severity] - sevRank[b.severity];
        if (s !== 0) return s;
        const la = a.line ?? Number.MAX_SAFE_INTEGER;
        const lb = b.line ?? Number.MAX_SAFE_INTEGER;
        if (la !== lb) return la - lb;
        return a.code.localeCompare(b.code);
    });

    const errors = issues.filter((i) => i.severity === "error").length;
    const warns = issues.filter((i) => i.severity === "warn").length;
    const infos = issues.filter((i) => i.severity === "info").length;

    console.log(`\nENV lint report: ${filePath}`);
    console.log(`Issues: ${errors} error(s), ${warns} warning(s), ${infos} info\n`);

    for (const i of issues) {
        const loc = i.line !== undefined ? `line ${i.line}` : "line ?";
        const key = i.key ? ` [${i.key}]` : "";
        console.log(`${i.severity.toUpperCase()} ${i.code} (${loc})${key}: ${i.message}`);
        if (i.details) {
            console.log(`  details: ${JSON.stringify(i.details)}`);
        }
    }
}

function main(): void {
    const filePath = process.argv[2] ?? ".env";

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(2);
    }

    const parsed = parseEnvFile(filePath);
    const issues = lintEnv(parsed);

    printIssues(filePath, issues);

    const hasError = issues.some((i) => i.severity === "error");
    process.exit(hasError ? 1 : 0);
}

main();