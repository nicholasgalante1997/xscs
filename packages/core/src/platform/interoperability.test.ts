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

    test('Bun and Node write concurrently through one WAL store', async () => {
        const path = temporaryDatabase();
        const initial = bunDatabasePlatform.open(path, { create: true });
        initial.run('PRAGMA journal_mode = WAL');
        initial.run('PRAGMA busy_timeout = 5000');
        initial.run('PRAGMA synchronous = NORMAL');
        initial.run('PRAGMA foreign_keys = ON');
        migrate(initial);
        const workspace = ensureWorkspace(initial, process.cwd());
        initial.close();

        const worker = `
            const runtime = process.argv[1];
            const path = process.argv[2];
            const workspace = process.argv[3];
            const core = await import('@xscs/core');
            if (runtime === 'bun') {
                const { bunDatabasePlatform } = await import('@xscs/core/bun');
                core.configureDatabasePlatform(bunDatabasePlatform);
            } else {
                const { createNodeDatabasePlatform } = await import('@xscs/core/node');
                core.configureDatabasePlatform(await createNodeDatabasePlatform());
            }
            const db = core.openStore({ path, fresh: true });
            for (let index = 0; index < 25; index++) {
                core.putItem(db, {
                    type: 'fact',
                    title: runtime + ' concurrent item ' + index,
                    body: runtime + ' writes safely through WAL ' + index,
                    scope: 'workspace',
                    workspace_id: workspace,
                    source: 'test:' + runtime
                });
            }
            db.close();
        `;
        const cwd = resolve(import.meta.dir, '../../../cli');
        const bun = Bun.spawn(['bun', '--eval', worker, 'bun', path, workspace.id], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const node = Bun.spawn(['node', '--input-type=module', '--eval', worker, 'node', path, workspace.id], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [bunExit, nodeExit, bunError, nodeError] = await Promise.all([
            bun.exited,
            node.exited,
            new Response(bun.stderr).text(),
            new Response(node.stderr).text(),
        ]);
        expect({ bunExit, bunError, nodeExit, nodeError }).toEqual({
            bunExit: 0,
            bunError: '',
            nodeExit: 0,
            nodeError: '',
        });

        const reopened = bunDatabasePlatform.open(path);
        const items = listItems(reopened, { workspace_id: workspace.id, status: 'active', limit: 100 });
        expect(items).toHaveLength(50);
        expect(new Set(items.map((item) => item.source))).toEqual(new Set(['test:bun', 'test:node']));
        reopened.close();
    });
});
