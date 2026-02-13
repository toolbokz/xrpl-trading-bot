import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { RiskStressPanel } from '../RiskStressPanel';

describe('RiskStressPanel', () => {
    it('renders with empty data without crashing', () => {
        const html = renderToString(
            <RiskStressPanel
                data={{
                    adverseRate: null,
                    sampleCount: 0,
                    adverseCount: 0,
                    drawdownPct: null,
                    drawdownVelocity: null,
                    maxDrawdownPct: null,
                }}
                spread={{
                    currentSpreadBps: null,
                    lookback24h: null,
                    baselineMultiDay: null,
                    updatedAtMs: null,
                }}
                loading={false}
                error={null}
            />,
        );

        expect(html).toContain('Risk Stress');
        expect(html).toContain('Spread Distribution Snapshot');
    });
});
