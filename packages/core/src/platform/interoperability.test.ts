import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { bunDatabasePlatform } from '../../bun';
import { migrate } from '../db';
import { ensureWorkspace, listItems, putItem } from '../store';

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
    const directory = mkdtempSync(resolve(tmpdir(), 'xscs-interoperability-'));
    temporaryDirectories.push(directory);
    return resolve(directory, 'store.db');
}

afterEach(() => {
    while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
});

describe('Bun and Node SQLite interoperability', () => {
    test('Node reads and writes the same migrated store', () => {
        const path = temporaryDatabase();
        const bun = bunDatabasePlatform.open(path, { create: true });
        bun.run('PRAGMA journal_mode = WAL');
        bun.run('PRAGMA busy_timeout = 5000');
        bun.run('PRAGMA synchronous = NORMAL');
        bun.run('PRAGMA foreign_keys = ON');
        migrate(bun);
        const workspace = ensureWorkspace(bun, process.cwd());
        const first = putItem(bun, {
            type: 'fact',
            title: 'Written by Bun',
            body: 'The same SQLite file is portable.',
            scope: 'workspace',
            workspace_id: workspace.id,
            source: 'test:bun',
        });
        bun.close();

        const script = `
            process.env.NODE_NO_WARNINGS = '1';
            const [{ configureDatabasePlatform, openStore, listItems, putItem }, { createNodeDatabasePlatform, assertNodeSqliteCapabilities }] =
                await Promise.all([import('@xscs/core'), import('@xscs/core/node')]);
            const platform = await createNodeDatabasePlatform();
            assertNodeSqliteCapabilities(platform);
            configureDatabasePlatform(platform);
            const db = openStore({ path: process.argv[1], fresh: true });
            const before = listItems(db, { workspace_id: process.argv[2], status: 'active' });
            putItem(db, {
                type: 'fact',
                title: 'Written by Node',
                body: 'Node writes the shared SQLite file.',
                scope: 'workspace',
                workspace_id: process.argv[2],
                source: 'test:node'
            });
            db.close();
            process.stdout.write(JSON.stringify(before.map((item) => item.id)));
        `;
        const result = Bun.spawnSync(['node', '--input-type=module', '-e', script, path, workspace.id], {
            cwd: resolve(import.meta.dir, '../../../cli'),
            stdout: 'pipe',
            stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toBe('');
        expect(JSON.parse(result.stdout.toString())).toEqual([first.item.id]);

        const reopened = bunDatabasePlatform.open(path);
        const items = listItems(reopened, { workspace_id: workspace.id, status: 'active' });
        expect(items.map((item) => item.title).sort()).toEqual(['Written by Bun', 'Written by Node']);
        reopened.close();
    });
});
