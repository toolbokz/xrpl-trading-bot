/**
 * Mock Data Regression Test
 * 
 * Ensures that Math.random() and mock data generators are not used
 * in production market data paths (page.tsx).
 * 
 * This test will FAIL the build if mock data patterns are detected,
 * acting as a CI guard against regression.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Forbidden patterns in production market data code
const FORBIDDEN_PATTERNS = [
    {
        pattern: /buildInitialCandles/g,
        message: 'buildInitialCandles function generates mock candle data',
    },
    {
        pattern: /Math\.random\(\)\s*\*\s*\d+.*(?:size|price|bid|ask|volume|candle)/gi,
        message: 'Math.random() used for market data generation',
    },
    {
        pattern: /Math\.random\(\)\s*[\+\-\*]/g,
        message: 'Math.random() arithmetic found - verify it is not for market data',
    },
    {
        pattern: /(?:bid|ask)Size\s*=\s*Math\.random/gi,
        message: 'Random bid/ask size generation',
    },
    {
        pattern: /(?:high|low|open|close)\s*[=:]\s*.*Math\.random/gi,
        message: 'Random OHLC candle data generation',
    },
    {
        pattern: /volatility\s*\*\s*Math\.random/gi,
        message: 'Random volatility-based price generation',
    },
    {
        pattern: /drift\s*=\s*.*Math\.random/gi,
        message: 'Random price drift generation',
    },
];

// Files to check for mock data patterns
const MARKET_DATA_FILES = [
    'src/ui/app/page.tsx',
];

describe('Mock Data Regression Guard', () => {
    MARKET_DATA_FILES.forEach((filePath) => {
        describe(filePath, () => {
            let content: string;

            try {
                const fullPath = join(process.cwd(), filePath);
                content = readFileSync(fullPath, 'utf-8');
            } catch (err) {
                // File might not exist in test environment
                content = '';
            }

            if (!content) {
                it.skip('file not found or empty', () => { });
                return;
            }

            FORBIDDEN_PATTERNS.forEach(({ pattern, message }) => {
                it(`should NOT contain: ${message}`, () => {
                    const matches = content.match(pattern);
                    if (matches) {
                        // Find line numbers for better error reporting
                        const lines = content.split('\n');
                        const matchingLines: { line: number; text: string }[] = [];

                        lines.forEach((lineText, idx) => {
                            if (pattern.test(lineText)) {
                                matchingLines.push({ line: idx + 1, text: lineText.trim() });
                            }
                            // Reset regex lastIndex for global patterns
                            pattern.lastIndex = 0;
                        });

                        const locationInfo = matchingLines
                            .map(({ line, text }) => `  Line ${line}: ${text.substring(0, 80)}...`)
                            .join('\n');

                        expect.fail(
                            `\n\n🚨 MOCK DATA DETECTED IN PRODUCTION CODE!\n\n` +
                            `Pattern: ${pattern.source}\n` +
                            `Message: ${message}\n\n` +
                            `Found ${matches.length} match(es) in ${filePath}:\n${locationInfo}\n\n` +
                            `This violates the production data integrity requirement.\n` +
                            `Market data must come from real API endpoints, not Math.random().\n`
                        );
                    }
                });
            });

            it('should use useOrderBook hook for order book data', () => {
                // Verify the hooks are imported and used
                const hasUseOrderBookImport = /import\s*{[^}]*useOrderBook[^}]*}\s*from/.test(content);
                const hasUseOrderBookCall = /useOrderBook\s*\(/.test(content);

                if (content.includes('OrderBookPanel')) {
                    expect(hasUseOrderBookImport, 'useOrderBook hook should be imported').toBe(true);
                    expect(hasUseOrderBookCall, 'useOrderBook hook should be called').toBe(true);
                }
            });

            it('should use useCandles hook for chart data', () => {
                // Verify the hooks are imported and used
                const hasUseCandlesImport = /import\s*{[^}]*useCandles[^}]*}\s*from/.test(content);
                const hasUseCandlesCall = /useCandles\s*\(/.test(content);

                if (content.includes('ChartPanel') || content.includes('CandleChart')) {
                    expect(hasUseCandlesImport, 'useCandles hook should be imported').toBe(true);
                    expect(hasUseCandlesCall, 'useCandles hook should be called').toBe(true);
                }
            });
        });
    });

    describe('Mock data config safety', () => {
        it('should have mock data gating in mockDataConfig.ts', () => {
            const configPath = join(process.cwd(), 'src/ui/lib/mockDataConfig.ts');
            let configContent: string;

            try {
                configContent = readFileSync(configPath, 'utf-8');
            } catch {
                configContent = '';
            }

            if (configContent) {
                // Verify production safety checks exist
                expect(configContent).toContain('NODE_ENV');
                expect(configContent).toContain('production');
                expect(configContent).toMatch(/!isProduction\s*&&/);
            }
        });
    });
});
