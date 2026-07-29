import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface HookCommand {
    type: 'command';
    command: string;
    timeout?: number;
    statusMessage?: string;
}

interface HookMatcher {
    matcher?: string;
    hooks: HookCommand[];
}

type HookMap = Record<string, HookMatcher[]>;

export interface InstallOptions {
    /** Directory whose `.claude` / `.codex` folder we write into. */
    target: string;
    /** Absolute path to the xscs entrypoint, invoked with the bun runtime. */
    entry: string;
    runtime?: string;
    /** Also register the MCP server so the agent can read and write memory on purpose. */
    withMcp?: boolean;
    dryRun?: boolean;
}

export interface InstallResult {
    path: string;
    action: 'created' | 'updated' | 'unchanged';
    backup?: string;
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
    const cmd = (event: string): string => `${quote(runtime)} ${quote(entry)} hook --agent ${agent} --event ${event}`;
    return {
        SessionStart: [
            {
                matcher: 'startup|resume|clear|compact|fork',
                hooks: [{ type: 'command', command: cmd('SessionStart'), timeout: 20, statusMessage: 'Recalling stored context' }],
            },
        ],
        UserPromptSubmit: [
            { hooks: [{ type: 'command', command: cmd('UserPromptSubmit'), timeout: 15 }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: cmd('Stop'), timeout: 10 }] }],
        PreCompact: [{ matcher: 'manual|auto', hooks: [{ type: 'command', command: cmd('PreCompact'), timeout: 20 }] }],
        // Codex caps SessionEnd at three seconds; the handler only writes a row
        // and detaches, so this is comfortable for both harnesses.
        SessionEnd: [{ hooks: [{ type: 'command', command: cmd('SessionEnd'), timeout: 3 }] }],
    };
}

export function installClaude(opts: InstallOptions): InstallResult {
    const dir = join(opts.target, '.claude');
    const file = join(dir, 'settings.json');
    const runtime = opts.runtime ?? process.execPath;
    const existing = readJson(file);
    const next: Record<string, unknown> = {
        ...existing,
        hooks: mergeHooks(asHookMap(existing.hooks), hookMap(runtime, opts.entry, 'claude')),
    };

    if (opts.withMcp) {
        const servers = isRecord(next.mcpServers) ? { ...next.mcpServers } : {};
        servers.xscs = { command: runtime, args: [opts.entry, 'mcp'] };
        next.mcpServers = servers;
    }

    return writeJson(file, dir, next, existing, opts.dryRun);
}

/**
 * Codex reads `hooks.json` (or a `[hooks]` table in config.toml). We write the
 * JSON file because it round-trips cleanly and does not risk mangling a user's
 * hand-written TOML config.
 */
export function installCodex(opts: InstallOptions): InstallResult {
    const dir = join(opts.target, '.codex');
    const file = join(dir, 'hooks.json');
    const runtime = opts.runtime ?? process.execPath;
    const existing = readJson(file);
    const next: Record<string, unknown> = {
        ...existing,
        hooks: mergeHooks(asHookMap(existing.hooks), hookMap(runtime, opts.entry, 'codex')),
    };
    return writeJson(file, dir, next, existing, opts.dryRun);
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
    const out: HookMap = { ...existing };
    for (const [event, matchers] of Object.entries(ours)) {
        const kept = (out[event] ?? []).filter((entry) => !entry.hooks?.some((h) => isOurs(h.command)));
        out[event] = [...kept, ...matchers];
    }
    return out;
}

function isOurs(command: string | undefined): boolean {
    return typeof command === 'string' && / hook (--agent \w+ )?--event /.test(command) && command.includes('xscs');
}

function asHookMap(value: unknown): HookMap {
    return isRecord(value) ? (value as HookMap) : {};
}

function readJson(file: string): Record<string, unknown> {
    if (!existsSync(file)) return {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return isRecord(parsed) ? parsed : {};
    } catch {
        // A settings file we cannot parse is a settings file we must not rewrite.
        throw new Error(`${file} exists but is not valid JSON — fix or move it before installing hooks.`);
    }
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

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function quote(s: string): string {
    return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
