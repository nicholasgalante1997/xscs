export type SqlValue = bigint | boolean | null | number | string | Uint8Array;

export interface StatementResult {
    changes: number;
    lastInsertRowid?: bigint | number;
}

export interface SqlStatement<Row = unknown, Params extends readonly unknown[] = readonly SqlValue[]> {
    all(...params: Params): Row[];
    get(...params: Params): Row | null | undefined;
    run(...params: Params): StatementResult;
}

export interface DatabaseConnection {
    close(): void;
    query<Row = unknown, Params extends readonly unknown[] = readonly SqlValue[]>(sql: string): SqlStatement<Row, Params>;
    run(sql: string): StatementResult;
    transaction<T>(operation: () => T): () => T;
}

export interface OpenDatabaseOptions {
    create?: boolean;
    readonly?: boolean;
}

export interface DatabasePlatform {
    open(path: string, options?: OpenDatabaseOptions): DatabaseConnection;
}
