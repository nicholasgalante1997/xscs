import type { DB } from '../db';
import type { ItemDraft, Session } from '../schema';
import {
    claimSessionForDistill,
    listItems,
    markDistilled,
    markEventsConsumed,
    pendingDistillSessions,
    putItem,
    releaseDistillClaim,
    sessionEvents,
} from '../store';
import { parseTranscript, summariseForDistill } from '../transcript';
import { type DistillerBackend, distillWithAgent } from './agent';
import { distillHeuristically } from './heuristic';

export * from './agent';
export * from './heuristic';

export interface DistillOptions {
    /** `heuristic` never leaves the process; `agent` additionally calls an LLM. */
    mode?: 'heuristic' | 'agent' | 'both';
    backend?: DistillerBackend;
    model?: string | null;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface DistillReport {
    session_id: string;
    created: number;
    reinforced: number;
    proposed: number;
    drafts: ItemDraft[];
    backend?: DistillerBackend;
    error?: string;
    /** True when another process already held the distillation lease. */
    skipped?: boolean;
}

const EMPTY_REPORT = (session_id: string): DistillReport => ({
    session_id,
    created: 0,
    reinforced: 0,
    proposed: 0,
    drafts: [],
    skipped: true,
});

/**
 * Turn one finished session into durable items.
 *
 * Runs *out of band*, never inside a hook. Hooks have hundred-millisecond budgets
 * (Codex allows SessionEnd at most three seconds); an LLM call there would either
 * be killed mid-flight or stall the user's terminal. The event log exists
 * precisely so that capture and interpretation can be separated in time.
 */
export async function distillSession(db: DB, session: Session, opts: DistillOptions = {}): Promise<DistillReport> {
    const mode = opts.mode ?? 'heuristic';

    // Both SessionEnd and the following SessionStart kick a background distiller,
    // so two processes routinely reach the same session. The lease makes the
    // second one a no-op instead of a duplicate write.
    if (!opts.dryRun && !claimSessionForDistill(db, session.id)) return EMPTY_REPORT(session.id);

    try {
        return await runDistillation(db, session, opts, mode);
    } catch (e) {
        // Hand the session back so a later run can retry it.
        if (!opts.dryRun) releaseDistillClaim(db, session.id);
        throw e;
    }
}

async function runDistillation(
    db: DB,
    session: Session,
    opts: DistillOptions,
    mode: 'heuristic' | 'agent' | 'both',
): Promise<DistillReport> {
    const events = sessionEvents(db, session.id);

    const prompts: string[] = [];
    const assistantMessages: string[] = [];
    for (const event of events) {
        const payload = event.payload as Record<string, unknown> | null;
        if (!payload) continue;
        if (event.kind === 'prompt' && typeof payload.prompt === 'string') prompts.push(payload.prompt);
        if (event.kind === 'turn' && typeof payload.last_assistant_message === 'string') {
            assistantMessages.push(payload.last_assistant_message);
        }
    }

    const transcript = session.transcript_path ? parseTranscript(session.transcript_path, session.agent) : null;
    if (transcript) {
        for (const entry of transcript.entries) {
            if (entry.role === 'assistant') assistantMessages.push(entry.text);
        }
    }

    const drafts: ItemDraft[] = [];
    let backend: DistillerBackend | undefined;
    let error: string | undefined;

    if (mode === 'heuristic' || mode === 'both') {
        drafts.push(
            ...distillHeuristically({
                transcript,
                prompts,
                assistantMessages: dedupeStrings(assistantMessages),
                branch: session.git_branch,
            }),
        );
    }

    if (mode === 'agent' || mode === 'both') {
        const material = transcript
            ? summariseForDistill(transcript)
            : renderEventMaterial(prompts, dedupeStrings(assistantMessages));
        if (material.trim().length > 80) {
            const known = listItems(db, { workspace_id: session.workspace_id, status: 'active', limit: 80 }).map(
                (i) => i.title,
            );
            const out = await distillWithAgent({
                material,
                workspaceName: session.workspace_id,
                branch: session.git_branch,
                backend: opts.backend,
                model: opts.model,
                timeoutMs: opts.timeoutMs,
                known,
            });
            backend = out.backend;
            if (!out.ok) error = out.error;
            drafts.push(...out.drafts);
        }
    }

    if (opts.dryRun) {
        return {
            session_id: session.id,
            created: 0,
            reinforced: 0,
            proposed: drafts.filter((d) => d.status === 'proposed').length,
            drafts,
            backend,
            error,
        };
    }

    let created = 0;
    let reinforced = 0;
    for (const draft of drafts) {
        const res = putItem(db, {
            ...draft,
            workspace_id: session.workspace_id,
            origin_session_id: session.id,
            origin_agent: session.agent,
        });
        if (res.created) created++;
        if (res.reinforced) reinforced++;
    }

    markEventsConsumed(db, session.id);
    markDistilled(db, session.id);

    return {
        session_id: session.id,
        created,
        reinforced,
        proposed: drafts.filter((d) => d.status === 'proposed').length,
        drafts,
        backend,
        error,
    };
}

export async function distillPending(db: DB, opts: DistillOptions & { limit?: number; idleMs?: number } = {}): Promise<DistillReport[]> {
    const sessions = pendingDistillSessions(db, opts.idleMs ?? 5 * 60_000, opts.limit ?? 10);
    const reports: DistillReport[] = [];
    for (const session of sessions) {
        reports.push(await distillSession(db, session, opts));
    }
    return reports;
}

function dedupeStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        const key = v.slice(0, 120);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}

/** Fallback material when the harness transcript is unreadable or absent. */
function renderEventMaterial(prompts: string[], assistantMessages: string[]): string {
    const parts: string[] = ['## User turns'];
    for (const p of prompts.slice(0, 40)) parts.push(`- ${p.slice(0, 600)}`);
    parts.push('\n## Assistant turn endings');
    for (const a of assistantMessages.slice(-12)) parts.push(`- ${a.slice(0, 800)}`);
    return parts.join('\n');
}
