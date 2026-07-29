import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Where the store lives. One database serves every harness and every workspace on
 * the machine, which is the whole point: context written by Codex in a Tuesday
 * session has to be readable by Claude Code on Thursday.
 *
 * Override with XSCS_HOME (useful for tests and for per-machine sync setups).
 */
export function xscsHome(): string {
    const override = process.env.XSCS_HOME;
    if (override && override.trim().length > 0) return resolve(override);
    return join(homedir(), '.xscs');
}

export function storePath(): string {
    const override = process.env.XSCS_DB;
    if (override && override.trim().length > 0) return resolve(override);
    return join(xscsHome(), 'store.db');
}

export function logPath(): string {
    return join(xscsHome(), 'xscs.log');
}

/**
 * Walk up from `start` looking for a project boundary. `.git` wins; failing that
 * any of the agent/workspace marker files; failing that, `start` itself.
 *
 * Resolution is deliberately cheap (pure `existsSync`) because this runs inside
 * hooks whose entire budget is measured in hundreds of milliseconds.
 */
const WORKSPACE_MARKERS = ['.git', '.xscs', 'package.json', 'AGENTS.md', 'CLAUDE.md', 'go.mod', 'Cargo.toml', 'pyproject.toml'] as const;

export function findWorkspaceRoot(start: string = process.cwd()): string {
    let dir = resolve(start);
    const seen = new Set<string>();
    // `.git` is authoritative, so do a dedicated pass for it before falling back
    // to weaker markers that can appear in nested packages of a monorepo.
    while (!seen.has(dir)) {
        seen.add(dir);
        if (existsSync(join(dir, '.git'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    dir = resolve(start);
    seen.clear();
    while (!seen.has(dir)) {
        seen.add(dir);
        for (const marker of WORKSPACE_MARKERS) {
            if (existsSync(join(dir, marker))) return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(start);
}

/** Stable, filesystem-independent identity for a workspace root. */
export function workspaceId(root: string): string {
    return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
}

export function workspaceName(root: string): string {
    const parts = resolve(root).split(sep).filter(Boolean);
    return parts[parts.length - 1] ?? root;
}

/** Per-project directory for human-readable artifacts (handoff notes, config). */
export function projectDir(root: string): string {
    return join(root, '.xscs');
}

export function handoffPath(root: string): string {
    return join(projectDir(root), 'HANDOFF.md');
}
