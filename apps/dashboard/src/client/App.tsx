import type { Item } from '@xscs/core';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DashboardState, ItemAction } from '../types';
import { fetchState, resolveConflict, runAction, searchItems } from './api';
import { ItemCard, relativeTime } from './ItemCard';

type Tab = 'review' | 'memory' | 'conflicts' | 'brief' | 'sessions' | 'archive';

export function App(): ReactElement {
    const [state, setState] = useState<DashboardState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>('review');
    const [workspace, setWorkspace] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Item[] | null>(null);

    const reload = useCallback(async () => {
        try {
            const next = await fetchState(workspace);
            setState(next);
            setError(null);
            if (!workspace && next.workspace) setWorkspace(next.workspace.root);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [workspace]);

    useEffect(() => {
        void reload();
    }, [reload]);

    // The review queue is a keyboard task: nobody triages forty items with a mouse.
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
            const map: Record<string, Tab> = { '1': 'review', '2': 'memory', '3': 'conflicts', '4': 'brief', '5': 'sessions' };
            const next = map[e.key];
            if (next) setTab(next);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => {
        if (!query.trim()) {
            setResults(null);
            return;
        }
        const handle = setTimeout(() => {
            void searchItems(workspace, query).then(setResults).catch(() => setResults([]));
        }, 180);
        return () => clearTimeout(handle);
    }, [query, workspace]);

    const act = useCallback(
        async (ids: string[], action: ItemAction) => {
            await runAction(ids, action);
            setSelected(new Set());
            await reload();
        },
        [reload],
    );

    const toggle = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const counts = useMemo(
        () => ({
            review: state?.proposed.length ?? 0,
            memory: state?.active.length ?? 0,
            conflicts: state?.conflicts.length ?? 0,
            archive: state?.archived.length ?? 0,
            sessions: state?.sessions.length ?? 0,
        }),
        [state],
    );

    if (error) {
        return (
            <main>
                <div className="banner">Could not reach the xscs server: {error}</div>
            </main>
        );
    }
    if (!state) return <main className="empty">loading…</main>;

    const visible = results ?? (tab === 'review' ? state.proposed : tab === 'archive' ? state.archived : state.active);

    return (
        <>
            <header className="top">
                <h1>
                    xscs <span>· cross-session context store</span>
                </h1>
                <select
                    value={state.workspace?.root ?? ''}
                    onChange={(e) => {
                        setWorkspace(e.target.value);
                        setSelected(new Set());
                    }}
                >
                    {state.workspaces.map((w) => (
                        <option key={w.id} value={w.root}>
                            {w.name} ({w.active_items})
                        </option>
                    ))}
                </select>
                <span className="grow" />
                <span className="meta">
                    {state.branch ? `branch ${state.branch} · ` : ''}
                    {state.storePath}
                </span>
            </header>

            <main>
                <div className="statgrid">
                    <Stat label="active" value={state.stats.active_items} />
                    <Stat label="proposed" value={counts.review} />
                    <Stat label="pinned" value={state.stats.pinned_items} />
                    <Stat label="open threads" value={state.stats.open_threads} />
                    <Stat label="sessions" value={state.stats.sessions} />
                    <Stat label="brief tokens" value={state.brief.tokens} />
                </div>

                <nav className="tabs">
                    {(
                        [
                            ['review', `review queue`, counts.review],
                            ['memory', 'memory', counts.memory],
                            ['conflicts', 'conflicts', counts.conflicts],
                            ['brief', 'brief preview', null],
                            ['sessions', 'sessions', counts.sessions],
                            ['archive', 'archive', counts.archive],
                        ] as Array<[Tab, string, number | null]>
                    ).map(([id, label, count]) => (
                        <button key={id} aria-selected={tab === id} onClick={() => setTab(id)}>
                            {label}
                            {count !== null ? <span className="count">{count}</span> : null}
                        </button>
                    ))}
                </nav>

                {tab === 'brief' ? (
                    <BriefView state={state} />
                ) : tab === 'conflicts' ? (
                    <ConflictsView state={state} onResolved={reload} />
                ) : tab === 'sessions' ? (
                    <SessionsView state={state} />
                ) : (
                    <>
                        <div className="toolbar">
                            <input
                                type="search"
                                placeholder="search stored context…"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </div>
                        {selected.size > 0 ? (
                            <div className="toolbar">
                                <span className="meta">{selected.size} selected</span>
                                {tab === 'review' ? (
                                    <>
                                        <button className="act primary" onClick={() => act([...selected], 'accept')}>
                                            accept all
                                        </button>
                                        <button className="act danger" onClick={() => act([...selected], 'reject')}>
                                            reject all
                                        </button>
                                    </>
                                ) : (
                                    <button className="act" onClick={() => act([...selected], 'archive')}>
                                        archive all
                                    </button>
                                )}
                                <button className="act danger" onClick={() => act([...selected], 'forget')}>
                                    delete all
                                </button>
                                <button className="act" onClick={() => setSelected(new Set())}>
                                    clear
                                </button>
                            </div>
                        ) : null}

                        {tab === 'review' && !results ? (
                            <div className="banner">
                                Items proposed by distillation stay out of every brief until you accept them. Rejecting is
                                cheap — a wrong memory costs tokens in every future session.
                            </div>
                        ) : null}

                        {visible.length === 0 ? (
                            <p className="empty">
                                {results ? 'no matches' : tab === 'review' ? 'review queue is empty' : 'nothing stored yet'}
                            </p>
                        ) : (
                            visible.map((item) => (
                                <ItemCard
                                    key={item.id}
                                    item={item}
                                    selected={selected.has(item.id)}
                                    onToggle={toggle}
                                    onAction={act}
                                    mode={tab === 'review' ? 'review' : tab === 'archive' ? 'archive' : 'library'}
                                />
                            ))
                        )}
                    </>
                )}
            </main>
        </>
    );
}

function Stat({ label, value }: { label: string; value: number }): ReactElement {
    return (
        <div className="stat">
            <b>{value}</b>
            <span>{label}</span>
        </div>
    );
}

function BriefView({ state }: { state: DashboardState }): ReactElement {
    return (
        <>
            <div className="banner">
                This is exactly what the next cold session in this workspace receives — {state.brief.tokens} tokens,{' '}
                {state.brief.item_ids.length} items, {state.brief.dropped} dropped for budget.
            </div>
            <pre className="brief">{state.brief.text || '(nothing would be injected yet)'}</pre>
        </>
    );
}

function ConflictsView({ state, onResolved }: { state: DashboardState; onResolved: () => void }): ReactElement {
    if (!state.conflicts.length) return <p className="empty">no contradictions or duplicates detected</p>;
    return (
        <>
            <div className="banner">
                Pairs that say overlapping things. Keeping both is how a store starts giving an agent contradictory
                instructions — pick the survivor, or dismiss if they genuinely coexist.
            </div>
            {state.conflicts.map((pair) => (
                <article className="card" key={`${pair.a.id}-${pair.b.id}`}>
                    <header>
                        <span className="tag conflict">{pair.kind}</span>
                        <h3>{pair.hint}</h3>
                        <span className="tag">{Math.round(pair.overlap * 100)}% overlap</span>
                    </header>
                    <div className="pair">
                        {[pair.a, pair.b].map((item, index) => {
                            const other = index === 0 ? pair.b : pair.a;
                            return (
                                <div className="card" key={item.id}>
                                    <header>
                                        <h3>{item.title}</h3>
                                    </header>
                                    <p>{item.body}</p>
                                    <span className="meta">
                                        {item.id} · conf {item.confidence.toFixed(2)} · {relativeTime(item.updated_at)}
                                    </span>
                                    <footer>
                                        <button
                                            className="act primary"
                                            onClick={async () => {
                                                await resolveConflict(item.id, other.id, 'supersede');
                                                onResolved();
                                            }}
                                        >
                                            keep this one
                                        </button>
                                    </footer>
                                </div>
                            );
                        })}
                    </div>
                    <footer>
                        <button
                            className="act"
                            onClick={async () => {
                                await resolveConflict(pair.a.id, pair.b.id, 'dismiss');
                                onResolved();
                            }}
                        >
                            not a conflict
                        </button>
                    </footer>
                </article>
            ))}
        </>
    );
}

function SessionsView({ state }: { state: DashboardState }): ReactElement {
    if (!state.sessions.length) return <p className="empty">no sessions recorded yet</p>;
    return (
        <table>
            <thead>
                <tr>
                    <th>started</th>
                    <th>agent</th>
                    <th>branch</th>
                    <th className="num">prompts</th>
                    <th className="num">turns</th>
                    <th>ended</th>
                    <th>distilled</th>
                </tr>
            </thead>
            <tbody>
                {state.sessions.map((s) => (
                    <tr key={s.id}>
                        <td className="num">{new Date(s.started_at).toLocaleString()}</td>
                        <td>{s.agent}</td>
                        <td>{s.git_branch ?? '—'}</td>
                        <td className="num">{s.prompt_count}</td>
                        <td className="num">{s.turn_count}</td>
                        <td>{s.end_reason ?? 'open'}</td>
                        <td>{s.distilled_at ? relativeTime(s.distilled_at) : 'pending'}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
