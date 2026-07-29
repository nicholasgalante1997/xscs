import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { storePath } from './paths';

export type DB = Database;

/**
 * Schema migrations, applied in order and recorded in `user_version`.
 * Never edit a shipped migration — append a new one. The store outlives every
 * session that wrote to it, so a destructive migration is data loss.
 */
const MIGRATIONS: ReadonlyArray<(db: DB) => void> = [
    // 1 — base schema
    (db) => {
        db.run(`
            CREATE TABLE workspaces (
                id         TEXT PRIMARY KEY,
                root       TEXT NOT NULL UNIQUE,
                name       TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE sessions (
                id                 TEXT PRIMARY KEY,
                agent              TEXT NOT NULL,
                harness_session_id TEXT NOT NULL,
                workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
                cwd                TEXT NOT NULL,
                git_branch         TEXT,
                transcript_path    TEXT,
                model              TEXT,
                title              TEXT,
                source             TEXT,
                parent_session_id  TEXT,
                started_at         INTEGER NOT NULL,
                ended_at           INTEGER,
                end_reason         TEXT,
                distilled_at       INTEGER,
                prompt_count       INTEGER NOT NULL DEFAULT 0,
                turn_count         INTEGER NOT NULL DEFAULT 0,
                UNIQUE(agent, harness_session_id)
            );
            CREATE INDEX idx_sessions_workspace ON sessions(workspace_id, started_at DESC);
            CREATE INDEX idx_sessions_undistilled ON sessions(distilled_at, ended_at);

            -- Append-only episodic log. Cheap to write from a hook, never injected
            -- into a prompt directly; it is raw material for distillation only.
            CREATE TABLE events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id   TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                ts           INTEGER NOT NULL,
                kind         TEXT NOT NULL,
                payload      TEXT NOT NULL,
                consumed_at  INTEGER
            );
            CREATE INDEX idx_events_session ON events(session_id, id);
            CREATE INDEX idx_events_unconsumed ON events(consumed_at, id);

            -- Durable, curated memory. This is the only table that reaches a prompt.
            CREATE TABLE items (
                id                TEXT PRIMARY KEY,
                workspace_id      TEXT,
                scope             TEXT NOT NULL,
                scope_key         TEXT,
                type              TEXT NOT NULL,
                title             TEXT NOT NULL,
                body              TEXT NOT NULL,
                why               TEXT,
                status            TEXT NOT NULL DEFAULT 'active',
                confidence        REAL NOT NULL DEFAULT 0.5,
                pinned            INTEGER NOT NULL DEFAULT 0,
                source            TEXT NOT NULL,
                origin_session_id TEXT,
                origin_agent      TEXT,
                supersedes        TEXT,
                content_hash      TEXT NOT NULL,
                tags              TEXT NOT NULL DEFAULT '[]',
                created_at        INTEGER NOT NULL,
                updated_at        INTEGER NOT NULL,
                last_used_at      INTEGER,
                use_count         INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_items_lookup ON items(workspace_id, status, type);
            CREATE INDEX idx_items_rank ON items(status, pinned DESC, confidence DESC, updated_at DESC);
            CREATE UNIQUE INDEX idx_items_dedupe ON items(content_hash, ifnull(workspace_id, ''), scope, ifnull(scope_key, ''));

            -- External-content FTS index: keyword recall with BM25, no embeddings,
            -- no extra process. At the scale a single developer generates this
            -- beats a vector store on latency and on operational surface area.
            CREATE VIRTUAL TABLE items_fts USING fts5(
                title, body, why, tags,
                content='items', content_rowid='rowid',
                tokenize='porter unicode61'
            );
            CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
                INSERT INTO items_fts(rowid, title, body, why, tags)
                VALUES (new.rowid, new.title, new.body, ifnull(new.why,''), new.tags);
            END;
            CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
                INSERT INTO items_fts(items_fts, rowid, title, body, why, tags)
                VALUES ('delete', old.rowid, old.title, old.body, ifnull(old.why,''), old.tags);
            END;
            CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
                INSERT INTO items_fts(items_fts, rowid, title, body, why, tags)
                VALUES ('delete', old.rowid, old.title, old.body, ifnull(old.why,''), old.tags);
                INSERT INTO items_fts(rowid, title, body, why, tags)
                VALUES (new.rowid, new.title, new.body, ifnull(new.why,''), new.tags);
            END;

            -- Typed edges between items (supersession, contradiction candidates,
            -- derivation). Kept separate from items so a link can be added without
            -- touching the indexed row.
            CREATE TABLE links (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id    TEXT NOT NULL,
                to_id      TEXT NOT NULL,
                kind       TEXT NOT NULL,
                note       TEXT,
                created_at INTEGER NOT NULL,
                UNIQUE(from_id, to_id, kind)
            );
            CREATE INDEX idx_links_to ON links(to_id, kind);

            -- Every brief we inject is recorded. Without this you cannot answer
            -- "why did the agent believe that?" three days later, and you cannot
            -- measure whether recall is actually being used.
            CREATE TABLE briefs (
                id           TEXT PRIMARY KEY,
                session_id   TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                created_at   INTEGER NOT NULL,
                reason       TEXT NOT NULL,
                item_ids     TEXT NOT NULL,
                tokens       INTEGER NOT NULL,
                text         TEXT NOT NULL
            );
            CREATE INDEX idx_briefs_session ON briefs(session_id, created_at DESC);
        `);
    },
    // 2 — durable per-workspace + global key/value settings
    (db) => {
        db.run(`
            CREATE TABLE settings (
                scope_id   TEXT NOT NULL DEFAULT '',
                key        TEXT NOT NULL,
                value      TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (scope_id, key)
            );
        `);
    },
];

let cached: DB | null = null;
let cachedPath: string | null = null;

export interface OpenOptions {
    path?: string;
    readonly?: boolean;
    /** Skip the process-level cache. Tests want isolated handles. */
    fresh?: boolean;
}

export function openStore(opts: OpenOptions = {}): DB {
    const path = opts.path ?? storePath();
    if (!opts.fresh && cached && cachedPath === path) return cached;

    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true, readwrite: true, strict: false });

    // WAL + a generous busy timeout: several hook processes from different
    // harnesses can hit this file at the same instant, and a hook that throws
    // SQLITE_BUSY is a hook that loses a session's context forever.
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA foreign_keys = ON');

    migrate(db);

    if (!opts.fresh) {
        cached = db;
        cachedPath = path;
    }
    return db;
}

function schemaVersion(db: DB): number {
    return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

export function migrate(db: DB): void {
    if (schemaVersion(db) >= MIGRATIONS.length) return;

    // BEGIN IMMEDIATE takes the write lock up front, and the version is re-read
    // *inside* it. Two hook processes starting at the same instant on a fresh
    // machine would otherwise both see version 0 and both run CREATE TABLE.
    db.run('BEGIN IMMEDIATE');
    try {
        const current = schemaVersion(db);
        for (let v = current; v < MIGRATIONS.length; v++) {
            MIGRATIONS[v]!(db);
        }
        // PRAGMA does not accept bound parameters.
        db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
        db.run('COMMIT');
    } catch (e) {
        db.run('ROLLBACK');
        throw e;
    }
}

export function closeStore(): void {
    cached?.close();
    cached = null;
    cachedPath = null;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
