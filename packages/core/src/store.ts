import type { DB } from './db';
import { contentHash, newId } from './ids';
import { findWorkspaceRoot, workspaceId as hashWorkspace, workspaceName } from './paths';
import {
    type AgentKind,
    type EventKind,
    type Item,
    ItemDraft,
    type ItemDraftParsed,
    type ItemStatus,
    type ItemType,
    type Session,
    type Workspace,
} from './schema';

interface ItemRow {
    id: string;
    workspace_id: string | null;
    scope: string;
    scope_key: string | null;
    type: string;
    title: string;
    body: string;
    why: string | null;
    status: string;
    confidence: number;
    pinned: number;
    source: string;
    origin_session_id: string | null;
    origin_agent: string | null;
    supersedes: string | null;
    content_hash: string;
    tags: string;
    created_at: number;
    updated_at: number;
    last_used_at: number | null;
    use_count: number;
}

export function rowToItem(row: ItemRow): Item {
    let tags: string[] = [];
    try {
        const parsed: unknown = JSON.parse(row.tags);
        if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
        tags = [];
    }
    return {
        ...row,
        type: row.type as ItemType,
        scope: row.scope as Item['scope'],
        status: row.status as ItemStatus,
        origin_agent: row.origin_agent as AgentKind | null,
        pinned: row.pinned === 1,
        tags,
    };
}

/* ------------------------------------------------------------------ workspaces */

export function ensureWorkspace(db: DB, cwd: string): Workspace {
    const root = findWorkspaceRoot(cwd);
    const id = hashWorkspace(root);
    const existing = db.query<Workspace, [string]>('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (existing) return existing;
    const ws: Workspace = { id, root, name: workspaceName(root), created_at: Date.now() };
    db.query('INSERT OR IGNORE INTO workspaces (id, root, name, created_at) VALUES (?, ?, ?, ?)').run(
        ws.id,
        ws.root,
        ws.name,
        ws.created_at,
    );
    return ws;
}

export function listWorkspaces(db: DB): Workspace[] {
    return db.query<Workspace, []>('SELECT * FROM workspaces ORDER BY name').all();
}

export function findWorkspaceByRootOrName(db: DB, needle: string): Workspace | null {
    return (
        db
            .query<Workspace, [string, string, string]>(
                'SELECT * FROM workspaces WHERE id = ? OR root = ? OR name = ? LIMIT 1',
            )
            .get(needle, needle, needle) ?? null
    );
}

/* -------------------------------------------------------------------- sessions */

export interface SessionUpsert {
    agent: AgentKind;
    harness_session_id: string;
    workspace_id: string;
    cwd: string;
    git_branch?: string | null;
    transcript_path?: string | null;
    model?: string | null;
    title?: string | null;
    source?: string | null;
    parent_session_id?: string | null;
}

/**
 * Idempotent by (agent, harness_session_id). Hooks fire out of order and more
 * than once — a `resume` fires SessionStart on a session we already know — so
 * every write path has to converge rather than duplicate.
 */
export function upsertSession(db: DB, input: SessionUpsert): Session {
    const now = Date.now();
    const id = newId('ses', now);
    // Single atomic statement rather than SELECT-then-INSERT: several hooks from
    // the same session can land concurrently, and a lost race there would drop a
    // session's context permanently. `coalesce(excluded.x, sessions.x)` keeps a
    // later payload that omits a field from clobbering a known value.
    return db
        .query<Session, SessionUpsertParams>(
            `INSERT INTO sessions
                (id, agent, harness_session_id, workspace_id, cwd, git_branch, transcript_path, model, title, source, parent_session_id, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(agent, harness_session_id) DO UPDATE SET
                 cwd               = excluded.cwd,
                 git_branch        = coalesce(excluded.git_branch, sessions.git_branch),
                 transcript_path   = coalesce(excluded.transcript_path, sessions.transcript_path),
                 model             = coalesce(excluded.model, sessions.model),
                 title             = coalesce(excluded.title, sessions.title),
                 source            = coalesce(excluded.source, sessions.source),
                 parent_session_id = coalesce(excluded.parent_session_id, sessions.parent_session_id)
             RETURNING *`,
        )
        .get(
            id,
            input.agent,
            input.harness_session_id,
            input.workspace_id,
            input.cwd,
            input.git_branch ?? null,
            input.transcript_path ?? null,
            input.model ?? null,
            input.title ?? null,
            input.source ?? null,
            input.parent_session_id ?? null,
            now,
        )!;
}

type SessionUpsertParams = [
    string, string, string, string, string,
    string | null, string | null, string | null, string | null, string | null, string | null,
    number,
];

export function getSession(db: DB, id: string): Session | null {
    return db.query<Session, [string]>('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;
}

export function endSession(db: DB, id: string, reason: string): void {
    db.query('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(
        Date.now(),
        reason,
        id,
    );
}

export function bumpSessionCounter(db: DB, id: string, field: 'prompt_count' | 'turn_count'): void {
    db.query(`UPDATE sessions SET ${field} = ${field} + 1 WHERE id = ?`).run(id);
}

export function recentSessions(db: DB, workspace_id: string | null, limit = 20): Session[] {
    if (workspace_id) {
        return db
            .query<Session, [string, number]>(
                'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?',
            )
            .all(workspace_id, limit);
    }
    return db.query<Session, [number]>('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit);
}

/**
 * Atomically take ownership of a session for distillation.
 *
 * `distilled_at` doubles as the lease: setting it in the same statement that
 * checks it means two background processes racing on the same session — which
 * happens routinely, since both SessionEnd and the next SessionStart kick one —
 * cannot both win. The loser gets `false` and skips.
 */
export function claimSessionForDistill(db: DB, session_id: string): boolean {
    return (
        db
            .query('UPDATE sessions SET distilled_at = ? WHERE id = ? AND distilled_at IS NULL')
            .run(Date.now(), session_id).changes > 0
    );
}

/** Release a claim so a failed run can be retried later. */
export function releaseDistillClaim(db: DB, session_id: string): void {
    db.query('UPDATE sessions SET distilled_at = NULL WHERE id = ?').run(session_id);
}

/** Sessions that have finished (or gone quiet) and never been distilled. */
export function pendingDistillSessions(db: DB, idleMs = 5 * 60_000, limit = 25): Session[] {
    const cutoff = Date.now() - idleMs;
    return db
        .query<Session, [number, number]>(
            `SELECT s.* FROM sessions s
             WHERE s.distilled_at IS NULL
               AND (s.ended_at IS NOT NULL OR s.started_at < ?)
               AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)
             ORDER BY s.started_at ASC LIMIT ?`,
        )
        .all(cutoff, limit);
}

export function markDistilled(db: DB, session_id: string): void {
    db.query('UPDATE sessions SET distilled_at = ? WHERE id = ?').run(Date.now(), session_id);
}

/* ---------------------------------------------------------------------- events */

export function appendEvent(
    db: DB,
    input: { session_id: string; workspace_id: string; kind: EventKind; payload: unknown; ts?: number },
): number {
    const res = db
        .query('INSERT INTO events (session_id, workspace_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)')
        .run(input.session_id, input.workspace_id, input.ts ?? Date.now(), input.kind, JSON.stringify(input.payload ?? {}));
    return Number(res.lastInsertRowid);
}

export interface StoredEvent {
    id: number;
    session_id: string;
    workspace_id: string;
    ts: number;
    kind: EventKind;
    payload: unknown;
    consumed_at: number | null;
}

export function sessionEvents(db: DB, session_id: string, limit = 2000): StoredEvent[] {
    const rows = db
        .query<
            { id: number; session_id: string; workspace_id: string; ts: number; kind: string; payload: string; consumed_at: number | null },
            [string, number]
        >('SELECT * FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?')
        .all(session_id, limit);
    return rows.map((r) => ({ ...r, kind: r.kind as EventKind, payload: safeParse(r.payload) }));
}

export function markEventsConsumed(db: DB, session_id: string): void {
    db.query('UPDATE events SET consumed_at = ? WHERE session_id = ? AND consumed_at IS NULL').run(Date.now(), session_id);
}

function safeParse(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return { raw };
    }
}

/* ----------------------------------------------------------------------- items */

export interface PutItemResult {
    item: Item;
    created: boolean;
    /** Set when an existing near-identical item absorbed this write. */
    reinforced: boolean;
}

/**
 * The single write path for durable memory.
 *
 * Duplicate writes are not errors — they are evidence. When the same fact is
 * derived again from a different session it reinforces the existing item
 * (confidence up, use_count up) instead of creating a second row. That is what
 * keeps a store readable after a few hundred sessions.
 */
export function putItem(db: DB, draft: ItemDraft): PutItemResult {
    const parsed: ItemDraftParsed = ItemDraft.parse(draft);
    const now = Date.now();
    const hash = contentHash([parsed.type, parsed.title, parsed.body]);
    const wsId = parsed.scope === 'global' ? null : (parsed.workspace_id ?? null);

    const id = newId('itm', now);

    // Atomic upsert against the dedupe index. On conflict we raise confidence and
    // freshness, and nothing else:
    //   · `status` is untouched — a second derivation of a `proposed` item must
    //     not promote it past human review.
    //   · `use_count` is untouched — it means "was recalled", not "was extracted
    //     again". Conflating the two lets a chatty distiller manufacture evidence
    //     that its own output is valuable.
    //   · `pinned` only ever goes up, since pinning is a human assertion.
    const row = db
        .query<ItemRow, PutItemParams>(
            `INSERT INTO items
                (id, workspace_id, scope, scope_key, type, title, body, why, status, confidence, pinned,
                 source, origin_session_id, origin_agent, supersedes, content_hash, tags, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(content_hash, ifnull(workspace_id,''), scope, ifnull(scope_key,'')) DO UPDATE SET
                 confidence = min(1.0, items.confidence + 0.1),
                 updated_at = excluded.updated_at,
                 pinned     = max(items.pinned, excluded.pinned)
             RETURNING *`,
        )
        .get(
            id,
            wsId,
            parsed.scope,
            parsed.scope_key ?? null,
            parsed.type,
            parsed.title,
            parsed.body,
            parsed.why ?? null,
            parsed.status,
            parsed.confidence,
            parsed.pinned ? 1 : 0,
            parsed.source,
            parsed.origin_session_id ?? null,
            parsed.origin_agent ?? null,
            parsed.supersedes ?? null,
            hash,
            JSON.stringify(parsed.tags),
            now,
            now,
        )!;

    const created = row.id === id;
    if (created && parsed.supersedes) supersede(db, parsed.supersedes, id);
    return { item: rowToItem(row), created, reinforced: !created };
}

type PutItemParams = [
    string, string | null, string, string | null, string, string, string, string | null, string,
    number, number, string, string | null, string | null, string | null, string, string, number, number,
];

export function getItem(db: DB, id: string): Item | null {
    const row = db.query<ItemRow, [string]>('SELECT * FROM items WHERE id = ?').get(id);
    return row ? rowToItem(row) : null;
}

export function supersede(db: DB, oldId: string, newId_: string): void {
    db.query("UPDATE items SET status = 'superseded', updated_at = ? WHERE id = ?").run(Date.now(), oldId);
    addLink(db, newId_, oldId, 'supersedes');
}

export function addLink(db: DB, from_id: string, to_id: string, kind: string, note?: string): void {
    db.query('INSERT OR IGNORE INTO links (from_id, to_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
        from_id,
        to_id,
        kind,
        note ?? null,
        Date.now(),
    );
}

export function linksFor(db: DB, id: string): Array<{ from_id: string; to_id: string; kind: string; note: string | null }> {
    return db
        .query<{ from_id: string; to_id: string; kind: string; note: string | null }, [string, string]>(
            'SELECT from_id, to_id, kind, note FROM links WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC',
        )
        .all(id, id);
}

export interface ListItemsFilter {
    workspace_id?: string | null;
    /** Include items whose scope is `global` regardless of workspace. */
    includeGlobal?: boolean;
    status?: ItemStatus | ItemStatus[];
    type?: ItemType | ItemType[];
    pinned?: boolean;
    limit?: number;
    offset?: number;
}

export function listItems(db: DB, filter: ListItemsFilter = {}): Item[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.workspace_id !== undefined && filter.workspace_id !== null) {
        if (filter.includeGlobal === false) {
            where.push('workspace_id = ?');
            params.push(filter.workspace_id);
        } else {
            where.push('(workspace_id = ? OR workspace_id IS NULL)');
            params.push(filter.workspace_id);
        }
    }
    const statuses = normaliseList(filter.status);
    if (statuses.length) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
    }
    const types = normaliseList(filter.type);
    if (types.length) {
        where.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
    }
    if (filter.pinned !== undefined) {
        where.push('pinned = ?');
        params.push(filter.pinned ? 1 : 0);
    }

    const sql = `SELECT * FROM items
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY pinned DESC, updated_at DESC
        LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 200, filter.offset ?? 0);
    return db
        .query<ItemRow, typeof params>(sql)
        .all(...params)
        .map(rowToItem);
}

function normaliseList<T extends string>(v: T | T[] | undefined): T[] {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
}

export interface SearchHit {
    item: Item;
    /** BM25 score, lower is better in SQLite; we invert it into 0..1 relevance. */
    relevance: number;
}

/**
 * FTS5 keyword search. The query is sanitised into a bare-token OR-query rather
 * than passed through, because FTS5 syntax errors on user text (`foo:bar`, `-x`,
 * unbalanced quotes) would otherwise surface as a hook crash.
 */
export function searchItems(
    db: DB,
    query: string,
    opts: { workspace_id?: string | null; limit?: number; status?: ItemStatus[] } = {},
): SearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];

    const statuses = opts.status ?? ['active'];
    const params: Array<string | number> = [match];
    let sql = `SELECT items.*, bm25(items_fts, 4.0, 1.0, 1.5, 2.0) AS score
               FROM items_fts JOIN items ON items.rowid = items_fts.rowid
               WHERE items_fts MATCH ?`;
    if (opts.workspace_id) {
        sql += ' AND (items.workspace_id = ? OR items.workspace_id IS NULL)';
        params.push(opts.workspace_id);
    }
    sql += ` AND items.status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
    sql += ' ORDER BY score LIMIT ?';
    params.push(opts.limit ?? 25);

    const rows = db.query<ItemRow & { score: number }, typeof params>(sql).all(...params);
    return rows.map((row) => ({
        item: rowToItem(row),
        // bm25 returns negative values; map to a bounded 0..1 relevance.
        relevance: 1 / (1 + Math.exp(row.score / 2)),
    }));
}

export function toFtsQuery(raw: string): string | null {
    const tokens = raw
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
        .filter((t) => t.length > 2 && !STOPWORDS.has(t))
        .slice(0, 24);
    if (!tokens.length) return null;
    return tokens.map((t) => `"${t}"`).join(' OR ');
}

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were', 'from', 'have', 'has',
    'can', 'not', 'but', 'all', 'any', 'let', 'get', 'set', 'use', 'using', 'make', 'made', 'into', 'when',
    'what', 'why', 'how', 'please', 'would', 'could', 'should', 'about', 'their', 'there', 'they', 'them',
]);

export function touchItems(db: DB, ids: string[]): void {
    if (!ids.length) return;
    const now = Date.now();
    const stmt = db.query('UPDATE items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
    db.transaction(() => {
        for (const id of ids) stmt.run(now, id);
    })();
}

export function setItemStatus(db: DB, id: string, status: ItemStatus): void {
    db.query('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
}

export function setItemPinned(db: DB, id: string, pinned: boolean): void {
    db.query('UPDATE items SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id);
}

export function setItemScope(db: DB, id: string, scope: Item['scope'], scope_key: string | null): void {
    db.query('UPDATE items SET scope = ?, scope_key = ?, updated_at = ? WHERE id = ?').run(
        scope,
        scope_key,
        Date.now(),
        id,
    );
    if (scope === 'global') db.query('UPDATE items SET workspace_id = NULL WHERE id = ?').run(id);
}

export function deleteItem(db: DB, id: string): void {
    db.query('DELETE FROM items WHERE id = ?').run(id);
    db.query('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(id, id);
}

/* -------------------------------------------------------------------- briefs */

export function recordBrief(
    db: DB,
    input: { session_id: string; workspace_id: string; reason: string; item_ids: string[]; tokens: number; text: string },
): string {
    const id = newId('brf');
    db.query(
        'INSERT INTO briefs (id, session_id, workspace_id, created_at, reason, item_ids, tokens, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, input.session_id, input.workspace_id, Date.now(), input.reason, JSON.stringify(input.item_ids), input.tokens, input.text);
    return id;
}

export function lastBrief(db: DB, session_id: string): { text: string; created_at: number; reason: string } | null {
    return (
        db
            .query<{ text: string; created_at: number; reason: string }, [string]>(
                'SELECT text, created_at, reason FROM briefs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
            )
            .get(session_id) ?? null
    );
}

/* ------------------------------------------------------------------ settings */

export function getSetting(db: DB, key: string, scope_id = ''): string | null {
    return (
        db.query<{ value: string }, [string, string]>('SELECT value FROM settings WHERE scope_id = ? AND key = ?').get(
            scope_id,
            key,
        )?.value ?? null
    );
}

/**
 * Atomic "have I done this recently?" claim, used to rate-limit maintenance that
 * several concurrent SessionStart hooks would otherwise each run. Read-then-write
 * would let all of them pass the check before any of them recorded it — which for
 * decay means the confidence multiplier applied three times in one morning.
 *
 * Returns true exactly once per interval, to exactly one caller.
 */
export function tryClaimInterval(db: DB, key: string, minIntervalMs: number, now = Date.now()): boolean {
    return (
        db
            .query(
                `INSERT INTO settings (scope_id, key, value, updated_at) VALUES ('', ?, ?, ?)
                 ON CONFLICT(scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                 WHERE CAST(settings.value AS INTEGER) <= ?`,
            )
            .run(key, String(now), now, now - minIntervalMs).changes > 0
    );
}

export function setSetting(db: DB, key: string, value: string, scope_id = ''): void {
    db.query(
        'INSERT INTO settings (scope_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(scope_id, key, value, Date.now());
}

/* ---------------------------------------------------------------------- stats */

export interface StoreStats {
    workspaces: number;
    sessions: number;
    events: number;
    items: number;
    active_items: number;
    pinned_items: number;
    open_threads: number;
    undistilled_sessions: number;
    by_type: Record<string, number>;
}

export function stats(db: DB, workspace_id?: string | null): StoreStats {
    const ws = workspace_id ?? null;
    const params: string[] = ws ? [ws] : [];
    const and = (extra: string): string => (ws ? ` WHERE workspace_id = ? AND ${extra}` : ` WHERE ${extra}`);
    const where = ws ? ' WHERE workspace_id = ?' : '';

    const count = (sql: string): number => Number(db.query<{ c: number }, string[]>(sql).get(...params)?.c ?? 0);

    const byType = db
        .query<{ type: string; c: number }, string[]>(`SELECT type, count(*) AS c FROM items${where} GROUP BY type`)
        .all(...params);

    return {
        workspaces: Number(db.query<{ c: number }, []>('SELECT count(*) AS c FROM workspaces').get()?.c ?? 0),
        sessions: count(`SELECT count(*) AS c FROM sessions${where}`),
        events: count(`SELECT count(*) AS c FROM events${where}`),
        items: count(`SELECT count(*) AS c FROM items${where}`),
        active_items: count(`SELECT count(*) AS c FROM items${and("status = 'active'")}`),
        pinned_items: count(`SELECT count(*) AS c FROM items${and('pinned = 1')}`),
        open_threads: count(`SELECT count(*) AS c FROM items${and("type = 'open_thread' AND status = 'active'")}`),
        undistilled_sessions: count(`SELECT count(*) AS c FROM sessions${and('distilled_at IS NULL')}`),
        by_type: Object.fromEntries(byType.map((r) => [r.type, r.c])),
    };
}
