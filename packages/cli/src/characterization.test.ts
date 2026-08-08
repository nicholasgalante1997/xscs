import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

interface RunResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

interface Artifact {
    command: string;
    entry: string;
    name: string;
}

const ROOT = resolve(import.meta.dir, '../../..');
const artifacts: Artifact[] = [
    { name: 'Bun', command: process.execPath, entry: resolve(ROOT, 'packages/cli/dist/xscs.js') },
    { name: 'Node', command: 'node', entry: resolve(ROOT, 'packages/cli/dist/xscs.node.js') },
];
const temporaryDirectories: string[] = [];

function temporaryHome(): string {
    const path = mkdtempSync(resolve(tmpdir(), 'xscs-characterization-'));
    temporaryDirectories.push(path);
    return path;
}

function run(
    artifact: Artifact,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; home?: string; stdin?: string } = {},
): RunResult {
    expect(existsSync(artifact.entry)).toBe(true);
    const result = Bun.spawnSync([artifact.command, artifact.entry, ...args], {
        cwd: options.cwd ?? ROOT,
        env: {
            ...process.env,
            XSCS_DISTILLER: 'none',
            XSCS_HOME: options.home ?? temporaryHome(),
            ...options.env,
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

for (const artifact of artifacts) describe(`${artifact.name} built CLI characterization`, () => {
    test('root help describes the complete command families', () => {
        const result = run(artifact, ['help']);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        for (const text of ['setup', 'reading', 'writing', 'maintenance', 'internal', 'global flags:', 'XSCS_HOME']) {
            expect(result.stdout).toContain(text);
        }
    });

    test('unknown commands fail and keep diagnostics on stderr', () => {
        const result = run(artifact, ['definitely-not-a-command']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('unknown command: definitely-not-a-command');
        expect(result.stdout).toContain('$ xscs <command> [options]');
    });

    test('empty-store JSON contracts remain stable', () => {
        const home = temporaryHome();
        const stats = json(run(artifact, ['stats', '--json'], { home })) as {
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

        expect(json(run(artifact, ['list', '--json'], { home }))).toEqual([]);
        expect(json(run(artifact, ['open', '--json'], { home }))).toEqual([]);
        expect(json(run(artifact, ['search', 'memory', '--json'], { home }))).toEqual([]);
        expect(json(run(artifact, ['conflicts', '--json'], { home }))).toEqual([]);
    });

    test('remember and search preserve machine-readable result shapes', () => {
        const home = temporaryHome();
        const remembered = json(
            run(
                artifact,
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

        const hits = json(run(artifact, ['search', 'bundled javascript', '--limit', '2', '--json'], { home })) as Array<{
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
                artifact,
                ['remember', '--type', 'open_thread', '--title', 'Finish parity tests', '--body', 'Add Node fixtures.', '--json'],
                { home },
            ),
        );
        expect(json(run(artifact, ['open', '--json'], { home }))).toEqual(
            json(run(artifact, ['list', '--type', 'open_thread', '--json'], { home })),
        );
    });

    test('missing remember title retains its usage failure', () => {
        const result = run(artifact, ['remember', '--type', 'fact']);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('usage: xscs remember --type <type> --title');
    });

    test('--cwd and XSCS_DB preserve workspace and environment routing', () => {
        const home = temporaryHome();
        const cwd = temporaryHome();
        const database = resolve(temporaryHome(), 'custom.db');
        const workspaces = json(
            run(artifact, ['workspaces', '--cwd', cwd, '--json'], {
                home,
                env: { XSCS_DB: database },
            }),
        ) as Array<{ root: string }>;
        expect(workspaces.map((workspace) => workspace.root)).toEqual([cwd]);
        expect(existsSync(database)).toBe(true);
        expect(existsSync(resolve(home, 'store.db'))).toBe(false);
    });

    test('init accepts the explicit --with-mcp compatibility flag', () => {
        const home = temporaryHome();
        const result = run(artifact, ['init', '--claude', '--with-mcp', '--dry-run', '--json'], {
            cwd: home,
            home,
        });
        const output = json(result) as { results: Array<{ harness: string; path: string; action: string }> };
        expect(output.results).toHaveLength(1);
        expect(output.results[0]).toMatchObject({ harness: 'claude', action: 'created' });
        expect(output.results[0]!.path).toEndWith('/.claude/settings.json');
        expect(existsSync(resolve(home, '.mcp.json'))).toBe(false);
    });

    test('pending distillation preserves an explicit backend selection', () => {
        const home = temporaryHome();
        const sessionId = `pending-backend-${artifact.name.toLowerCase()}`;
        const hook = (event: string, payload: Record<string, unknown>) =>
            run(artifact, ['hook', '--event', event, '--agent', 'claude', '--no-background'], {
                home,
                stdin: JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd: ROOT, ...payload }),
            });
        expect(hook('SessionStart', { source: 'startup' }).exitCode).toBe(0);
        expect(
            hook('UserPromptSubmit', {
                prompt: 'Always run the complete verification suite before publishing an npm package to the registry.',
            }).exitCode,
        ).toBe(0);
        expect(hook('SessionEnd', { reason: 'test' }).exitCode).toBe(0);

        const reports = json(
            run(artifact, ['distill', '--pending', '--mode', 'agent', '--backend', 'none', '--dry-run', '--json'], {
                home,
            }),
        ) as Array<{ backend: string; error: string }>;
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ backend: 'none', error: 'no distiller backend available' });
    });
});

for (const artifact of artifacts) describe(`${artifact.name} built hook characterization`, () => {
    test('Kiro AgentSpawn emits plain model context rather than a Claude JSON envelope', () => {
        const home = temporaryHome();
        json(
            run(
                artifact,
                ['remember', '--type', 'constraint', '--title', 'Kiro recall fixture', '--body', 'Preserve Kiro context.', '--json'],
                { home },
            ),
        );
        const result = run(artifact, ['hook', '--event', 'SessionStart', '--agent', 'kiro', '--no-background'], {
            home,
            stdin: JSON.stringify({ hook_event_name: 'agentSpawn', session_id: 'kiro-fixture', cwd: ROOT }),
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Kiro recall fixture');
        expect(result.stdout).not.toStartWith('{');
    });

    test('internal hook invocations short-circuit safely', () => {
        const home = temporaryHome();
        const result = Bun.spawnSync([artifact.command, artifact.entry, 'hook', '--event', 'SessionStart', '--agent', 'codex'], {
            cwd: ROOT,
            env: { ...process.env, XSCS_INTERNAL: '1', XSCS_HOME: home },
            stdin: new TextEncoder().encode('not-json'),
            stdout: 'pipe',
            stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe('{}');
        expect(result.stderr.toString()).toBe('');
        expect(existsSync(resolve(home, 'store.db'))).toBe(false);
    });

    test('malformed hook JSON never fails the harness', () => {
        const home = temporaryHome();
        const result = run(artifact, ['hook', '--event', 'SessionStart', '--agent', 'codex'], {
            home,
            stdin: '{broken',
        });
        expect(result).toEqual({ exitCode: 0, stdout: '{}', stderr: '' });
        expect(readFileSync(resolve(home, 'xscs.log'), 'utf8')).toContain('hook input was not JSON');
    });

    test('internal storage failures cannot break the harness', () => {
        const home = temporaryHome();
        const directoryInsteadOfDatabase = temporaryHome();
        const result = run(artifact, ['hook', '--event', 'SessionStart', '--agent', 'codex'], {
            home,
            env: { XSCS_DB: directoryInsteadOfDatabase },
            stdin: JSON.stringify({
                cwd: ROOT,
                hook_event_name: 'SessionStart',
                session_id: 'forced-storage-failure',
            }),
        });
        expect(result).toEqual({ exitCode: 0, stdout: '{}', stderr: '' });
        expect(readFileSync(resolve(home, 'xscs.log'), 'utf8')).toContain('hook SessionStart failed');
    });

    for (const fixture of ['claude-session-start.json', 'codex-session-start.json']) {
        test(`${fixture} normalizes into a safe SessionStart response`, () => {
            const home = temporaryHome();
            const raw = readFileSync(resolve(import.meta.dir, 'fixtures', fixture), 'utf8').replace('__WORKSPACE__', ROOT);
            const agent = fixture.startsWith('claude') ? 'claude' : 'codex';
            const result = run(
                artifact,
                ['hook', '--event', 'SessionStart', '--agent', agent, '--no-background'],
                { home, stdin: raw },
            );
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toBe('');
            expect(JSON.parse(result.stdout)).toEqual({});
        });
    }
});
