import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { type DB, openStore } from './db';
import {
    appendEvent,
    ensureWorkspace,
    listItems,
    putItem,
    searchItems,
    setItemStatus,
    stats,
    supersede,
    toFtsQuery,
    touchItems,
    upsertSession,
} from './store';

let db: DB;

beforeEach(() => {
    db = openStore({ path: ':memory:', fresh: true });
});

afterEach(() => {
    db.close();
});

describe('workspaces', () => {
    test('ensureWorkspace is idempotent and stable', () => {
        const a = ensureWorkspace(db, process.cwd());
        const b = ensureWorkspace(db, process.cwd());
        expect(a.id).toBe(b.id);
        expect(stats(db).workspaces).toBe(1);
    });
});

describe('sessions', () => {
    test('upsert converges on (agent, harness_session_id)', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const first = upsertSession(db, {
            agent: 'claude',
            harness_session_id: 'abc',
            workspace_id: ws.id,
            cwd: process.cwd(),
        });
        const second = upsertSession(db, {
            agent: 'claude',
            harness_session_id: 'abc',
            workspace_id: ws.id,
            cwd: process.cwd(),
            model: 'opus',
            transcript_path: '/tmp/t.jsonl',
        });
        expect(second.id).toBe(first.id);
        expect(second.model).toBe('opus');
        expect(second.transcript_path).toBe('/tmp/t.jsonl');
    });

    test('the same harness id under a different agent is a different session', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const claude = upsertSession(db, { agent: 'claude', harness_session_id: 'x', workspace_id: ws.id, cwd: '/tmp' });
        const codex = upsertSession(db, { agent: 'codex', harness_session_id: 'x', workspace_id: ws.id, cwd: '/tmp' });
        expect(claude.id).not.toBe(codex.id);
    });

    test('coalesce does not clobber known values with nulls', () => {
        const ws = ensureWorkspace(db, process.cwd());
        upsertSession(db, {
            agent: 'codex',
            harness_session_id: 's1',
            workspace_id: ws.id,
            cwd: '/tmp',
            git_branch: 'main',
        });
        const after = upsertSession(db, { agent: 'codex', harness_session_id: 's1', workspace_id: ws.id, cwd: '/tmp' });
        expect(after.git_branch).toBe('main');
    });
});

describe('items', () => {
    const draft = (over: Partial<Parameters<typeof putItem>[1]> = {}) => ({
        type: 'decision' as const,
        title: 'Use bun:sqlite rather than better-sqlite3',
        body: 'bun:sqlite ships with the runtime, so hooks have no native build step.',
        source: 'test',
        ...over,
    });

    test('identical content reinforces instead of duplicating', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const a = putItem(db, { ...draft(), workspace_id: ws.id });
        const b = putItem(db, { ...draft(), workspace_id: ws.id });
        expect(a.created).toBe(true);
        expect(b.created).toBe(false);
        expect(b.reinforced).toBe(true);
        expect(b.item.id).toBe(a.item.id);
        expect(b.item.confidence).toBeGreaterThan(a.item.confidence);
        expect(listItems(db, { workspace_id: ws.id })).toHaveLength(1);
    });

    test('reworded-but-identical content collapses via normalised hashing', () => {
        const ws = ensureWorkspace(db, process.cwd());
        putItem(db, { ...draft(), workspace_id: ws.id });
        const second = putItem(db, {
            ...draft({ title: 'Use bun:sqlite, rather than better-sqlite3!' }),
            workspace_id: ws.id,
        });
        expect(second.created).toBe(false);
    });

    test('the same fact in two workspaces stays separate', () => {
        const a = ensureWorkspace(db, process.cwd());
        db.query('INSERT INTO workspaces (id, root, name, created_at) VALUES (?, ?, ?, ?)').run(
            'other',
            '/tmp/other',
            'other',
            Date.now(),
        );
        putItem(db, { ...draft(), workspace_id: a.id });
        const other = putItem(db, { ...draft(), workspace_id: 'other' });
        expect(other.created).toBe(true);
    });

    test('global items are detached from any workspace', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const res = putItem(db, { ...draft({ scope: 'global' }), workspace_id: ws.id });
        expect(res.item.workspace_id).toBeNull();
    });

    test('supersede flips status and records the edge', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const old = putItem(db, { ...draft(), workspace_id: ws.id });
        const next = putItem(db, {
            ...draft({ title: 'Use bun:sqlite everywhere including the dashboard' }),
            workspace_id: ws.id,
        });
        supersede(db, old.item.id, next.item.id);
        const remaining = listItems(db, { workspace_id: ws.id, status: 'active' });
        expect(remaining.map((i) => i.id)).toEqual([next.item.id]);
    });

    test('re-deriving a proposed item does not promote it past review', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const first = putItem(db, { ...draft({ status: 'proposed' }), workspace_id: ws.id });
        expect(first.item.status).toBe('proposed');
        const second = putItem(db, { ...draft({ status: 'proposed' }), workspace_id: ws.id });
        expect(second.reinforced).toBe(true);
        expect(second.item.status).toBe('proposed');
        expect(listItems(db, { workspace_id: ws.id, status: 'active' })).toHaveLength(0);
    });

    test('a rejected item is not resurrected by re-derivation', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const item = putItem(db, { ...draft(), workspace_id: ws.id }).item;
        setItemStatus(db, item.id, 'rejected');
        const again = putItem(db, { ...draft(), workspace_id: ws.id });
        expect(again.item.status).toBe('rejected');
    });

    test('re-derivation raises confidence but not use_count', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const first = putItem(db, { ...draft(), workspace_id: ws.id });
        const second = putItem(db, { ...draft(), workspace_id: ws.id });
        expect(second.item.confidence).toBeGreaterThan(first.item.confidence);
        // use_count means "was recalled", not "was extracted again" — conflating
        // them would let a distiller manufacture evidence for its own output.
        expect(second.item.use_count).toBe(0);
    });

    test('touch reinforces usage counters', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const item = putItem(db, { ...draft(), workspace_id: ws.id }).item;
        touchItems(db, [item.id]);
        const [reloaded] = listItems(db, { workspace_id: ws.id });
        expect(reloaded!.use_count).toBe(1);
        expect(reloaded!.last_used_at).not.toBeNull();
    });
});

describe('search', () => {
    test('finds items by keyword and ranks the closer one first', () => {
        const ws = ensureWorkspace(db, process.cwd());
        putItem(db, {
            type: 'fact',
            title: 'Authentication lives in packages/api/src/auth',
            body: 'Session tokens are minted there.',
            source: 'test',
            workspace_id: ws.id,
        });
        putItem(db, {
            type: 'fact',
            title: 'The dashboard is served by Bun.serve',
            body: 'No bundler is involved in development.',
            source: 'test',
            workspace_id: ws.id,
        });
        const hits = searchItems(db, 'where does authentication live?', { workspace_id: ws.id });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]!.item.title).toContain('Authentication');
    });

    test('hostile FTS syntax in user text does not throw', () => {
        const ws = ensureWorkspace(db, process.cwd());
        putItem(db, { type: 'fact', title: 'A fact about parsing', body: 'body', source: 'test', workspace_id: ws.id });
        for (const q of ['foo: bar', '"unbalanced', 'a AND OR NOT b', '*', '-x', '']) {
            expect(() => searchItems(db, q, { workspace_id: ws.id })).not.toThrow();
        }
    });

    test('toFtsQuery drops stopwords and short tokens', () => {
        expect(toFtsQuery('the and a')).toBeNull();
        expect(toFtsQuery('sqlite recall budget')).toBe('"sqlite" OR "recall" OR "budget"');
    });
});

describe('events', () => {
    test('append and count', () => {
        const ws = ensureWorkspace(db, process.cwd());
        const session = upsertSession(db, {
            agent: 'claude',
            harness_session_id: 'e1',
            workspace_id: ws.id,
            cwd: process.cwd(),
        });
        appendEvent(db, { session_id: session.id, workspace_id: ws.id, kind: 'prompt', payload: { prompt: 'hi' } });
        expect(stats(db, ws.id).events).toBe(1);
    });
});
