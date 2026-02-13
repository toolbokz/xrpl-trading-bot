import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('UI polling dedupe guards', () => {
    it('uses a single runtime cache source from page composition', () => {
        const pagePath = join(process.cwd(), 'src/ui/app/page.tsx');
        const content = readFileSync(pagePath, 'utf8');

        const runtimeCacheHookCalls = content.match(/useRuntimeCache\(/g) ?? [];
        const runtimeCacheProviderCalls = content.match(/RuntimeCacheProvider/g) ?? [];

        expect(runtimeCacheHookCalls.length).toBe(1);
        expect(runtimeCacheProviderCalls.length).toBeGreaterThanOrEqual(1);
        expect(content.includes('/api/bot/cache')).toBe(false);
    });

    it('routes runtime events through shared page store instead of duplicate toast poller', () => {
        const pagePath = join(process.cwd(), 'src/ui/app/page.tsx');
        const toastPath = join(process.cwd(), 'src/ui/components/TradeToasts/ToastContainer.tsx');

        const pageContent = readFileSync(pagePath, 'utf8');
        const toastContent = readFileSync(toastPath, 'utf8');

        const runtimeEventHookCalls = pageContent.match(/useRuntimeEvents\(/g) ?? [];

        expect(runtimeEventHookCalls.length).toBe(1);
        expect(toastContent.includes('/api/runtime/events')).toBe(false);
    });
});
