import { z } from 'zod';

/**
 * First-class harness identities. `other` remains available so an SDK agent or
 * CI runner can write to the same store without inventing a supported harness.
 */
export const AgentKind = z.enum(['claude', 'codex', 'kiro', 'other']);
export type AgentKind = z.infer<typeof AgentKind>;

/**
 * Memory taxonomy. Deliberately small and *decision-oriented* rather than the
 * cognitive-science taxonomy (episodic/semantic/procedural) — a coding agent
 * resuming work needs to know what was decided, what it must not do, and what is
 * still open. Episodic detail stays in the event log and is not injected.
 */
export const ItemType = z.enum([
    'decision', // "we chose bun:sqlite over better-sqlite3 because ..."
    'constraint', // "never write to ~/.claude/settings.json without a backup"
    'preference', // "user prefers named exports and no default exports"
    'fact', // "the auth service lives in packages/api/src/auth"
    'artifact', // a file/PR/branch produced or owned by past work
    'open_thread', // unfinished work with a concrete next action
    'pitfall', // "bun test --watch hangs when preload throws"
    'glossary', // project vocabulary
]);
export type ItemType = z.infer<typeof ItemType>;

/**
 * Scope is the primary defence against memory drift: a lesson learned in one
 * atypical session must not silently become a global rule. Items are born at the
 * narrowest plausible scope and only widen through explicit promotion.
 */
export const ItemScope = z.enum(['global', 'workspace', 'branch', 'session']);
export type ItemScope = z.infer<typeof ItemScope>;

export const ItemStatus = z.enum(['active', 'superseded', 'archived', 'rejected', 'proposed']);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const EventKind = z.enum([
    'session_start',
    'session_end',
    'prompt',
    'turn',
    'tool',
    'compact',
    'checkpoint',
    'note',
    'brief',
]);
export type EventKind = z.infer<typeof EventKind>;

export const Workspace = z.object({
    id: z.string(),
    root: z.string(),
    name: z.string(),
    created_at: z.number(),
});
export type Workspace = z.infer<typeof Workspace>;

export const Session = z.object({
    id: z.string(),
    agent: AgentKind,
    harness_session_id: z.string(),
    workspace_id: z.string(),
    cwd: z.string(),
    git_branch: z.string().nullable(),
    transcript_path: z.string().nullable(),
    model: z.string().nullable(),
    title: z.string().nullable(),
    source: z.string().nullable(),
    parent_session_id: z.string().nullable(),
    started_at: z.number(),
    ended_at: z.number().nullable(),
    end_reason: z.string().nullable(),
    distilled_at: z.number().nullable(),
    prompt_count: z.number(),
    turn_count: z.number(),
});
export type Session = z.infer<typeof Session>;

export const Event = z.object({
    id: z.number(),
    session_id: z.string(),
    workspace_id: z.string(),
    ts: z.number(),
    kind: EventKind,
    payload: z.unknown(),
    consumed_at: z.number().nullable(),
});
export type Event = z.infer<typeof Event>;

export const Item = z.object({
    id: z.string(),
    workspace_id: z.string().nullable(),
    scope: ItemScope,
    scope_key: z.string().nullable(),
    type: ItemType,
    title: z.string(),
    body: z.string(),
    why: z.string().nullable(),
    status: ItemStatus,
    confidence: z.number(),
    pinned: z.boolean(),
    source: z.string(),
    origin_session_id: z.string().nullable(),
    origin_agent: AgentKind.nullable(),
    supersedes: z.string().nullable(),
    content_hash: z.string(),
    tags: z.array(z.string()),
    created_at: z.number(),
    updated_at: z.number(),
    last_used_at: z.number().nullable(),
    use_count: z.number(),
});
export type Item = z.infer<typeof Item>;

/**
 * The write contract. Everything that creates memory — hooks, the heuristic
 * distiller, the LLM distiller, the MCP `remember` tool, the dashboard — funnels
 * through this shape so provenance and scoping are never optional.
 */
export const ItemDraft = z.object({
    type: ItemType,
    title: z.string().min(3).max(200),
    body: z.string().min(1).max(4000),
    why: z.string().max(2000).nullish(),
    scope: ItemScope.default('workspace'),
    scope_key: z.string().nullish(),
    /** Ignored when `scope` is `global` — global items belong to no workspace. */
    workspace_id: z.string().nullish(),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
    pinned: z.boolean().default(false),
    status: ItemStatus.default('active'),
    source: z.string().default('manual'),
    origin_session_id: z.string().nullish(),
    origin_agent: AgentKind.nullish(),
    supersedes: z.string().nullish(),
});
export type ItemDraft = z.input<typeof ItemDraft>;
export type ItemDraftParsed = z.infer<typeof ItemDraft>;

/** What an LLM distiller is required to return. Kept flat so small models comply. */
export const DistillResult = z.object({
    items: z.array(
        z.object({
            type: ItemType,
            title: z.string(),
            body: z.string(),
            why: z.string().nullish(),
            scope: ItemScope.nullish(),
            tags: z.array(z.string()).nullish(),
            confidence: z.number().nullish(),
        }),
    ),
});
export type DistillResult = z.infer<typeof DistillResult>;

/**
 * Normalised hook payload. Claude Code and Codex ship near-identical hook
 * contracts (same field names, same stdin/stdout JSON discipline), which is what
 * makes a single bridge binary possible; the few divergences are absorbed here.
 */
export const HookInput = z
    .object({
        // Optional: the installed bridge passes `--event`, which is authoritative.
        // Requiring the field here would make a payload that omits it fail the
        // parse and silently drop the event.
        hook_event_name: z.string().nullish(),
        session_id: z.string().nullish(),
        transcript_path: z.string().nullish(),
        cwd: z.string().nullish(),
        model: z.union([z.string(), z.object({ id: z.string().nullish() }).passthrough()]).nullish(),
        permission_mode: z.string().nullish(),
        turn_id: z.string().nullish(),
        source: z.string().nullish(),
        trigger: z.string().nullish(),
        reason: z.string().nullish(),
        prompt: z.string().nullish(),
        session_title: z.string().nullish(),
        last_assistant_message: z.string().nullish(),
        tool_name: z.string().nullish(),
        tool_input: z.unknown().nullish(),
        tool_output: z.unknown().nullish(),
        tool_response: z.unknown().nullish(),
        tool_calls: z.array(z.unknown()).nullish(),
    })
    .passthrough();
export type HookInput = z.infer<typeof HookInput>;

export const BriefOptions = z.object({
    workspace_id: z.string().nullish(),
    branch: z.string().nullish(),
    query: z.string().nullish(),
    budget_tokens: z.number().default(1200),
    include_open_threads: z.boolean().default(true),
    agent: AgentKind.nullish(),
});
export type BriefOptions = z.input<typeof BriefOptions>;
