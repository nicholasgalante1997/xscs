import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { resolveAgent } from './hook';
import { hookMap, installClaude, installCodex, installKiro, mergeHooks } from './install';

const ENTRY = '/opt/xscs/packages/cli/dist/xscs.js';

interface SettingsFixture {
    hooks: Record<string, unknown>;
    model?: string;
    permissions?: { allow: string[] };
}

interface McpFixture {
    mcpServers: { xscs: { args: string[]; command: string } };
}

function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'xscs-install-'));
}

describe('hook wiring', () => {
    test('covers the events the design depends on', () => {
        const map = hookMap('/usr/bin/bun', ENTRY, 'claude');
        expect(Object.keys(map).sort()).toEqual(['PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    });

    test('SessionEnd stays inside the Codex three-second ceiling', () => {
        const timeout = hookMap('/usr/bin/bun', ENTRY, 'codex').SessionEnd![0]!.hooks[0]!.timeout;
        expect(timeout).toBeLessThanOrEqual(3);
    });

    test('every command names the agent so the store attributes sessions correctly', () => {
        for (const agent of ['claude', 'codex'] as const) {
            for (const entries of Object.values(hookMap('/usr/bin/bun', ENTRY, agent))) {
                for (const entry of entries) {
                    for (const hook of entry.hooks) expect(hook.command).toContain(`--agent ${agent}`);
                }
            }
        }
    });

    test('paths with spaces are quoted', () => {
        const map = hookMap('/usr/local/my bun/bun', '/Users/a b/xscs.js', 'claude');
        expect(map.Stop![0]!.hooks[0]!.command).toContain('"/usr/local/my bun/bun"');
        expect(map.Stop![0]!.hooks[0]!.command).toContain('"/Users/a b/xscs.js"');
    });
});

describe('merge semantics', () => {
    test('foreign hooks on the same event survive', () => {
        const existing = {
            SessionStart: [{ hooks: [{ type: 'command' as const, command: 'echo hello' }] }],
        };
        const merged = mergeHooks(existing, hookMap('bun', ENTRY, 'claude'));
        expect(merged.SessionStart!.some((m) => m.hooks[0]!.command === 'echo hello')).toBe(true);
        expect(merged.SessionStart!.some((m) => m.hooks[0]!.command.includes('xscs.js'))).toBe(true);
    });

    test('re-installing replaces our entry instead of stacking duplicates', () => {
        const once = mergeHooks({}, hookMap('bun', ENTRY, 'claude'));
        const twice = mergeHooks(once, hookMap('bun', ENTRY, 'claude'));
        expect(twice.SessionStart).toHaveLength(1);
        expect(twice.Stop).toHaveLength(1);
    });
});

describe('install', () => {
    test('creates settings for both harnesses and registers MCP for Claude', () => {
        const dir = tmp();
        const claude = installClaude({ target: dir, entry: ENTRY, runtime: 'bun', withMcp: true });
        const codex = installCodex({ target: dir, entry: ENTRY, runtime: 'bun' });

        expect(claude.action).toBe('created');
        expect(codex.action).toBe('created');

        const settings = JSON.parse(readFileSync(claude.path, 'utf8')) as SettingsFixture;
        expect(settings.hooks.SessionStart).toBeDefined();
        const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as McpFixture;
        expect(mcp.mcpServers.xscs.args).toEqual([ENTRY, 'mcp']);

        const hooks = JSON.parse(readFileSync(codex.path, 'utf8')) as SettingsFixture;
        expect(hooks.hooks.SessionEnd).toBeDefined();
    });

    test('preserves unrelated settings and backs up the original', () => {
        const dir = tmp();
        mkdirSync(join(dir, '.claude'), { recursive: true });
        writeFileSync(
            join(dir, '.claude', 'settings.json'),
            JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }),
        );

        const res = installClaude({ target: dir, entry: ENTRY, runtime: 'bun' });
        expect(res.action).toBe('updated');
        expect(res.backup).toBeDefined();

        const settings = JSON.parse(readFileSync(res.path, 'utf8')) as SettingsFixture;
        expect(settings.model).toBe('opus');
        expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
        expect(settings.hooks.SessionStart).toBeDefined();
    });

    test('standalone configuration invokes the executable without a bunfs entry', () => {
        const dir = tmp();
        const executable = '/opt/xscs';
        const claude = installClaude({
            target: dir,
            entry: '/$bunfs/root/index.js',
            command: [executable],
            withMcp: true,
        });
        const codex = installCodex({ target: dir, entry: '/$bunfs/root/index.js', command: [executable] });

        const settings = JSON.parse(readFileSync(claude.path, 'utf8')) as SettingsFixture;
        const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as McpFixture;
        expect(mcp.mcpServers.xscs).toEqual({ command: executable, args: ['mcp'] });
        expect(JSON.stringify(settings)).not.toContain('$bunfs');
        expect(JSON.stringify(settings)).toContain(`${executable} hook`);
        expect(readFileSync(codex.path, 'utf8')).not.toContain('$bunfs');
    });

    test('Windows standalone paths remain one quoted command and one MCP executable', () => {
        const dir = tmp();
        const executable = String.raw`C:\Program Files\xscs\xscs-windows-x64.exe`;
        // Bun's Windows embedded filesystem is "B:\~BUN\...", not "$bunfs".
        const entry = String.raw`B:\~BUN\root\index.js`;
        const claude = installClaude({
            target: dir,
            entry,
            command: [executable],
            withMcp: true,
        });
        const codex = installCodex({
            target: dir,
            entry,
            command: [executable],
        });

        const settings = JSON.parse(readFileSync(claude.path, 'utf8')) as SettingsFixture;
        const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as McpFixture;
        expect(mcp.mcpServers.xscs).toEqual({ command: executable, args: ['mcp'] });
        const command = (
            settings.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>
        )[0]!.hooks[0]!.command;
        expect(command).toStartWith(`"${executable}" hook`);
        expect(command).not.toContain('$bunfs');
        expect(command).not.toContain('~BUN');
        expect(readFileSync(codex.path, 'utf8')).toContain(`C:\\\\Program Files\\\\xscs`);
    });

    test('is idempotent', () => {
        const dir = tmp();
        installClaude({ target: dir, entry: ENTRY, runtime: 'bun' });
        expect(installClaude({ target: dir, entry: ENTRY, runtime: 'bun' }).action).toBe('unchanged');
    });

    test('user-scoped Claude MCP preserves the user registry', () => {
        const dir = tmp();
        writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { foreign: { command: 'foreign' } } }));
        installClaude({ target: dir, entry: ENTRY, runtime: 'bun', withMcp: true, userScope: true });

        const registry = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as McpFixture & {
            mcpServers: Record<string, unknown>;
        };
        expect(registry.mcpServers.foreign).toEqual({ command: 'foreign' });
        expect(registry.mcpServers.xscs).toEqual({ command: 'bun', args: [ENTRY, 'mcp'] });
    });

    test('installs Kiro CLI 3 hooks, Kiro CLI 2 agent hooks, and MCP configuration', () => {
        const dir = tmp();
        const result = installKiro({ target: dir, entry: ENTRY, runtime: 'bun', withMcp: true });
        expect(result.path).toBe(join(dir, '.kiro', 'hooks', 'xscs.json'));
        const hooks = JSON.parse(readFileSync(result.path, 'utf8')) as { version: string; hooks: unknown[] };
        expect(hooks.version).toBe('v1');
        expect(hooks.hooks).toHaveLength(3);
        expect(hooks.hooks).toEqual(
            expect.arrayContaining([expect.objectContaining({ trigger: 'SessionStart' })]),
        );
        const agent = JSON.parse(readFileSync(join(dir, '.kiro', 'agents', 'xscs.json'), 'utf8')) as {
            includeMcpJson: boolean;
            hooks: Record<string, Array<{ command: string }>>;
            mcpServers: Record<string, { args: string[]; command: string }>;
        };
        expect(agent.includeMcpJson).toBe(true);
        expect(agent.mcpServers.xscs).toEqual({ command: 'bun', args: [ENTRY, 'mcp'] });
        expect(Object.keys(agent.hooks)).toEqual(['agentSpawn', 'userPromptSubmit', 'stop']);
        expect(agent.hooks.agentSpawn![0]!.command).toContain('--event SessionStart');
        const mcp = JSON.parse(readFileSync(join(dir, '.kiro', 'settings', 'mcp.json'), 'utf8')) as McpFixture;
        expect(mcp.mcpServers.xscs).toEqual({ command: 'bun', args: [ENTRY, 'mcp'] });

        const repeated = installKiro({ target: dir, entry: ENTRY, runtime: 'bun', withMcp: true });
        expect(repeated.action).toBe('unchanged');
        expect(repeated.companions?.[0]?.action).toBe('unchanged');
    });

    test('refuses to rewrite a settings file it cannot parse', () => {
        const dir = tmp();
        mkdirSync(join(dir, '.claude'), { recursive: true });
        writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json');
        expect(() => installClaude({ target: dir, entry: ENTRY, runtime: 'bun' })).toThrow(/not valid JSON/);
    });

    test('dry run writes nothing', () => {
        const dir = tmp();
        const res = installClaude({ target: dir, entry: ENTRY, runtime: 'bun', dryRun: true });
        expect(res.action).toBe('created');
        expect(() => readFileSync(res.path, 'utf8')).toThrow();
    });
});

describe('agent attribution', () => {
    test('explicit flag wins', () => {
        expect(resolveAgent({ hook_event_name: 'Stop' } as never, 'codex')).toBe('codex');
    });

    test('falls back to the transcript path shape', () => {
        expect(resolveAgent({ hook_event_name: 'Stop', transcript_path: '/u/.claude/projects/p/s.jsonl' } as never)).toBe(
            'claude',
        );
        expect(
            resolveAgent({ hook_event_name: 'Stop', transcript_path: '/u/.codex/sessions/2026/07/rollout-x.jsonl' } as never),
        ).toBe('codex');
    });
});
