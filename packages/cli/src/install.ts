import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
    claudeHarness,
    codexHarness,
    type HarnessAdapter,
    type HookMap,
    mergeHookMaps,
} from './harness';

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
    return (agent === 'claude' ? claudeHarness : codexHarness).buildHookMap(runtime, entry);
}

export function installClaude(opts: InstallOptions): InstallResult {
    return installHarness(claudeHarness, opts);
}

/**
 * Codex reads `hooks.json` (or a `[hooks]` table in config.toml). We write the
 * JSON file because it round-trips cleanly and does not risk mangling a user's
 * hand-written TOML config.
 */
export function installCodex(opts: InstallOptions): InstallResult {
    return installHarness(codexHarness, opts);
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
    const dir = join(opts.target, adapter.configDirectory);
    const file = join(dir, adapter.configFile);
    const runtime = opts.runtime ?? process.execPath;
    const existing = readJson(file);
    const next = adapter.applyConfiguration(existing, runtime, opts.entry, opts.withMcp ?? false);
    return writeJson(file, dir, next, existing, opts.dryRun);
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
