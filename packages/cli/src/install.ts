import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ConfigurationError } from './errors';
import {
    applyKiro2AgentConfiguration,
    claudeHarness,
    codexHarness,
    type HarnessAdapter,
    type HookMap,
    kiroHarness,
    mergeHookMaps,
} from './harness';

export interface InstallOptions {
    /** Directory whose harness configuration folder we write into. */
    target: string;
    /** Absolute path to the xscs entrypoint, invoked with the bun runtime. */
    entry: string;
    runtime?: string;
    /** Full self-invocation prefix. Standalone executables have no entry argument. */
    command?: string[];
    /** Also register the MCP server so the agent can read and write memory on purpose. */
    withMcp?: boolean;
    /** Use the harness's user-wide MCP registry rather than the project registry. */
    userScope?: boolean;
    dryRun?: boolean;
}

export interface InstallResult {
    path: string;
    action: 'created' | 'updated' | 'unchanged';
    backup?: string;
    companions?: InstallResult[];
}

/**
 * Hook wiring, per harness.
 *
 * The event set is chosen for coverage-per-interruption:
 *   SessionStart      — inject recalled context into a cold window
 *   UserPromptSubmit  — capture intent, top up recall when the task is stated
 *   Stop              — cheap per-turn checkpoint
 *   PreCompact        — capture before the window is destroyed
 *   SessionEnd        — close the session, hand distillation to a detached process
 *
 * PostToolUse is deliberately *not* installed by default: it fires dozens of
 * times per turn, and everything it would tell us is already recoverable from
 * the transcript at distillation time.
 */
export function hookMap(runtime: string, entry: string, agent: 'claude' | 'codex'): HookMap {
    return (agent === 'claude' ? claudeHarness : codexHarness).buildHookMap([runtime, entry]);
}

export function installClaude(opts: InstallOptions): InstallResult {
    if (opts.withMcp) readJson(claudeMcpPath(opts));
    const result = installHarness(claudeHarness, opts);
    if (opts.withMcp) installClaudeMcp(opts);
    return result;
}

/**
 * Codex reads `hooks.json` (or a `[hooks]` table in config.toml). We write the
 * JSON file because it round-trips cleanly and does not risk mangling a user's
 * hand-written TOML config.
 */
export function installCodex(opts: InstallOptions): InstallResult {
    return installHarness(codexHarness, opts);
}

export function installKiro(opts: InstallOptions): InstallResult {
    if (opts.withMcp) readJson(kiroMcpPath(opts));
    const agentFile = join(opts.target, '.kiro', 'agents', 'xscs.json');
    const existingAgent = readJson(agentFile);
    const result = installHarness(kiroHarness, opts);
    const runtime = opts.runtime ?? process.execPath;
    const command = opts.command ?? [runtime, opts.entry];
    const agent = writeJson(
        agentFile,
        dirname(agentFile),
        applyKiro2AgentConfiguration(existingAgent, command, opts.withMcp ?? false),
        existingAgent,
        opts.dryRun,
    );
    result.companions = [agent];
    if (opts.withMcp) installKiroMcp(opts);
    return result;
}

export function userClaudeDir(): string {
    return homedir();
}

/**
 * Merge rather than overwrite, and identify our own entries by their command
 * containing the xscs entrypoint, so re-running install updates in place instead
 * of stacking duplicates on top of a user's existing hooks.
 */
export function mergeHooks(existing: HookMap, ours: HookMap): HookMap {
    return mergeHookMaps(existing, ours);
}

function installHarness(adapter: HarnessAdapter, opts: InstallOptions): InstallResult {
    const file = join(opts.target, adapter.configDirectory, adapter.configFile);
    const dir = dirname(file);
    const runtime = opts.runtime ?? process.execPath;
    const command = opts.command ?? [runtime, opts.entry];
    const existing = readJson(file);
    const next = adapter.applyConfiguration(existing, command, opts.withMcp ?? false);
    return writeJson(file, dir, next, existing, opts.dryRun);
}

function installClaudeMcp(opts: InstallOptions): InstallResult {
    const file = claudeMcpPath(opts);
    const dir = opts.userScope ? opts.target : join(opts.target);
    const existing = readJson(file);
    const servers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
    const runtime = opts.runtime ?? process.execPath;
    const command = opts.command ?? [runtime, opts.entry];
    servers.xscs = { command: command[0], args: [...command.slice(1), 'mcp'] };
    return writeJson(file, dir, { ...existing, mcpServers: servers }, existing, opts.dryRun);
}

function claudeMcpPath(opts: InstallOptions): string {
    return opts.userScope ? join(opts.target, '.claude.json') : join(opts.target, '.mcp.json');
}

function installKiroMcp(opts: InstallOptions): InstallResult {
    const file = kiroMcpPath(opts);
    const dir = dirname(file);
    const existing = readJson(file);
    const servers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
    const command = opts.command ?? [opts.runtime ?? process.execPath, opts.entry];
    servers.xscs = { command: command[0], args: [...command.slice(1), 'mcp'] };
    return writeJson(file, dir, { ...existing, mcpServers: servers }, existing, opts.dryRun);
}

function kiroMcpPath(opts: InstallOptions): string {
    return join(opts.target, '.kiro', 'settings', 'mcp.json');
}

function readJson(file: string): Record<string, unknown> {
    if (!existsSync(file)) return {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return isRecord(parsed) ? parsed : {};
    } catch {
        // A settings file we cannot parse is a settings file we must not rewrite.
        throw new ConfigurationError(`${file} exists but is not valid JSON — fix or move it before installing hooks.`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function writeJson(
    file: string,
    dir: string,
    next: Record<string, unknown>,
    existing: Record<string, unknown>,
    dryRun?: boolean,
): InstallResult {
    const serialised = JSON.stringify(next, null, 2) + '\n';
    const had = existsSync(file);
    if (had && readFileSync(file, 'utf8') === serialised) return { path: file, action: 'unchanged' };
    if (dryRun) return { path: file, action: had ? 'updated' : 'created' };

    mkdirSync(dir, { recursive: true });
    let backup: string | undefined;
    if (had && Object.keys(existing).length > 0) {
        backup = `${file}.xscs-backup-${Date.now()}`;
        copyFileSync(file, backup);
    }
    writeFileSync(file, serialised, 'utf8');
    return { path: file, action: had ? 'updated' : 'created', backup };
}
