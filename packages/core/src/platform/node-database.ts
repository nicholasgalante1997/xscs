import type { DatabasePlatform, OpenDatabaseOptions, SqlStatement } from './database';

interface NodeStatement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface NodeDatabase {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): NodeStatement;
}

interface NodeDatabaseConstructor {
    new (path: string, options?: { open?: boolean; readOnly?: boolean }): NodeDatabase;
}

class NodeDatabaseConnection {
    readonly #database: NodeDatabase;

    constructor(DatabaseSync: NodeDatabaseConstructor, path: string, options: OpenDatabaseOptions = {}) {
        this.#database = new DatabaseSync(path, {
            open: options.create ?? !options.readonly,
            readOnly: options.readonly ?? false,
        });
    }

    close(): void {
        this.#database.close();
    }

    query<Row = unknown, Params extends readonly unknown[] = readonly unknown[]>(sql: string): SqlStatement<Row, Params> {
        return this.#database.prepare(sql) as unknown as SqlStatement<Row, Params>;
    }

    run(sql: string): { changes: number } {
        this.#database.exec(sql);
        return { changes: 0 };
    }

    transaction<T>(operation: () => T): () => T {
        return () => {
            this.#database.exec('BEGIN');
            try {
                const result = operation();
                this.#database.exec('COMMIT');
                return result;
            } catch (error) {
                this.#database.exec('ROLLBACK');
                throw error;
            }
        };
    }
}

/**
 * Node 24 still labels node:sqlite experimental. Contain that one startup
 * warning while importing the built-in; normal application warnings remain on.
 */
export async function createNodeDatabasePlatform(): Promise<DatabasePlatform> {
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
        if (String(warning).includes('SQLite is an experimental feature')) return;
        return (emitWarning as (...values: unknown[]) => void).call(process, warning, ...args);
    }) as typeof process.emitWarning;
    try {
        const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: NodeDatabaseConstructor };
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
            open(path, options) {
                return new NodeDatabaseConnection(sqlite.DatabaseSync, path, options);
            },
        };
    } finally {
        process.emitWarning = emitWarning;
    }
}

export function assertNodeSqliteCapabilities(platform: DatabasePlatform): void {
    const database = platform.open(':memory:', { create: true });
    try {
        database.run("CREATE VIRTUAL TABLE xscs_fts_capability USING fts5(body)");
        database.query("INSERT INTO xscs_fts_capability(body) VALUES ('cross session memory')").run();
        const row = database
            .query<{ body: string }, []>("SELECT body FROM xscs_fts_capability WHERE xscs_fts_capability MATCH 'memory'")
            .get();
        if (row?.body !== 'cross session memory') throw new Error('FTS5 query returned an unexpected result');
    } catch (error) {
        throw new Error('Node SQLite does not provide the required FTS5 capability', { cause: error });
    } finally {
        database.close();
    }
}
