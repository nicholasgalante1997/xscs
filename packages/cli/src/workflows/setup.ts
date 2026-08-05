import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
    listWorkspaces,
    processPlatform,
    recentSessions,
    stats,
    storePath,
} from '@xscs/core';

import { ConfigurationError } from '../errors';
import { installClaude, installCodex } from '../install';
import { makeCommandContext, writeCommandOutput } from './context';
import type {
    AllInput,
    ContextInput,
    InitInput,
} from './input';

/**
 * Hooks must point at the built bundle, never at TypeScript source: the harness
 * invokes this on a cold process dozens of times a session.
 */
export function resolveEntry(): string {
    const main = resolve(processPlatform().mainEntry);
    if (main.endsWith('.js')) return main;
    const built = resolve(main, '..', 'dist', 'xscs.js');
    if (existsSync(built)) return built;
    throw new ConfigurationError(`xscs is not built — run \`bun run build\` first (expected ${built})`);
}

export function cmdInit(input: InitInput): void {
    const context = makeCommandContext(input);
    const target = input.user ? homedir() : context.workspace.root;
    const entry = resolveEntry();
    const processes = processPlatform();
    const command = processes.mainEntry.includes('$bunfs') ? processes.selfCommand([]) : [process.execPath, entry];
    const both = !input.claude && !input.codex;
    const results: Array<{ harness: string; path: string; action: string; backup?: string }> = [];

    if (both || input.claude) {
        const result = installClaude({ target, entry, command, withMcp: input.withMcp, dryRun: input.dryRun });
        results.push({ harness: 'claude', ...result });
    }
    if (both || input.codex) {
        const result = installCodex({ target, entry, command, dryRun: input.dryRun });
        results.push({ harness: 'codex', ...result });
    }

    const lines = results.map(
        (result) =>
            `  ${result.harness.padEnd(7)} ${result.action.padEnd(9)} ${result.path}${result.backup ? ` (backup: ${result.backup})` : ''}`,
    );
    writeCommandOutput(
        context,
        [
            `xscs hooks ${input.dryRun ? 'would be ' : ''}installed for ${context.workspace.name}`,
            ...lines,
            '',
            `store:  ${storePath()}`,
            `entry:  ${command.join(' ')}`,
            '',
            !input.withMcp || !(both || input.claude)
                ? ''
                : 'Claude Code will expose the xscs MCP tools next session (context_search, context_remember, …).',
            'For Codex, register the MCP server with:',
            `  codex mcp add xscs -- ${command.join(' ')} mcp`,
        ]
            .filter(Boolean)
            .join('\n'),
        { workspace: context.workspace, entry: command.join(' '), store: storePath(), results },
    );
}

export function cmdStats(input: AllInput): void {
    const context = makeCommandContext(input);
    const global = input.all;
    const report = stats(context.db, global ? null : context.workspace.id);
    const sessions = recentSessions(context.db, global ? null : context.workspace.id, 5);
    writeCommandOutput(
        context,
        [
            `store:      ${storePath()}`,
            `scope:      ${global ? 'all workspaces' : context.workspace.name}`,
            `workspaces: ${report.workspaces}`,
            `sessions:   ${report.sessions} (${report.undistilled_sessions} not yet distilled)`,
            `events:     ${report.events}`,
            `items:      ${report.items} (${report.active_items} active, ${report.pinned_items} pinned)`,
            `by type:    ${Object.entries(report.by_type).map(([key, value]) => `${key}=${value}`).join(' ') || '—'}`,
            '',
            'recent sessions:',
            ...sessions.map(
                (session) =>
                    `  ${new Date(session.started_at).toISOString().slice(0, 16).replace('T', ' ')}  ${session.agent.padEnd(6)} ${session.prompt_count}p/${session.turn_count}t  ${session.end_reason ?? 'open'}`,
            ),
        ].join('\n'),
        { stats: report, sessions },
    );
}

export function cmdDoctor(input: ContextInput): void {
    const context = makeCommandContext(input);
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    checks.push({ name: 'store', ok: existsSync(storePath()), detail: storePath() });
    checks.push({ name: 'workspace', ok: true, detail: `${context.workspace.name} → ${context.workspace.root}` });
    checks.push({ name: 'git branch', ok: context.branch !== null, detail: context.branch ?? 'not a git repo' });

    for (const [harness, path] of [
        ['claude project hooks', `${context.workspace.root}/.claude/settings.json`],
        ['claude user hooks', `${homedir()}/.claude/settings.json`],
        ['codex project hooks', `${context.workspace.root}/.codex/hooks.json`],
        ['codex user hooks', `${homedir()}/.codex/hooks.json`],
    ] as const) {
        const present = existsSync(path);
        const wired = present && statSync(path).size > 0 ? hasXscsHook(path) : false;
        checks.push({
            name: harness,
            ok: wired,
            detail: present ? (wired ? `wired: ${path}` : `present but not wired: ${path}`) : 'absent',
        });
    }

    const claude = processPlatform().which('claude');
    const codex = processPlatform().which('codex');
    checks.push({ name: 'claude cli', ok: claude !== null, detail: claude ?? 'not on PATH' });
    checks.push({ name: 'codex cli', ok: codex !== null, detail: codex ?? 'not on PATH' });

    const report = stats(context.db, context.workspace.id);
    checks.push({
        name: 'recall health',
        ok: report.active_items > 0,
        detail: `${report.active_items} active item(s), ${report.undistilled_sessions} session(s) awaiting distillation`,
    });

    writeCommandOutput(
        context,
        checks.map((check) => `${check.ok ? '✓' : '·'} ${check.name.padEnd(22)} ${check.detail}`).join('\n'),
        checks,
    );
}

export function cmdWorkspaces(input: ContextInput): void {
    const context = makeCommandContext(input);
    const workspaces = listWorkspaces(context.db);
    writeCommandOutput(
        context,
        workspaces
            .map((workspace) => {
                const report = stats(context.db, workspace.id);
                return `${workspace.name.padEnd(28)} ${String(report.active_items).padStart(4)} items  ${String(report.sessions).padStart(4)} sessions  ${workspace.root}`;
            })
            .join('\n') || '(no workspaces recorded)',
        workspaces,
    );
}

function hasXscsHook(path: string): boolean {
    try {
        const text = readFileSync(path, 'utf8');
        return text.includes('xscs') && text.includes('hook');
    } catch {
        return false;
    }
}
