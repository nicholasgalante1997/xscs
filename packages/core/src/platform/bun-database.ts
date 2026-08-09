import { Database } from 'bun:sqlite';

import type {
    DatabaseConnection,
    DatabasePlatform,
    OpenDatabaseOptions,
    SqlStatement,
} from './database';

class BunDatabaseConnection implements DatabaseConnection {
    readonly #database: Database;

    constructor(path: string, options: OpenDatabaseOptions = {}) {
        this.#database = new Database(path, {
            create: options.create ?? !options.readonly,
            readonly: options.readonly ?? false,
            readwrite: !options.readonly,
            strict: false,
        });
    }

    close(): void {
        this.#database.close();
    }

    query<Row = unknown, Params extends readonly unknown[] = readonly unknown[]>(sql: string): SqlStatement<Row, Params> {
        return this.#database.query(sql) as unknown as SqlStatement<Row, Params>;
    }

    run(sql: string): { changes: number; lastInsertRowid: bigint | number } {
        return this.#database.run(sql);
    }

    transaction<T>(operation: () => T): () => T {
        return this.#database.transaction(operation);
    }
}

export const bunDatabasePlatform: DatabasePlatform = {
    open(path, options) {
        return new BunDatabaseConnection(path, options);
    },
};
