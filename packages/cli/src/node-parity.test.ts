import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

const ROOT = resolve(import.meta.dir, '../../..');
const ENTRY = resolve(ROOT, 'packages/cli/dist/xscs.node.js');
const temporaryDirectories: string[] = [];

interface Result {
    exitCode: number;
    stderr: string;
    stdout: string;
}

function temporaryHome(): string {
    const directory = mkdtempSync(resolve(tmpdir(), 'xscs-node-parity-'));
    temporaryDirectories.push(directory);
    return directory;
}

function run(args: string[], stdin?: string): Result {
    expect(existsSync(ENTRY)).toBe(true);
    const result = Bun.spawnSync(['node', ENTRY, ...args], {
        cwd: ROOT,
        env: { ...process.env, XSCS_DISTILLER: 'none', XSCS_HOME: temporaryHome() },
        stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
    };
}

afterEach(() => {
    while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
});

describe('Node 24 CLI parity', () => {
    test('interactive commands execute without Bun or SQLite warnings', () => {
        const result = run(['stats', '--json']);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        const output = JSON.parse(result.stdout) as { stats: { workspaces: number } };
        expect(output.stats.workspaces).toBe(1);
    });

    test('hooks retain their safe stdout and exit contract', () => {
        const result = run(
            ['hook', '--event', 'SessionStart', '--agent', 'codex', '--no-background'],
            JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'node-hook-fixture',
                cwd: ROOT,
                source: 'startup',
            }),
        );
        expect(result).toEqual({ exitCode: 0, stderr: '', stdout: '{}' });
    });

    test('MCP initialization retains JSON-RPC framing', () => {
        const result = run(
            ['mcp'],
            JSON.stringify({ jsonrpc: '2.0', id: 'node', method: 'initialize', params: {} }) + '\n',
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toMatchObject({
            id: 'node',
            jsonrpc: '2.0',
            result: {
                protocolVersion: '2025-06-18',
                serverInfo: { name: 'xscs' },
            },
        });
    });

    test.skipIf(process.env.XSCS_NETWORK_TESTS !== '1')(
        'serve loads the dashboard through the Node HTTP adapter',
        async () => {
        const child = Bun.spawn(['node', ENTRY, 'serve', '--port', '0', '--no-open'], {
            cwd: ROOT,
            env: { ...process.env, XSCS_HOME: temporaryHome() },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        try {
            const reader = child.stdout.getReader();
            const decoder = new TextDecoder();
            let output = '';
            let url: string | undefined;
            const deadline = Date.now() + 2_000;
            while (!url && Date.now() < deadline) {
                const { done, value } = await reader.read();
                if (done) break;
                output += decoder.decode(value, { stream: true });
                url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
            }
            reader.releaseLock();
            expect(url).toBeDefined();
            const response = await fetch(url!);
            expect(response.status).toBe(200);
            expect(await response.text()).toContain('xscs');
        } finally {
            child.kill();
            await child.exited;
        }
        },
    );
});
