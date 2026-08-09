import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

interface Artifact {
    command: string[];
    entry: string;
    name: string;
}

interface Result {
    exitCode: number;
    stderr: string;
    stdout: string;
}

const ROOT = resolve(import.meta.dir, '../../..');
const artifacts: Artifact[] = [
    { name: 'Bun', command: [process.execPath], entry: resolve(ROOT, 'packages/cli/dist/xscs.js') },
    { name: 'Node', command: ['node'], entry: resolve(ROOT, 'packages/cli/dist/xscs.node.js') },
];
const interactiveCommands = [
    'init',
    'doctor',
    'brief',
    'search',
    'list',
    'open',
    'handoff',
    'stats',
    'workspaces',
    'export',
    'remember',
    'review',
    'pin',
    'unpin',
    'promote',
    'forget',
    'distill',
    'conflicts',
    'prune',
    'serve',
] as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
    while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
});

for (const artifact of artifacts) {
    describe(`${artifact.name} complete command corpus`, () => {
        test('every interactive command executes through the built artifact', async () => {
            expect(existsSync(artifact.entry)).toBe(true);
            const home = temporaryHome();
            const cwd = temporaryHome();

            expectJson(run(artifact, home, cwd, ['init', '--dry-run', '--user', '--claude', '--codex', '--no-mcp', '--json']));
            expectSuccess(run(artifact, home, cwd, ['doctor']));
            expectJson(run(artifact, home, cwd, ['brief', 'runtime', 'parity', '--budget', '80', '--json']));
            expectJson(run(artifact, home, cwd, ['search', 'parity', '--limit', '3', '--json']));
            expectJson(run(artifact, home, cwd, ['list', '--type', 'fact,decision', '--status', 'active', '--limit', '5', '--json']));
            expectJson(run(artifact, home, cwd, ['open', '--json']));
            expectJson(run(artifact, home, cwd, ['handoff', '--stdout', '--budget', '200', '--json']));
            expectJson(run(artifact, home, cwd, ['stats', '--all', '--json']));
            expectJson(run(artifact, home, cwd, ['workspaces', '--json']));
            expectJson(run(artifact, home, cwd, ['export', '--all']));

            const remembered = expectJson(
                run(artifact, home, cwd, [
                    'remember',
                    '--type',
                    'open_thread',
                    '--title',
                    'Complete runtime parity',
                    '--body',
                    'Exercise every command under both runtimes.',
                    '--why',
                    'Compatibility is a release boundary.',
                    '--scope',
                    'workspace',
                    '--tag',
                    'runtime,parity',
                    '--tag',
                    'cli',
                    '--confidence',
                    '0.8',
                    '--pin',
                    '--json',
                ]),
            ) as { item: { id: string } };
            const id = remembered.item.id;
            expectJson(run(artifact, home, cwd, ['review', '--json']));
            expectJson(run(artifact, home, cwd, ['review', '--accept-all', '--json']));
            expectJson(run(artifact, home, cwd, ['review', '--accept', 'missing-a', '--reject', 'missing-b', '--json']));
            expectJson(run(artifact, home, cwd, ['pin', id, '--json']));
            expectJson(run(artifact, home, cwd, ['unpin', id, '--json']));
            expectJson(run(artifact, home, cwd, ['promote', id, '--scope', 'branch', '--json']));
            expectJson(run(artifact, home, cwd, ['conflicts', '--limit', '1', '--json']));
            expectJson(run(artifact, home, cwd, ['conflicts', '--dismiss', 'missing-a', '--dismiss', 'missing-b', '--json']));
            expectJson(run(artifact, home, cwd, ['distill', '--pending', '--json']));
            expectJson(
                run(artifact, home, cwd, [
                    'distill',
                    '--session',
                    'missing-session',
                    '--mode',
                    'both',
                    '--backend',
                    'none',
                    '--limit',
                    '1',
                    '--dry-run',
                    '--handoff',
                    '--quiet',
                    '--json',
                ]),
            );
            expectJson(run(artifact, home, cwd, ['prune', '--events-days', '60', '--briefs-days', '30', '--json']));
            expectJson(run(artifact, home, cwd, ['forget', id, '--json']));

            for (const command of interactiveCommands) {
                const help = expectSuccess(run(artifact, home, cwd, [command, '--help']));
                expect(help.stdout).toContain(`xscs ${command}`);
            }
            expect(expectSuccess(run(artifact, home, cwd, ['remember', '--help'])).stdout).toContain('--confidence');
        });
    });
}

function temporaryHome(): string {
    const directory = mkdtempSync(resolve(tmpdir(), 'xscs-command-parity-'));
    temporaryDirectories.push(directory);
    return directory;
}

function run(artifact: Artifact, home: string, cwd: string, args: string[]): Result {
    const result = Bun.spawnSync([...artifact.command, artifact.entry, ...args], {
        cwd,
        env: { ...process.env, XSCS_DISTILLER: 'none', XSCS_HOME: home },
        stderr: 'pipe',
        stdout: 'pipe',
    });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
    };
}

function expectSuccess(result: Result): Result {
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    return result;
}

function expectJson(result: Result): unknown {
    expectSuccess(result);
    return JSON.parse(result.stdout) as unknown;
}
