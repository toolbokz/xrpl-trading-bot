import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SpreadDistributionPanelContent } from '../SpreadDistributionPanel';

const sampleData = {
    pair: 'XRP/RLUSD',
    updatedAtMs: Date.now(),
    lookback24h: { sampleCount: 120, medianBps: 12.3, p75Bps: 15.4, p90Bps: 18.2 },
    baselineMultiDay: { days: 3, sampleCount: 400, medianBps: 10.1, p75Bps: 14.2, p90Bps: 19.6 },
};

describe('SpreadDistributionPanel', () => {
    it('renders with no data without crashing', () => {
        const html = renderToString(
            <SpreadDistributionPanelContent data={null} loading={false} error={null} />
        );
        expect(html).toContain('Spread Distribution');
    });

    it('renders sample data without crashing', () => {
        const html = renderToString(
            <SpreadDistributionPanelContent data={sampleData} loading={false} error={null} />
        );
        expect(html).toContain('Baseline 3d');
        expect(html).toContain('p90');
    });
});
