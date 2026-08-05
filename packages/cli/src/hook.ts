import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
    type AgentKind,
    appendEvent,
    buildBrief,
    bumpSessionCounter,
    type DB,
    decay,
    endSession,
    ensureWorkspace,
    estimateTokens,
    HookInput,
    logPath,
    openStore,
    processPlatform,
    recordBrief,
    renderHandoff,
    searchItems,
    type Session,
    touchItems,
    truncateToTokens,
    upsertSession,
    type Workspace,
} from '@xscs/core';

import { currentBranch } from './git';
import { harnessFor, recognizeHarness } from './harness';

/**
 * Hook output contract. Claude Code and Codex agree on this shape: a JSON object
 * on stdout, with model-visible text under `hookSpecificOutput.additionalContext`.
 * Exit code 0 always — a memory system must never be able to break the harness it
 * is attached to.
 */
interface HookOutput {
    continue?: boolean;
    suppressOutput?: boolean;
    systemMessage?: string;
    hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
    };
}

export interface HookArgs {
    agent?: AgentKind;
    event?: string;
    /** Token ceiling for injected context. */
    budget?: number;
    /** Disable prompt-time top-up recall. */
    noTopup?: boolean;
    /** Do not spawn background distillation. */
    noBackground?: boolean;
}

const MAX_TOPUPS_PER_SESSION = 3;

export async function runHook(args: HookArgs): Promise<void> {
    // A distiller subprocess is itself an agent session. Without this guard the
    // store would recursively record its own attempts to summarise the store.
    if (process.env.XSCS_INTERNAL === '1') {
        process.stdout.write('{}');
        return;
    }

    let raw = '';
    try {
        raw = await processPlatform().readStdin();
    } catch {
        raw = '';
    }

    let input: HookInput;
    try {
        const decoded: unknown = JSON.parse(raw || '{}');
        const adapter = args.agent ? harnessFor(args.agent) : null;
        if (adapter) {
            const normalized = adapter.normalizeHookPayload(decoded);
            if (!normalized) {
                logError('hook input did not match contract');
                process.stdout.write('{}');
                return;
            }
            input = normalized;
        } else {
            const parsed = HookInput.safeParse(decoded);
            if (!parsed.success) {
                logError('hook input did not match contract', parsed.error.message);
                process.stdout.write('{}');
                return;
            }
            input = parsed.data;
        }
    } catch (e) {
        logError('hook input was not JSON', e);
        process.stdout.write('{}');
        return;
    }

    const event = args.event ?? input.hook_event_name ?? 'unknown';

    try {
        const output = await handle(event, input, args);
        process.stdout.write(JSON.stringify(output ?? {}));
    } catch (e) {
        // Swallow and log. A hook that throws is a hook the user disables.
        logError(`hook ${event} failed`, e);
        process.stdout.write('{}');
    }
}

async function handle(event: string, input: HookInput, args: HookArgs): Promise<HookOutput> {
    const db = openStore();
    const agent = resolveAgent(input, args.agent);
    const cwd = input.cwd ?? process.cwd();
    const workspace = ensureWorkspace(db, cwd);
    const branch = currentBranch(workspace.root);
    const session = upsertSession(db, {
        agent,
        harness_session_id: input.session_id ?? `unknown-${Date.now()}`,
        workspace_id: workspace.id,
        cwd,
        git_branch: branch,
        transcript_path: input.transcript_path ?? null,
        model: modelName(input.model),
        title: input.session_title ?? null,
        source: input.source ?? null,
    });

    switch (event) {
        case 'SessionStart':
            return onSessionStart(db, input, args, workspace, session, branch);
        case 'UserPromptSubmit':
            return onUserPrompt(db, input, args, workspace, session, branch);
        case 'Stop':
        case 'SubagentStop':
            return onStop(db, input, workspace, session, event);
        case 'PreCompact':
        case 'PostCompact':
            return onCompact(db, input, workspace, session, branch, event);
        case 'SessionEnd':
            return onSessionEnd(db, input, args, workspace, session);
        case 'PostToolUse':
            return onToolUse(db, input, workspace, session);
        default:
            appendEvent(db, {
                session_id: session.id,
                workspace_id: workspace.id,
                kind: 'note',
                payload: { event, source: input.source ?? null },
            });
            return {};
    }
}

/* --------------------------------------------------------------- handlers */

/**
 * The moment that justifies the whole system: a fresh context window, about to
 * start from zero on a codebase it has worked in before.
 */
function onSessionStart(
    db: DB,
    input: HookInput,
    args: HookArgs,
    workspace: Workspace,
    session: Session,
    branch: string | null,
): HookOutput {
    appendEvent(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        kind: 'session_start',
        payload: { source: input.source ?? null, model: modelName(input.model), branch },
    });

    // Maintenance rides along on a moment the user is already waiting through,
    // rather than needing a daemon. Both calls are internally rate-limited.
    decay(db);
    if (!args.noBackground) spawnBackground(['distill', '--pending', '--quiet']);

    const brief = buildBrief(db, {
        workspace_id: workspace.id,
        branch,
        budgetTokens: args.budget ?? defaultBudget(input.source),
        reason: input.source ? `session ${input.source}` : 'session start',
        workspaceName: workspace.name,
    });

    if (!brief.text) return {};

    touchItems(db, brief.item_ids);
    recordBrief(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        reason: `SessionStart:${input.source ?? 'startup'}`,
        item_ids: brief.item_ids,
        tokens: brief.tokens,
        text: brief.text,
    });

    return {
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: brief.text,
        },
        systemMessage: `xscs recalled ${brief.item_ids.length} items (~${brief.tokens} tokens) for ${workspace.name}.`,
    };
}

/**
 * Prompt-time top-up. A session-start brief is necessarily generic; the moment
 * the user states an actual task, we know what to look for. This is kept
 * deliberately stingy — at most a few injections per session, never repeating an
 * item already shown — because a store that interrupts every prompt trains the
 * user to turn it off.
 */
function onUserPrompt(
    db: DB,
    input: HookInput,
    args: HookArgs,
    workspace: Workspace,
    session: Session,
    branch: string | null,
): HookOutput {
    const prompt = input.prompt ?? '';
    appendEvent(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        kind: 'prompt',
        payload: { prompt: prompt.slice(0, 8000), source: input.source ?? null },
    });
    bumpSessionCounter(db, session.id, 'prompt_count');

    if (args.noTopup || prompt.trim().length < 12) return {};

    const already = alreadyInjected(db, session.id);
    if (already.topups >= MAX_TOPUPS_PER_SESSION) return {};

    const candidates = searchItems(db, prompt, { workspace_id: workspace.id, limit: 12 })
        .filter((h) => !already.ids.has(h.item.id))
        .filter((h) => h.relevance > 0.55)
        .filter((h) => h.item.scope !== 'branch' || h.item.scope_key === branch)
        .slice(0, 4);

    if (!candidates.length) return {};

    // Top-ups are a second injection path and need their own ceiling, or a few
    // long items land in the window without ever passing through the recall
    // budget. A quarter of the session budget is deliberately stingy.
    const topupBudget = Math.max(120, Math.floor((args.budget ?? 1200) / 4));
    const header = [
        '## Related stored context',
        '_Retrieved by xscs because it matches this request. Prior conclusions — verify before relying on them._',
    ];
    const lines = [...header];
    const hits: typeof candidates = [];
    let used = estimateTokens(header.join('\n'));

    for (const hit of candidates) {
        const rendered = `- **${hit.item.title}** (\`${hit.item.id}\`)\n  - ${truncateToTokens(hit.item.body, 90)}`;
        const cost = estimateTokens(rendered);
        if (used + cost > topupBudget) break;
        lines.push(rendered);
        hits.push(hit);
        used += cost;
    }

    if (!hits.length) return {};
    const text = lines.join('\n');

    touchItems(db, hits.map((h) => h.item.id));
    recordBrief(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        reason: 'UserPromptSubmit:topup',
        item_ids: hits.map((h) => h.item.id),
        tokens: estimateTokens(text),
        text,
    });

    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

/** Turn-level checkpoint: the cheapest possible record that progress happened. */
function onStop(db: DB, input: HookInput, workspace: Workspace, session: Session, event: string): HookOutput {
    const message = input.last_assistant_message ?? '';
    appendEvent(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        kind: 'turn',
        payload: {
            event,
            last_assistant_message: message.slice(0, 6000),
            tool_calls: summariseToolCalls(input.tool_calls),
        },
    });
    if (event === 'Stop') bumpSessionCounter(db, session.id, 'turn_count');
    return {};
}

/**
 * Compaction is the highest-value capture point in a long session: everything
 * about to be summarised away is still on disk in the transcript, and after this
 * point it is gone. Writing the handoff file here means a hard context reset has
 * something concrete to rebuild from.
 */
function onCompact(
    db: DB,
    input: HookInput,
    workspace: Workspace,
    session: Session,
    branch: string | null,
    event: string,
): HookOutput {
    appendEvent(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        kind: 'compact',
        payload: { event, trigger: input.trigger ?? input.source ?? null },
    });
    try {
        renderHandoff(db, workspace, { branch, write: true });
    } catch (e) {
        logError('handoff write failed', e);
    }
    return {};
}

/**
 * SessionEnd runs on a knife-edge budget — Codex allows one second by default and
 * three at most — so this does nothing but record the ending and hand the real
 * work to a detached process.
 */
function onSessionEnd(
    db: DB,
    input: HookInput,
    args: HookArgs,
    workspace: Workspace,
    session: Session,
): HookOutput {
    const reason = input.reason ?? input.source ?? 'other';
    appendEvent(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        kind: 'session_end',
        payload: { reason },
    });
    endSession(db, session.id, reason);
    if (!args.noBackground) spawnBackground(['distill', '--session', session.id, '--handoff', '--quiet']);
    return {};
}

function onToolUse(db: DB, input: HookInput, workspace: Workspace, session: Session): HookOutput {
    appendEvent(db, {
        session_id: session.id,
        workspace_id: workspace.id,
        kind: 'tool',
        payload: { tool_name: input.tool_name ?? null, tool_input: truncateUnknown(input.tool_input, 1200) },
    });
    return {};
}

/* ----------------------------------------------------------------- helpers */

function defaultBudget(source: string | null | undefined): number {
    // After a compaction the window was just emptied, so a larger brief is both
    // affordable and more valuable than at cold startup.
    if (source === 'compact') return 1800;
    if (source === 'resume' || source === 'fork') return 900;
    return 1200;
}

function alreadyInjected(db: DB, session_id: string): { ids: Set<string>; topups: number } {
    const rows = db
        .query<{ item_ids: string; reason: string }, [string]>('SELECT item_ids, reason FROM briefs WHERE session_id = ?')
        .all(session_id);
    const ids = new Set<string>();
    let topups = 0;
    for (const row of rows) {
        if (row.reason.startsWith('UserPromptSubmit')) topups++;
        try {
            const parsed: unknown = JSON.parse(row.item_ids);
            if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') ids.add(id);
        } catch {
            /* ignore */
        }
    }
    return { ids, topups };
}

export function resolveAgent(input: HookInput, explicit?: AgentKind): AgentKind {
    if (explicit) return explicit;
    return recognizeHarness(input)?.kind ?? 'other';
}

function modelName(model: HookInput['model']): string | null {
    if (typeof model === 'string') return model;
    if (model && typeof model === 'object' && typeof model.id === 'string') return model.id;
    return null;
}

function summariseToolCalls(calls: unknown[] | null | undefined): string[] {
    if (!Array.isArray(calls)) return [];
    const out: string[] = [];
    for (const call of calls.slice(0, 40)) {
        if (call && typeof call === 'object') {
            const name = (call as { tool_name?: unknown; name?: unknown }).tool_name ?? (call as { name?: unknown }).name;
            if (typeof name === 'string') out.push(name);
        }
    }
    return out;
}

function truncateUnknown(value: unknown, max: number): string {
    try {
        const s = typeof value === 'string' ? value : JSON.stringify(value);
        return (s ?? '').slice(0, max);
    } catch {
        return '';
    }
}

/**
 * Fire-and-forget child. `unref` plus ignored stdio is what lets SessionEnd return
 * inside its one-second budget while distillation continues after the harness
 * has moved on.
 */
export function spawnBackground(argv: string[]): void {
    try {
        const processes = processPlatform();
        processes.spawnDetached({
            command: processes.selfCommand(argv),
            env: { ...process.env, XSCS_BACKGROUND: '1' },
        });
    } catch (e) {
        logError('background spawn failed', e);
    }
}

export function logError(message: string, detail?: unknown): void {
    try {
        mkdirSync(dirname(logPath()), { recursive: true });
        const line = `${new Date().toISOString()} ${message} ${detail instanceof Error ? detail.stack : JSON.stringify(detail ?? null)}\n`;
        appendFileSync(logPath(), line, 'utf8');
    } catch {
        /* logging must never be the thing that fails */
    }
}
