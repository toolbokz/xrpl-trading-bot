'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Settings, Save, RotateCcw, ChevronDown, ChevronRight, AlertTriangle, Check, Loader2, Power } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types mirrored from the API route
// ---------------------------------------------------------------------------

interface EnvSettingMeta {
    key: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    value: string;
    commented: boolean;
    readOnly: boolean;
}

interface EnvGroup {
    id: string;
    label: string;
    settings: EnvSettingMeta[];
}

interface EnvSettingsResponse {
    groups: EnvGroup[];
    filePath: string;
    requestId: string;
}

interface SaveResult {
    ok: boolean;
    applied: string[];
    blocked: string[];
    message: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdvancedPanel() {
    const [groups, setGroups] = useState<EnvGroup[]>([]);
    const [envFilePath, setEnvFilePath] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Tracks which groups are expanded
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // Tracks local edits: key → new value
    const [edits, setEdits] = useState<Map<string, string>>(new Map());
    // Save state
    const [saving, setSaving] = useState(false);
    const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
    // Search filter
    const [search, setSearch] = useState('');
    // Restart state
    const [restarting, setRestarting] = useState(false);
    const [restartConfirm, setRestartConfirm] = useState(false);
    const [restartMessage, setRestartMessage] = useState<{ ok: boolean; text: string } | null>(null);

    const pendingCount = edits.size;

    const fetchSettings = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/bot/env-settings');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: EnvSettingsResponse = await res.json();
            setGroups(data.groups);
            setEnvFilePath(data.filePath);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    const toggleGroup = (id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const expandAll = () => setExpanded(new Set(groups.map((g) => g.id)));
    const collapseAll = () => setExpanded(new Set());

    const handleEdit = (key: string, value: string, originalValue: string) => {
        setEdits((prev) => {
            const next = new Map(prev);
            if (value === originalValue) {
                next.delete(key);
            } else {
                next.set(key, value);
            }
            return next;
        });
        setSaveResult(null);
    };

    const handleDiscard = () => {
        setEdits(new Map());
        setSaveResult(null);
    };

    const handleSave = async () => {
        if (edits.size === 0) return;
        setSaving(true);
        setSaveResult(null);
        try {
            const changes: Record<string, string> = {};
            edits.forEach((val, key) => { changes[key] = val; });

            const res = await fetch('/api/bot/env-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ changes }),
            });
            const raw = await res.json();
            const data: SaveResult = res.ok
                ? raw
                : { ok: false, applied: [], blocked: [], message: raw?.error || `HTTP ${res.status}` };
            setSaveResult(data);
            if (data.ok) {
                setEdits(new Map());
                // Refresh to get updated values
                await fetchSettings();
            }
        } catch (err) {
            setSaveResult({ ok: false, applied: [], blocked: [], message: (err as Error).message });
        } finally {
            setSaving(false);
        }
    };

    const handleRestart = async () => {
        setRestarting(true);
        setRestartConfirm(false);
        setRestartMessage(null);
        try {
            // Step 1: Kill the bot
            const killRes = await fetch('/api/bot/kill', { method: 'POST' });
            const killData = await killRes.json();
            if (!killRes.ok) {
                throw new Error(killData?.error || 'Failed to stop bot');
            }

            // Step 2: Brief pause for cleanup
            await new Promise((r) => setTimeout(r, 2000));

            // Step 3: Start the bot
            const runRes = await fetch('/api/bot/run', { method: 'POST' });
            const runData = await runRes.json();
            if (!runRes.ok) {
                throw new Error(runData?.error || 'Failed to start bot');
            }

            setRestartMessage({ ok: true, text: `Bot restarted successfully (${runData.state || 'RUNNING'}). New settings are now active.` });
        } catch (err) {
            setRestartMessage({ ok: false, text: `Restart failed: ${(err as Error).message}` });
        } finally {
            setRestarting(false);
        }
    };

    // Filter groups/settings by search term
    const filteredGroups = groups
        .map((g) => ({
            ...g,
            settings: g.settings.filter((s) => {
                if (!search) return true;
                const q = search.toLowerCase();
                return (
                    s.key.toLowerCase().includes(q) ||
                    s.description.toLowerCase().includes(q) ||
                    s.value.toLowerCase().includes(q)
                );
            }),
        }))
        .filter((g) => g.settings.length > 0);

    // ── Render ───────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16 text-slate-500">
                <Loader2 className="animate-spin mr-2" size={16} />
                Loading settings…
            </div>
        );
    }

    if (error) {
        return (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
                <AlertTriangle size={14} className="inline mr-1" />
                Failed to load settings: {error}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Header bar */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                    <Settings size={14} />
                    <span className="font-medium text-slate-300">Environment Settings</span>
                    <span className="text-xs text-slate-500 hidden sm:inline">— {envFilePath}</span>
                </div>

                <div className="ml-auto flex items-center gap-2">
                    <input
                        type="text"
                        placeholder="Search settings…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="rounded border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-sky-500/40 w-44"
                    />
                    <button
                        onClick={expandAll}
                        className="rounded border border-white/10 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-white/5"
                    >
                        Expand all
                    </button>
                    <button
                        onClick={collapseAll}
                        className="rounded border border-white/10 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-white/5"
                    >
                        Collapse
                    </button>
                </div>
            </div>

            {/* Pending changes bar */}
            {pendingCount > 0 && (
                <div className="flex items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2 text-sm">
                    <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                    <span className="text-amber-300">
                        {pendingCount} unsaved change{pendingCount > 1 ? 's' : ''}
                    </span>
                    <div className="ml-auto flex gap-2">
                        <button
                            onClick={handleDiscard}
                            className="flex items-center gap-1 rounded border border-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/5"
                        >
                            <RotateCcw size={12} /> Discard
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/20 px-3 py-1 text-xs text-sky-300 hover:bg-sky-500/30 disabled:opacity-50"
                        >
                            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                            Save &amp; write .env
                        </button>
                    </div>
                </div>
            )}

            {/* Save result */}
            {saveResult && (
                <div
                    className={clsx(
                        'rounded-lg border px-4 py-2 text-sm',
                        saveResult.ok
                            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                            : 'border-red-500/20 bg-red-500/5 text-red-300',
                    )}
                >
                    {saveResult.ok ? <Check size={14} className="inline mr-1" /> : <AlertTriangle size={14} className="inline mr-1" />}
                    {saveResult.message}
                    {(saveResult.blocked?.length ?? 0) > 0 && (
                        <span className="ml-2 text-xs text-slate-400">
                            (blocked: {saveResult.blocked!.join(', ')})
                        </span>
                    )}
                </div>
            )}

            {/* Groups — 3-column grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {filteredGroups.map((group) => {
                    const isExpanded = expanded.has(group.id);
                    const groupHasEdits = group.settings.some((s) => edits.has(s.key));
                    return (
                        <div
                            key={group.id}
                            className={clsx(
                                'rounded-lg border flex flex-col',
                                groupHasEdits ? 'border-amber-500/20' : 'border-white/[0.06]',
                            )}
                        >
                            <button
                                onClick={() => toggleGroup(group.id)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02]"
                            >
                                {isExpanded ? (
                                    <ChevronDown size={13} className="text-slate-500 shrink-0" />
                                ) : (
                                    <ChevronRight size={13} className="text-slate-500 shrink-0" />
                                )}
                                <span className="text-xs font-medium text-slate-200 truncate">{group.label}</span>
                                <span className="text-[10px] text-slate-500 shrink-0">{group.settings.length}</span>
                                {groupHasEdits && (
                                    <span className="ml-auto rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] text-amber-300 shrink-0">
                                        modified
                                    </span>
                                )}
                            </button>

                            {isExpanded && (
                                <div className="border-t border-white/[0.04] px-3 pb-3 pt-2 space-y-2.5 flex-1">
                                    {group.settings.map((setting) => (
                                        <SettingRow
                                            key={setting.key}
                                            setting={setting}
                                            editValue={edits.get(setting.key)}
                                            onEdit={(val) => handleEdit(setting.key, val, setting.value)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {filteredGroups.length === 0 && (
                <div className="py-8 text-center text-sm text-slate-500">
                    No settings match &ldquo;{search}&rdquo;
                </div>
            )}

            {/* Restart section */}
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 space-y-3">
                <div className="flex items-center justify-between gap-4">
                    <div className="text-xs text-slate-500">
                        <AlertTriangle size={12} className="inline mr-1 text-amber-500/60" />
                        Changes are written to the <code className="text-slate-400">.env</code> file.
                        The bot must be restarted for changes to take effect.
                    </div>

                    {!restartConfirm ? (
                        <button
                            onClick={() => setRestartConfirm(true)}
                            disabled={restarting || pendingCount > 0}
                            className={clsx(
                                'flex items-center gap-1.5 rounded-md border px-4 py-2 text-xs font-medium whitespace-nowrap transition-colors',
                                pendingCount > 0
                                    ? 'border-white/5 text-slate-600 cursor-not-allowed'
                                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20',
                                restarting && 'opacity-50 cursor-not-allowed',
                            )}
                            title={pendingCount > 0 ? 'Save your changes before restarting' : 'Restart bot to apply .env changes'}
                        >
                            {restarting ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                            {restarting ? 'Restarting…' : 'Restart Bot'}
                        </button>
                    ) : (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-amber-300">Restart now?</span>
                            <button
                                onClick={handleRestart}
                                className="flex items-center gap-1 rounded border border-red-500/30 bg-red-500/15 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/25"
                            >
                                <Power size={12} /> Yes, restart
                            </button>
                            <button
                                onClick={() => setRestartConfirm(false)}
                                className="rounded border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </div>

                {restartMessage && (
                    <div
                        className={clsx(
                            'rounded-md border px-3 py-2 text-xs',
                            restartMessage.ok
                                ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                                : 'border-red-500/20 bg-red-500/5 text-red-300',
                        )}
                    >
                        {restartMessage.ok ? <Check size={12} className="inline mr-1" /> : <AlertTriangle size={12} className="inline mr-1" />}
                        {restartMessage.text}
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Per-setting row
// ---------------------------------------------------------------------------

function SettingRow({
    setting,
    editValue,
    onEdit,
}: {
    setting: EnvSettingMeta;
    editValue: string | undefined;
    onEdit: (value: string) => void;
}) {
    const currentValue = editValue ?? setting.value;
    const isModified = editValue !== undefined;

    if (setting.type === 'boolean') {
        const boolVal = currentValue === 'true';
        return (
            <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <code className="text-xs text-sky-400/80 shrink-0">{setting.key}</code>
                        {setting.readOnly && (
                            <span className="rounded bg-white/5 px-1 py-0.5 text-[9px] text-slate-500 uppercase">read-only</span>
                        )}
                        {isModified && (
                            <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] text-amber-300">changed</span>
                        )}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">{setting.description}</p>
                </div>
                <button
                    disabled={setting.readOnly}
                    onClick={() => onEdit(boolVal ? 'false' : 'true')}
                    className={clsx(
                        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                        setting.readOnly && 'opacity-40 cursor-not-allowed',
                        boolVal ? 'bg-sky-500/60' : 'bg-white/10',
                    )}
                >
                    <span
                        className={clsx(
                            'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
                            boolVal ? 'translate-x-[18px]' : 'translate-x-[3px]',
                        )}
                    />
                </button>
            </div>
        );
    }

    return (
        <div>
            <div className="flex items-center gap-2 mb-1">
                <code className="text-xs text-sky-400/80">{setting.key}</code>
                {setting.readOnly && (
                    <span className="rounded bg-white/5 px-1 py-0.5 text-[9px] text-slate-500 uppercase">read-only</span>
                )}
                {isModified && (
                    <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] text-amber-300">changed</span>
                )}
            </div>
            <p className="text-[11px] text-slate-500 mb-1">{setting.description}</p>
            <input
                type={setting.type === 'number' ? 'number' : 'text'}
                step={setting.type === 'number' ? 'any' : undefined}
                value={currentValue}
                disabled={setting.readOnly}
                onChange={(e) => onEdit(e.target.value)}
                className={clsx(
                    'w-full rounded border bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-200 outline-none transition-colors',
                    'focus:border-sky-500/40 focus:bg-white/[0.05]',
                    setting.readOnly
                        ? 'border-white/5 text-slate-500 cursor-not-allowed'
                        : isModified
                            ? 'border-amber-500/30 bg-amber-500/5'
                            : 'border-white/10',
                )}
            />
        </div>
    );
}
