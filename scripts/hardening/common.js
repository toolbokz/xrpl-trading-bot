#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parseArgs(argv = process.argv.slice(2)) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const [rawKey, inlineVal] = token.replace(/^--/, '').split('=');
        if (inlineVal !== undefined) {
            args[rawKey] = inlineVal;
            continue;
        }
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[rawKey] = true;
            continue;
        }
        args[rawKey] = next;
        i += 1;
    }
    return args;
}

function nowIso() {
    return new Date().toISOString();
}

function utcDateKey(ms = Date.now()) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return fallback;
    }
}

function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function fetchJson(url, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = { raw: text };
        }
        return { ok: res.ok, status: res.status, data };
    } catch (err) {
        return { ok: false, status: 0, error: err?.message || 'fetch-failed' };
    } finally {
        clearTimeout(timeout);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command) {
    try {
        const stdout = execSync(command, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
        return { ok: true, stdout: stdout.trim() };
    } catch (err) {
        return {
            ok: false,
            stdout: err?.stdout?.toString?.().trim?.() || '',
            stderr: err?.stderr?.toString?.().trim?.() || err?.message || 'command-failed',
        };
    }
}

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

module.exports = {
    parseArgs,
    nowIso,
    utcDateKey,
    ensureDir,
    readJson,
    writeJson,
    fetchJson,
    sleep,
    runCommand,
    toNumber,
};
