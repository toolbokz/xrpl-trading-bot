'use client';

import { useMemo } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { TradingPair } from '../lib/tradingPairs';

interface CompactPairSelectorProps {
    pairs: readonly TradingPair[];
    selectedKey: string;
    onChange: (key: string) => void;
    className?: string;
}

export function CompactPairSelector({
    pairs,
    selectedKey,
    onChange,
    className,
}: CompactPairSelectorProps) {
    const selectedPair = useMemo(() => pairs.find((p) => p.key === selectedKey), [pairs, selectedKey]);

    return (
        <div className={clsx('relative', className)}>
            <select
                value={selectedKey}
                onChange={(e) => onChange(e.target.value)}
                className="w-full appearance-none rounded-xl bg-slate-900/80 border border-white/10 pl-3 pr-8 py-2 text-sm text-slate-100 font-medium focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
            >
                <option value="" disabled>Select pair...</option>
                {pairs.map((pair) => (
                    <option key={pair.key} value={pair.key}>
                        {pair.key}
                    </option>
                ))}
            </select>
            <ChevronDown
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            {selectedPair && (
                <div className="absolute -bottom-4 left-0 text-[10px] text-slate-500 truncate max-w-full">
                    {selectedPair.description}
                </div>
            )}
        </div>
    );
}
