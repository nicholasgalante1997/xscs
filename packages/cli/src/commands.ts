import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
    buildBrief,
    type DB,
    decay,
    deleteItem,
    dismissDrift,
    distillPending,
    distillSession,
    ensureWorkspace,
    findDriftCandidates,
    getItem,
    getSession,
    type Item,
    type ItemStatus,
    type ItemType,
    listItems,
    listWorkspaces,
    openStore,
    pruneBriefs,
    pruneEvents,
    putItem,
    recentSessions,
    renderHandoff,
    searchItems,
    setItemPinned,
    setItemScope,
    setItemStatus,
    stats,
    storePath,
    type Workspace,
} from '@xscs/core';

import { type Args, flagBool, flagList, flagNumber, flagString } from './args';
import { currentBranch } from './git';
import { installClaude, installCodex } from './install';

interface Ctx {
    db: DB;
    workspace: Workspace;
    branch: string | null;
    json: boolean;
}

export function makeCtx(args: Args): Ctx {
    const db = openStore();
    const cwd = resolve(flagString(args, 'cwd') ?? process.cwd());
    const workspace = ensureWorkspace(db, cwd);
    return { db, workspace, branch: currentBranch(workspace.root), json: flagBool(args, 'json') };
}

function out(ctx: Ctx, human: string, data: unknown): void {
    if (ctx.json) console.log(JSON.stringify(data, null, 2));
    else console.log(human);
}

/* ------------------------------------------------------------------- init */

/**
 * Hooks must point at the built bundle, never at TypeScript source: the harness
 * invokes this on a cold process dozens of times a session, and a stale or
 * unbuilt source tree would fail silently at exactly the moment it matters.
 */
export function resolveEntry(): string {
    const main = resolve(Bun.main);
    if (main.endsWith('.js')) return main;
    const built = resolve(main, '..', 'dist', 'xscs.js');
    if (existsSync(built)) return built;
    throw new Error(`xscs is not built — run \`bun run build\` first (expected ${built})`);
}

export function cmdInit(args: Args): void {
    const ctx = makeCtx(args);
    const user = flagBool(args, 'user');
    const target = user ? homedir() : ctx.workspace.root;
    const entry = resolveEntry();
    const both = !flagBool(args, 'claude') && !flagBool(args, 'codex');
    const dryRun = flagBool(args, 'dry-run');
    const results: Array<{ harness: string; path: string; action: string; backup?: string }> = [];

    if (both || flagBool(args, 'claude')) {
        const r = installClaude({ target, entry, withMcp: !flagBool(args, 'no-mcp'), dryRun });
        results.push({ harness: 'claude', ...r });
    }
    if (both || flagBool(args, 'codex')) {
        const r = installCodex({ target, entry, dryRun });
        results.push({ harness: 'codex', ...r });
    }

    const lines = results.map((r) => `  ${r.harness.padEnd(7)} ${r.action.padEnd(9)} ${r.path}${r.backup ? ` (backup: ${r.backup})` : ''}`);
    out(
        ctx,
        [
            `xscs hooks ${dryRun ? 'would be ' : ''}installed for ${ctx.workspace.name}`,
            ...lines,
            '',
            `store:  ${storePath()}`,
            `entry:  ${entry}`,
            '',
            flagBool(args, 'no-mcp') || !(both || flagBool(args, 'claude'))
                ? ''
                : 'Claude Code will expose the xscs MCP tools next session (context_search, context_remember, …).',
            'For Codex, register the MCP server with:',
            `  codex mcp add xscs -- ${process.execPath} ${entry} mcp`,
        ]
            .filter(Boolean)
            .join('\n'),
        { workspace: ctx.workspace, entry, store: storePath(), results },
    );
}

/* ---------------------------------------------------------------- distill */

export async function cmdDistill(args: Args): Promise<void> {
    const ctx = makeCtx(args);
    const modeFlag = flagString(args, 'mode');
    const mode = modeFlag === 'agent' || modeFlag === 'both' ? modeFlag : 'heuristic';
    const dryRun = flagBool(args, 'dry-run');
    const quiet = flagBool(args, 'quiet');

    const sessionId = flagString(args, 'session');
    const reports = sessionId
        ? await (async () => {
              const session = getSession(ctx.db, sessionId);
              if (!session) return [];
              return [await distillSession(ctx.db, session, { mode, dryRun, backend: flagString(args, 'backend') as never })];
          })()
        : await distillPending(ctx.db, { mode, dryRun, limit: flagNumber(args, 'limit') ?? 10 });

    if (flagBool(args, 'handoff')) {
        try {
            renderHandoff(ctx.db, ctx.workspace, { branch: ctx.branch });
        } catch {
            /* handoff is best-effort */
        }
    }

    if (quiet && !ctx.json) return;

    const created = reports.reduce((n, r) => n + r.created, 0);
    const reinforced = reports.reduce((n, r) => n + r.reinforced, 0);
    const errors = reports.filter((r) => r.error);
    out(
        ctx,
        [
            `distilled ${reports.length} session(s) in ${mode} mode${dryRun ? ' (dry run)' : ''}`,
            `  created:    ${created}`,
            `  reinforced: ${reinforced}`,
            ...(dryRun ? reports.flatMap((r) => r.drafts.map((d) => `  · [${d.type}] ${d.title}`)) : []),
            ...errors.map((e) => `  ! ${e.session_id}: ${e.error}`),
        ].join('\n'),
        reports,
    );
}

/* ------------------------------------------------------------------ brief */

export function cmdBrief(args: Args): void {
    const ctx = makeCtx(args);
    const brief = buildBrief(ctx.db, {
        workspace_id: ctx.workspace.id,
        branch: ctx.branch,
        query: flagString(args, 'query') ?? (args.positionals.join(' ') || null),
        budgetTokens: flagNumber(args, 'budget') ?? 1200,
        reason: 'manual',
        workspaceName: ctx.workspace.name,
    });
    out(ctx, brief.text || '(no durable context stored for this workspace yet)', brief);
}

export function cmdHandoff(args: Args): void {
    const ctx = makeCtx(args);
    const text = renderHandoff(ctx.db, ctx.workspace, {
        branch: ctx.branch,
        write: !flagBool(args, 'stdout'),
        budgetTokens: flagNumber(args, 'budget'),
    });
    out(ctx, text, { text });
}

/* ------------------------------------------------------------------ items */

export function cmdSearch(args: Args): void {
    const ctx = makeCtx(args);
    const query = args.positionals.join(' ') || flagString(args, 'query') || '';
    const hits = searchItems(ctx.db, query, { workspace_id: ctx.workspace.id, limit: flagNumber(args, 'limit') ?? 15 });
    out(ctx, hits.length ? hits.map((h) => formatItem(h.item, h.relevance)).join('\n\n') : '(no matches)', hits);
}

export function cmdList(args: Args): void {
    const ctx = makeCtx(args);
    const items = listItems(ctx.db, {
        workspace_id: ctx.workspace.id,
        status: (flagList(args, 'status') as ItemStatus[]).length
            ? (flagList(args, 'status') as ItemStatus[])
            : ['active'],
        type: flagList(args, 'type').length ? (flagList(args, 'type') as ItemType[]) : undefined,
        limit: flagNumber(args, 'limit') ?? 60,
    });
    out(ctx, items.length ? items.map((i) => formatItem(i)).join('\n\n') : '(nothing stored)', items);
}

export function cmdRemember(args: Args): void {
    const ctx = makeCtx(args);
    const title = flagString(args, 'title') ?? args.positionals.join(' ');
    const body = flagString(args, 'body') ?? title;
    if (!title) {
        console.error('usage: xscs remember --type <type> --title "..." [--body "..."] [--why "..."] [--pin]');
        process.exitCode = 1;
        return;
    }
    const scope = flagString(args, 'scope');
    const res = putItem(ctx.db, {
        type: (flagString(args, 'type') ?? 'fact') as ItemType,
        title,
        body,
        why: flagString(args, 'why') ?? null,
        scope: scope === 'global' || scope === 'branch' || scope === 'session' ? scope : 'workspace',
        scope_key: scope === 'branch' ? ctx.branch : null,
        tags: flagList(args, 'tag'),
        confidence: flagNumber(args, 'confidence') ?? 0.7,
        pinned: flagBool(args, 'pin'),
        status: 'active',
        source: 'manual',
        workspace_id: ctx.workspace.id,
    });
    out(ctx, `${res.created ? 'stored' : 'reinforced'} ${res.item.id}\n${formatItem(res.item)}`, res);
}

/**
 * The review queue. Everything a distiller infers lands as `proposed` and stays
 * out of every brief until a human accepts it. This is the single most important
 * control in the system: it is what keeps the store's precision from degrading as
 * its volume grows.
 */
export function cmdReview(args: Args): void {
    const ctx = makeCtx(args);
    const accept = flagList(args, 'accept');
    const reject = flagList(args, 'reject');

    if (accept.length || reject.length) {
        for (const id of accept) setItemStatus(ctx.db, id, 'active');
        for (const id of reject) setItemStatus(ctx.db, id, 'rejected');
        out(ctx, `accepted ${accept.length}, rejected ${reject.length}`, { accept, reject });
        return;
    }

    if (flagBool(args, 'accept-all')) {
        const proposed = listItems(ctx.db, { workspace_id: ctx.workspace.id, status: 'proposed', limit: 500 });
        for (const item of proposed) setItemStatus(ctx.db, item.id, 'active');
        out(ctx, `accepted ${proposed.length} proposed items`, proposed);
        return;
    }

    const proposed = listItems(ctx.db, { workspace_id: ctx.workspace.id, status: 'proposed', limit: 100 });
    out(
        ctx,
        proposed.length
            ? [
                  `${proposed.length} item(s) awaiting review for ${ctx.workspace.name}:\n`,
                  proposed.map((i) => formatItem(i)).join('\n\n'),
                  '\naccept: xscs review --accept <id> [--accept <id>]',
                  'reject: xscs review --reject <id>',
                  'or open the dashboard: xscs serve',
              ].join('\n')
            : '(review queue is empty)',
        proposed,
    );
}

export function cmdPin(args: Args, pinned: boolean): void {
    const ctx = makeCtx(args);
    const ids = args.positionals;
    for (const id of ids) setItemPinned(ctx.db, id, pinned);
    out(ctx, `${pinned ? 'pinned' : 'unpinned'} ${ids.length} item(s)`, { ids, pinned });
}

export function cmdForget(args: Args): void {
    const ctx = makeCtx(args);
    const ids = args.positionals;
    const removed: string[] = [];
    for (const id of ids) {
        if (!getItem(ctx.db, id)) continue;
        deleteItem(ctx.db, id);
        removed.push(id);
    }
    out(ctx, `deleted ${removed.length} item(s)`, removed);
}

export function cmdPromote(args: Args): void {
    const ctx = makeCtx(args);
    const scope = flagString(args, 'scope') ?? 'global';
    if (scope !== 'global' && scope !== 'workspace' && scope !== 'branch') {
        console.error('scope must be global, workspace or branch');
        process.exitCode = 1;
        return;
    }
    for (const id of args.positionals) {
        setItemScope(ctx.db, id, scope, scope === 'branch' ? ctx.branch : null);
    }
    out(ctx, `moved ${args.positionals.length} item(s) to ${scope} scope`, { ids: args.positionals, scope });
}

/* ------------------------------------------------------------- maintenance */

export function cmdConflicts(args: Args): void {
    const ctx = makeCtx(args);
    const dismiss = flagList(args, 'dismiss');
    if (dismiss.length === 2) {
        dismissDrift(ctx.db, dismiss[0]!, dismiss[1]!);
        out(ctx, 'dismissed', dismiss);
        return;
    }
    const candidates = findDriftCandidates(ctx.db, ctx.workspace.id, flagNumber(args, 'limit') ?? 20);
    out(
        ctx,
        candidates.length
            ? candidates
                  .map(
                      (c) =>
                          `[${c.kind}] overlap ${(c.overlap * 100).toFixed(0)}% — ${c.hint}\n  A ${c.a.id}  ${c.a.title}\n  B ${c.b.id}  ${c.b.title}`,
                  )
                  .join('\n\n')
            : '(no conflicts detected)',
        candidates,
    );
}

export function cmdPrune(args: Args): void {
    const ctx = makeCtx(args);
    const decayReport = decay(ctx.db, { force: true });
    const events = pruneEvents(ctx.db, flagNumber(args, 'events-days') ?? 60);
    const briefs = pruneBriefs(ctx.db, flagNumber(args, 'briefs-days') ?? 30);
    ctx.db.run('VACUUM');
    out(
        ctx,
        [
            `decayed ${decayReport.decayed} item(s)`,
            `archived ${decayReport.archived} low-confidence item(s)`,
            `archived ${decayReport.staleThreads} stale open thread(s)`,
            `deleted ${events} consumed event(s), ${briefs} old brief(s)`,
        ].join('\n'),
        { decay: decayReport, events, briefs },
    );
}

export function cmdStats(args: Args): void {
    const ctx = makeCtx(args);
    const global = flagBool(args, 'all');
    const s = stats(ctx.db, global ? null : ctx.workspace.id);
    const sessions = recentSessions(ctx.db, global ? null : ctx.workspace.id, 5);
    out(
        ctx,
        [
            `store:      ${storePath()}`,
            `scope:      ${global ? 'all workspaces' : ctx.workspace.name}`,
            `workspaces: ${s.workspaces}`,
            `sessions:   ${s.sessions} (${s.undistilled_sessions} not yet distilled)`,
            `events:     ${s.events}`,
            `items:      ${s.items} (${s.active_items} active, ${s.pinned_items} pinned)`,
            `by type:    ${Object.entries(s.by_type).map(([k, v]) => `${k}=${v}`).join(' ') || '—'}`,
            '',
            'recent sessions:',
            ...sessions.map(
                (x) =>
                    `  ${new Date(x.started_at).toISOString().slice(0, 16).replace('T', ' ')}  ${x.agent.padEnd(6)} ${x.prompt_count}p/${x.turn_count}t  ${x.end_reason ?? 'open'}`,
            ),
        ].join('\n'),
        { stats: s, sessions },
    );
}

export function cmdDoctor(args: Args): void {
    const ctx = makeCtx(args);
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    checks.push({ name: 'store', ok: existsSync(storePath()), detail: storePath() });
    checks.push({ name: 'workspace', ok: true, detail: `${ctx.workspace.name} → ${ctx.workspace.root}` });
    checks.push({ name: 'git branch', ok: ctx.branch !== null, detail: ctx.branch ?? 'not a git repo' });

    for (const [harness, path] of [
        ['claude project hooks', `${ctx.workspace.root}/.claude/settings.json`],
        ['claude user hooks', `${homedir()}/.claude/settings.json`],
        ['codex project hooks', `${ctx.workspace.root}/.codex/hooks.json`],
        ['codex user hooks', `${homedir()}/.codex/hooks.json`],
    ] as const) {
        const present = existsSync(path);
        const wired = present && Bun.file(path).size > 0 ? hasXscsHook(path) : false;
        checks.push({ name: harness, ok: wired, detail: present ? (wired ? `wired: ${path}` : `present but not wired: ${path}`) : 'absent' });
    }

    checks.push({ name: 'claude cli', ok: Bun.which('claude') !== null, detail: Bun.which('claude') ?? 'not on PATH' });
    checks.push({ name: 'codex cli', ok: Bun.which('codex') !== null, detail: Bun.which('codex') ?? 'not on PATH' });

    const s = stats(ctx.db, ctx.workspace.id);
    checks.push({
        name: 'recall health',
        ok: s.active_items > 0,
        detail: `${s.active_items} active item(s), ${s.undistilled_sessions} session(s) awaiting distillation`,
    });

    out(ctx, checks.map((c) => `${c.ok ? '✓' : '·'} ${c.name.padEnd(22)} ${c.detail}`).join('\n'), checks);
}

function hasXscsHook(path: string): boolean {
    try {
        const text = readFileSync(path, 'utf8');
        return text.includes('xscs') && text.includes('hook');
    } catch {
        return false;
    }
}

export function cmdWorkspaces(args: Args): void {
    const ctx = makeCtx(args);
    const workspaces = listWorkspaces(ctx.db);
    out(
        ctx,
        workspaces
            .map((w) => {
                const s = stats(ctx.db, w.id);
                return `${w.name.padEnd(28)} ${String(s.active_items).padStart(4)} items  ${String(s.sessions).padStart(4)} sessions  ${w.root}`;
            })
            .join('\n') || '(no workspaces recorded)',
        workspaces,
    );
}

export function cmdExport(args: Args): void {
    const ctx = makeCtx(args);
    const all = flagBool(args, 'all');
    const items = listItems(ctx.db, {
        workspace_id: all ? null : ctx.workspace.id,
        status: ['active', 'proposed', 'archived', 'superseded'],
        limit: 10_000,
    });
    console.log(JSON.stringify({ version: 1, exported_at: Date.now(), items }, null, 2));
}

/* ---------------------------------------------------------------- helpers */

function formatItem(item: Item, relevance?: number): string {
    const flags = [
        item.pinned ? 'pinned' : null,
        item.status !== 'active' ? item.status : null,
        item.scope !== 'workspace' ? item.scope : null,
        relevance !== undefined ? `rel ${relevance.toFixed(2)}` : null,
    ].filter(Boolean);
    return [
        `${item.id}  [${item.type}] ${item.title}`,
        `  ${item.body.replace(/\n/g, '\n  ')}`,
        item.why ? `  why: ${item.why}` : null,
        `  conf ${item.confidence.toFixed(2)}  used ${item.use_count}×  src ${item.source}${flags.length ? '  ' + flags.join(' ') : ''}`,
    ]
        .filter(Boolean)
        .join('\n');
}
