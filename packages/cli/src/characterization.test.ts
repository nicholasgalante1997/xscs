import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

interface RunResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

const ROOT = resolve(import.meta.dir, '../../..');
const ENTRY = resolve(ROOT, 'packages/cli/dist/xscs.js');
const temporaryDirectories: string[] = [];

function temporaryHome(): string {
    const path = mkdtempSync(resolve(tmpdir(), 'xscs-characterization-'));
    temporaryDirectories.push(path);
    return path;
}

function run(args: string[], options: { cwd?: string; home?: string; stdin?: string } = {}): RunResult {
    expect(existsSync(ENTRY)).toBe(true);
    const result = Bun.spawnSync([process.execPath, ENTRY, ...args], {
        cwd: options.cwd ?? ROOT,
        env: {
            ...process.env,
            XSCS_DISTILLER: 'none',
            XSCS_HOME: options.home ?? temporaryHome(),
        },
        stdin: options.stdin === undefined ? undefined : new TextEncoder().encode(options.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

function json(result: RunResult): unknown {
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout) as unknown;
}

afterEach(() => {
    while (temporaryDirectories.length) {
        rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
    }
});

describe('built CLI characterization', () => {
    test('root help describes the complete command families', () => {
        const result = run(['help']);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        for (const text of ['setup', 'reading', 'writing', 'maintenance', 'internal', 'global flags:', 'XSCS_HOME']) {
            expect(result.stdout).toContain(text);
        }
    });

    test('unknown commands fail and keep diagnostics on stderr', () => {
        const result = run(['definitely-not-a-command']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('unknown command: definitely-not-a-command');
        expect(result.stdout).toContain('$ xscs <command> [options]');
    });

    test('empty-store JSON contracts remain stable', () => {
        const home = temporaryHome();
        const stats = json(run(['stats', '--json'], { home })) as {
            sessions: unknown[];
            stats: { active_items: number; events: number; items: number; sessions: number; workspaces: number };
        };
        expect(stats.stats).toMatchObject({
            active_items: 0,
            events: 0,
            items: 0,
            sessions: 0,
            workspaces: 1,
        });
        expect(stats.sessions).toEqual([]);

        expect(json(run(['list', '--json'], { home }))).toEqual([]);
        expect(json(run(['open', '--json'], { home }))).toEqual([]);
        expect(json(run(['search', 'memory', '--json'], { home }))).toEqual([]);
        expect(json(run(['conflicts', '--json'], { home }))).toEqual([]);
    });

    test('remember and search preserve machine-readable result shapes', () => {
        const home = temporaryHome();
        const remembered = json(
            run(
                [
                    'remember',
                    '--type',
                    'constraint',
                    '--title',
                    'Never publish source TypeScript',
                    '--body',
                    'All package exports resolve to bundled JavaScript in dist.',
                    '--why',
                    'Published source creates stale artifact failures.',
                    '--pin',
                    '--json',
                ],
                { home },
            ),
        ) as { created: boolean; item: { id: string; pinned: boolean; type: string } };
        expect(remembered.created).toBe(true);
        expect(remembered.item).toMatchObject({ pinned: true, type: 'constraint' });
        expect(remembered.item.id).toStartWith('itm_');

        const hits = json(run(['search', 'bundled javascript', '--limit', '2', '--json'], { home })) as Array<{
            item: { id: string };
            relevance: number;
        }>;
        expect(hits).toHaveLength(1);
        expect(hits[0]!.item.id).toBe(remembered.item.id);
        expect(hits[0]!.relevance).toBeNumber();
    });

    test('open remains an alias for open-thread listing', () => {
        const home = temporaryHome();
        json(
            run(
                ['remember', '--type', 'open_thread', '--title', 'Finish parity tests', '--body', 'Add Node fixtures.', '--json'],
                { home },
            ),
        );
        expect(json(run(['open', '--json'], { home }))).toEqual(json(run(['list', '--type', 'open_thread', '--json'], { home })));
    });

    test('missing remember title retains its usage failure', () => {
        const result = run(['remember', '--type', 'fact']);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('usage: xscs remember --type <type> --title');
    });
});

describe('built hook characterization', () => {
    test('internal hook invocations short-circuit safely', () => {
        const result = Bun.spawnSync([process.execPath, ENTRY, 'hook', '--event', 'SessionStart', '--agent', 'codex'], {
            cwd: ROOT,
            env: { ...process.env, XSCS_INTERNAL: '1', XSCS_HOME: temporaryHome() },
            stdin: new TextEncoder().encode('not-json'),
            stdout: 'pipe',
            stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe('{}');
        expect(result.stderr.toString()).toBe('');
    });

    test('malformed hook JSON never fails the harness', () => {
        const home = temporaryHome();
        const result = run(['hook', '--event', 'SessionStart', '--agent', 'codex'], {
            home,
            stdin: '{broken',
        });
        expect(result).toEqual({ exitCode: 0, stdout: '{}', stderr: '' });
        expect(readFileSync(resolve(home, 'xscs.log'), 'utf8')).toContain('hook input was not JSON');
    });

    for (const fixture of ['claude-session-start.json', 'codex-session-start.json']) {
        test(`${fixture} normalizes into a safe SessionStart response`, () => {
            const home = temporaryHome();
            const raw = readFileSync(resolve(import.meta.dir, 'fixtures', fixture), 'utf8').replace('__WORKSPACE__', ROOT);
            const agent = fixture.startsWith('claude') ? 'claude' : 'codex';
            const result = run(
                ['hook', '--event', 'SessionStart', '--agent', agent, '--no-background'],
                { home, stdin: raw },
            );
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toBe('');
            expect(JSON.parse(result.stdout)).toEqual({});
        });
    }
});
