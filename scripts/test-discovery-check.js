#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const EXCLUDED_DIR_NAMES = new Set([
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    'out',
    'coverage',
    '.turbo',
    '.cache',
    'tmp',
    'temp',
]);
const TEST_FILE_REGEX = /\.(test|spec)\.tsx?$/;

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

function discoverTests(currentDir, discovered) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) {
            continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            discoverTests(fullPath, discovered);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        if (TEST_FILE_REGEX.test(entry.name)) {
            discovered.push(toPosixPath(path.relative(process.cwd(), fullPath)));
        }
    }
}

function main() {
    if (!fs.existsSync(SOURCE_ROOT)) {
        console.error('Source root not found:', SOURCE_ROOT);
        process.exit(1);
    }

    const discovered = [];
    discoverTests(SOURCE_ROOT, discovered);
    discovered.sort((a, b) => a.localeCompare(b));

    console.log(`Discovered test files (${discovered.length}):`);
    for (const file of discovered) {
        console.log(file);
    }

    const forbidden = discovered.filter((file) => file.includes('/.next/'));
    if (forbidden.length) {
        console.error('\nDiscovery check failed. Unexpected .next tests:');
        for (const file of forbidden) {
            console.error(file);
        }
        process.exit(1);
    }

    if (!discovered.length) {
        console.error('\nDiscovery check failed. No tests matched include patterns.');
        process.exit(1);
    }

    console.log('\nDiscovery check passed.');
}

main();
